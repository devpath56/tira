// The single legality function. The write path calls it before append; the fold
// calls it again on replay. One function, so "what the writer allowed" and "what
// the fold accepts" cannot drift apart.
import { applyCapture, step, type StepOutcome } from "../tables/table.ts";
import type { EntityTypeDef, Registry, TreeConfig } from "../tables/registry.ts";
import { entityKey, type EntityRef, type EntityState, type StateView, type TreeInfo } from "./types.ts";
import { activeNodes, allChildrenTerminal, children, isDrained, isTerminal } from "./tree.ts";
import { overlayView } from "./view.ts";

export type RejectCode =
  | "unknown-entity-type"
  | "version-required"
  | "version-forbidden"
  | "already-exists"
  | "unknown-entity"
  | "unknown-event"
  | "denied"
  | "guard-failed"
  | "unknown-parent"
  | "tree-cap"
  | "bad-provenance"
  | "gate"
  | "reserved-actor"
  | "superseded"
  | "bad-version"
  | "handoff-refused";

export type Intent =
  | { kind: "create"; entity: EntityRef; payload: Record<string, unknown>; actor: string | undefined }
  | { kind: "event"; entity: EntityRef; event: string; payload: Record<string, unknown>; actor: string | undefined };

export type Evaluation =
  | {
      ok: true;
      outcome: Exclude<StepOutcome, "denied" | "guard-failed"> | "created";
      key: string;
      region?: string;
      from?: string;
      regions: Record<string, string>; // next region states
      tree?: TreeInfo; // for a birth into a tree type
      context?: Record<string, Record<string, unknown>>; // next captured data (C3), when any
    }
  | { ok: false; code: RejectCode; detail: string };

type Reject = Extract<Evaluation, { ok: false }>;

export interface EvaluateOptions {
  // tira closes an unstarted parent with START + COMPLETE back to back (decided with Isha
  // 2026-10-18): one close written as two events. For that START the one-active rule is
  // judged on the pair's end state — the parent is done again one event later — so it is
  // not checked here. Every other gate still applies, and only a finished (drained)
  // parent qualifies. The write path sets this only for its own paired START; the fold
  // sets it only after checking the pair in the log, including that the COMPLETE lands.
  pairedClose?: boolean;
}
const reject = (code: RejectCode, detail: string): Reject => ({ ok: false, code, detail });

export function evaluate(
  registry: Registry,
  entities: ReadonlyMap<string, EntityState>,
  view: StateView,
  intent: Intent,
  opts: EvaluateOptions = {},
): Evaluation {
  const def = registry.get(intent.entity.type);
  if (!def) return reject("unknown-entity-type", intent.entity.type);
  if (def.versioned && intent.entity.version === undefined) {
    return reject("version-required", `${def.type} is versioned`);
  }
  if (!def.versioned && intent.entity.version !== undefined) {
    return reject("version-forbidden", `${def.type} is not versioned`);
  }
  const key = entityKey(intent.entity);
  const current = entities.get(key);
  // A14 for types whose versions follow another type's (drop follows brief).
  const owner = def.followsVersionsOf;
  if (owner !== undefined && intent.entity.version !== undefined && view.get({ type: owner, id: intent.entity.id, version: intent.entity.version + 1 })) {
    return reject("superseded", `${key} belongs to ${owner}:${intent.entity.id}@${intent.entity.version}, which was superseded`);
  }

  if (intent.kind === "create") {
    if (current) return reject("already-exists", key);
    const regions = registry.initialRegions(def);
    // C5: a revision needs the version it supersedes (and names it, if it says).
    const v = intent.entity.version;
    if (def.revisedAs !== undefined && v !== undefined && v > 1) {
      if (!view.get({ type: def.type, id: intent.entity.id, version: v - 1 })) {
        return reject("bad-version", `${key} needs ${def.type}:${intent.entity.id}@${v - 1} first`);
      }
      if (intent.payload.supersedes !== undefined && Number(intent.payload.supersedes) !== v - 1) {
        return reject("bad-version", `${key} can only supersede version ${v - 1} (got supersedes=${String(intent.payload.supersedes)})`);
      }
    }
    // C2: guards on create.
    if (def.createGuard !== undefined) {
      const born: EntityState = { stream: "", type: def.type, id: intent.entity.id, ...(v === undefined ? {} : { version: v }), key, regions, createdSeq: 0, lastSeq: 0, lastRecordedAt: "" };
      const impl = registry.guards[def.createGuard];
      if (!impl?.({ payload: intent.payload, actor: intent.actor, entity: born, view, own: {} })) {
        return reject("guard-failed", `${def.type} birth needs ${def.createGuard}`);
      }
    }
    if (!def.tree) {
      if (intent.payload.parent_id !== undefined) return reject("unknown-parent", `${def.type} has no tree; parent_id is not allowed`);
      return { ok: true, outcome: "created", key, regions };
    }
    const birth = evaluateBirth(registry, def, def.tree, intent, view);
    if ("ok" in birth) return birth;
    return { ok: true, outcome: "created", key, regions, tree: birth };
  }

  if (!current) return reject("unknown-entity", key);
  // C5/A14: once a newer version exists, the old one takes no more events.
  if (def.revisedAs !== undefined && current.version !== undefined && view.get({ type: def.type, id: current.id, version: current.version + 1 })) {
    return reject("superseded", `${key} was superseded by version ${current.version + 1}`);
  }
  const hit = registry.resolve(def.type, intent.event);
  if (!hit) return reject("unknown-event", `${def.type}.${intent.event}`);
  const from = current.regions[hit.region] as string;
  const own = current.context?.[hit.region] ?? {};
  const res = step(hit.table, from, intent.event, registry.guards, {
    payload: intent.payload,
    actor: intent.actor,
    entity: current,
    view,
    own,
  });
  if (res.outcome === "denied") return reject("denied", `${hit.table.id}: ${from} + ${intent.event}`);
  if (res.outcome === "guard-failed") {
    return reject("guard-failed", `${hit.table.id}: ${from} + ${intent.event} needs ${res.guard}`);
  }
  const regions = { ...current.regions, [hit.region]: res.to };
  if (res.outcome === "transition" && def.tree && hit.region === def.tree.region) {
    const gate = treeGate(def, def.tree, current, intent.event, regions, entities, view, opts.pairedClose === true);
    if (gate !== undefined) return reject("gate", gate);
  }
  const captured = applyCapture(current.context?.[hit.region], res.capture, intent.payload);
  const context = { ...(current.context ?? {}) };
  if (captured === undefined) delete context[hit.region];
  else context[hit.region] = captured;
  return { ok: true, outcome: res.outcome, key, region: hit.region, from, regions, ...(Object.keys(context).length > 0 ? { context } : {}) };
}

