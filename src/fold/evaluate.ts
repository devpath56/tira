// The single legality function. The write path calls it before append; the fold
// calls it again on replay. One function, so "what the writer allowed" and "what
// the fold accepts" cannot drift apart.
import { step, type StepOutcome } from "../tables/table.ts";
import type { EntityTypeDef, Registry, TreeConfig } from "../tables/registry.ts";
import { entityKey, type EntityRef, type EntityState, type StateView, type TreeInfo } from "./types.ts";
import { activeNodes, allChildrenTerminal, children, isTerminal } from "./tree.ts";
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
  | "gate";

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
    }
  | { ok: false; code: RejectCode; detail: string };

type Reject = Extract<Evaluation, { ok: false }>;
const reject = (code: RejectCode, detail: string): Reject => ({ ok: false, code, detail });

export function evaluate(
  registry: Registry,
  entities: ReadonlyMap<string, EntityState>,
  view: StateView,
  intent: Intent,
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

  if (intent.kind === "create") {
    if (current) return reject("already-exists", key);
    const regions = registry.initialRegions(def);
    if (!def.tree) {
      if (intent.payload.parent_id !== undefined) return reject("unknown-parent", `${def.type} has no tree; parent_id is not allowed`);
      return { ok: true, outcome: "created", key, regions };
    }
    const birth = evaluateBirth(registry, def, def.tree, intent, view);
    if ("ok" in birth) return birth;
    return { ok: true, outcome: "created", key, regions, tree: birth };
  }

  if (!current) return reject("unknown-entity", key);
  const hit = registry.resolve(def.type, intent.event);
  if (!hit) return reject("unknown-event", `${def.type}.${intent.event}`);
  const from = current.regions[hit.region] as string;
  const res = step(hit.table, from, intent.event, registry.guards, {
    payload: intent.payload,
    actor: intent.actor,
    entity: current,
    view,
  });
  if (res.outcome === "denied") return reject("denied", `${hit.table.id}: ${from} + ${intent.event}`);
  if (res.outcome === "guard-failed") {
    return reject("guard-failed", `${hit.table.id}: ${from} + ${intent.event} needs ${res.guard}`);
  }
  const regions = { ...current.regions, [hit.region]: res.to };
  if (res.outcome === "transition" && def.tree && hit.region === def.tree.region) {
    const gate = treeGate(def, def.tree, current, intent.event, regions, entities, view);
    if (gate !== undefined) return reject("gate", gate);
  }
  return { ok: true, outcome: res.outcome, key, region: hit.region, from, regions };
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
): string | undefined {
  if (t.completeEvent !== undefined && event === t.completeEvent && !allChildrenTerminal(t, current, view)) {
    const open = children(current, view).filter((c) => !isTerminal(t, c)).map((c) => c.key);
    return `subtree not drained: ${current.key} has open children ${open.join(", ")}`;
  }
  if (t.oneActive) {
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