// Birth into a tree: provenance, parent, the parent's own table, caps.
function evaluateBirth(
  registry: Registry,
  def: EntityTypeDef,
  t: TreeConfig,
  intent: Extract<Intent, { kind: "create" }>,
  view: StateView,
): TreeInfo | Reject {
  const p = intent.payload;
  const kind = p.kind === undefined ? "planned" : p.kind;
  if (kind !== "planned" && kind !== "discovered") return reject("bad-provenance", `kind must be planned or discovered, got ${String(kind)}`);
  // Functional requirements: discovered work is "tagged with who found them".
  if (kind === "discovered" && intent.actor === undefined) return reject("bad-provenance", "discovered work must name who found it (actor)");
  let discoveredDuring: string | undefined;
  if (p.discovered_during !== undefined) {
    const during = typeof p.discovered_during === "string" ? view.get({ type: def.type, id: p.discovered_during }) : undefined;
    if (!during) return reject("bad-provenance", `discovered_during ${String(p.discovered_during)} is not a ${def.type} in this stream`);
    discoveredDuring = during.key;
  }
  if (kind === "discovered" && discoveredDuring === undefined) {
    return reject("bad-provenance", "discovered work must name discovered_during");
  }
  const provenance = { kind, ...(discoveredDuring === undefined ? {} : { discoveredDuring }) } as const;
  if (p.parent_id === undefined) return { children: [], depth: 1, ...provenance };

  const parent = typeof p.parent_id === "string" && p.parent_id ? view.get({ type: def.type, id: p.parent_id }) : undefined;
  if (!parent?.tree) return reject("unknown-parent", `${def.type}:${String(p.parent_id)} is not in this stream`);
  // The parent's own table decides whether it can take a child: done and cancelled
  // deny ADD_CHILD (ruling 4: re-open first, with a reason).
  const table = def.regions[t.region];
  const parentState = parent.regions[t.region] as string;
  const res = table
    ? step(table, parentState, t.childEvent, registry.guards, { payload: p, actor: intent.actor, entity: parent, view })
    : { outcome: "denied" as const };
  if (res.outcome === "denied" || res.outcome === "guard-failed") {
    return reject("denied", `${table?.id}: ${parentState} + ${t.childEvent} (re-open ${parent.key} first)`);
  }
  const depth = parent.tree.depth + 1;
  if (depth > t.maxDepth) return reject("tree-cap", `depth ${depth} exceeds the cap of ${t.maxDepth}`);
  if (parent.tree.children.length >= t.maxChildren) {
    return reject("tree-cap", `${parent.key} already has ${t.maxChildren} children (the cap)`);
  }
  return { parent: parent.key, children: [], depth, ...provenance };
}

// Same-lifecycle write gates (rulings A2, A4). Returns a reason to reject, or undefined.
function treeGate(
  def: EntityTypeDef,
  t: TreeConfig,
  current: EntityState,
  event: string,
  regions: Record<string, string>,
  entities: ReadonlyMap<string, EntityState>,
  view: StateView,
  pairedClose: boolean,
): string | undefined {
  const closing = event === t.completeEvent || event === t.cancelEvent;
  if (closing && !allChildrenTerminal(t, current, view)) {
    const open = children(current, view).filter((c) => !isTerminal(t, c)).map((c) => c.key);
    return event === t.completeEvent
      ? `subtree not drained: ${current.key} has open children ${open.join(", ")}`
      : `can't cancel ${current.key} while children are open: ${open.join(", ")} (close them first)`;
  }
  // Ruling 2026-10-18: no re-opening a child under a closed parent — re-open the parent
  // first, with a reason, so the trail stays honest.
  const parentKey = current.tree?.parent;
  const leavesTerminal = t.terminal.includes(current.regions[t.region] as string) && !t.terminal.includes(regions[t.region] as string);
  if (leavesTerminal && parentKey !== undefined) {
    const parent = view.getKey(parentKey);
    if (parent && isTerminal(t, parent)) {
      return `re-open ${parent.key} first: ${current.key} sits under a closed parent (${parent.key} is ${parent.regions[t.region]}; only a done parent can be re-opened)`;
    }
  }
  if (t.oneActive && !(pairedClose && event === t.startEvent && isDrained(t, current, view))) {
    // Evaluated on the would-be tree, so every way into the active state is covered
    // (START, UNBLOCK, REOPEN), not just START.
    const before = activeNodes(t, def.type, view).length;
    const after = activeNodes(t, def.type, overlayView(entities, { ...current, regions }));
    if (after.length > Math.max(1, before)) {
      const others = after.filter((a) => a.key !== current.key).map((a) => a.key);
      return `one active task: ${others.join(", ")} is already active`;
    }
  }
  return undefined;
}
