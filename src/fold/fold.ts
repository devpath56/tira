// The fold: replay the log through the transition tables to derive all state.
// Nothing is stored as "current" — this function is authoritative.
//
// fold(log, N, now, vantage): `upToSeq` gives replay-to-N (time travel); `now` and
// `vantage` feed derived predicates only (b0-factory-mapping.md G6). Same inputs
// => byte-identical output (see canonicalJson). Works on one stream or on readAll():
// entities are namespaced by stream, so the same id in two trees never collides.
import type { StoredEvent } from "../store/types.ts";
import { LEGACY_ERA, type Registry } from "../tables/registry.ts";
import { show } from "../text.ts";
import { evaluate, type Evaluation, type Intent, type RejectCode } from "./evaluate.ts";
import { REJECTED, toIntent, type EventData, type RejectedData } from "./events.ts";
import { MACHINE_ACTOR, entityKey, type EntityState, type StateView } from "./types.ts";
import { activeNodes, awaitingClose, contains, cursor, isDrained, isTerminal, roots } from "./tree.ts";
import { compareCodeUnits, makeView } from "./view.ts";
import { blockRefusal, due, indexKey, pending as pendingHandoffs, type PendingHandoff, type TriggerIndex } from "./handoffs.ts";
import { DISPATCHER, ORCHESTRATOR, frontier } from "../tables/factory.ts";
import { LABEL, isLabelBirth, isOracle, labelProblem, summarize, type LabelSummary } from "./labels.ts";

export { compareCodeUnits, makeView } from "./view.ts";

export interface FoldOptions {
  upToSeq?: number;
  now?: string;
  vantage?: string;
  // Called with each event the fold applies, after it is judged and before its state is
  // set (`before` is the stream as it was): how the health sweep reads history in one
  // pass. Read-only; it changes nothing the fold returns.
  onApply?: (e: StoredEvent, intent: Intent, ev: Extract<Evaluation, { ok: true }>, before: StateView) => void;
}

export interface Rejection {
  seq: number;
  stream: string;
  eventId: string;
  code: RejectCode;
  detail: string;
  intent: RejectedData["intent"];
}

// A stored event the fold could not apply. Should never happen when every write
// goes through the write path; if it does, the log disagrees with the rules.
export interface Anomaly {
  seq: number;
  stream: string;
  eventId: string;
  type: string;
  problem: string;
}

// Per stream, per tree type: the derived shape of the tree.
export interface TreeSummary {
  roots: string[]; // in birth order
  cursor: string | null; // where the work is (tree.ts: leaf-scoped DFS)
  active: string[]; // in_progress with no in_progress descendant; the gate keeps this <= 1
}

export interface FoldResult {
  lastSeq: number; // highest seq folded (0 if none)
  entities: EntityState[]; // sorted by stream, then key
  derived: Record<string, Record<string, Record<string, unknown>>>; // stream -> key -> predicate -> value
  trees: Record<string, Record<string, TreeSummary>>; // stream -> type -> summary
  rejections: Rejection[];
  anomalies: Anomaly[];
  handoffs: Record<string, PendingHandoff[]>; // stream -> handoffs still waiting (proposal R3), when any
  frontier: Record<string, string[]>; // stream -> briefs claimable now (G9), for streams with briefs
  // stream -> outcome labels, derived at read time (fold/labels.ts), for streams with any label
  // event; absent when no stream has one, so a log without labels folds to the same bytes
  labels?: Record<string, LabelSummary>;
}

const isRejectedData = (d: unknown): d is RejectedData => {
  const r = d as RejectedData | undefined;
  return (
    !!r &&
    typeof r === "object" &&
    !!r.reason &&
    typeof r.reason.code === "string" &&
    typeof r.reason.detail === "string" &&
    !!r.intent &&
    typeof r.intent === "object"
  );
};

function isTiraPair(a: StoredEvent, b: StoredEvent, registry: Registry, creationNameOf: (t: string, v?: number) => string): boolean {
  if (a.metadata?.actor !== MACHINE_ACTOR || b.metadata?.actor !== MACHINE_ACTOR) return false;
  const ia = toIntent(a, creationNameOf);
  const ib = toIntent(b, creationNameOf);
  if (ia?.kind !== "event" || ib?.kind !== "event") return false;
  const t = registry.get(ia.entity.type)?.tree;
  const trigger = ia.payload.trigger;
  return (
    !!t?.machineCloses &&
    ia.event === t.startEvent &&
    ib.event === t.completeEvent &&
    entityKey(ia.entity) === entityKey(ib.entity) &&
    typeof trigger === "string" &&
    trigger === ib.payload.trigger
  );
}

// An event's rules era (versioned rules): what the write path stamped, or legacy if nothing.
export const eraOf = (e: StoredEvent): number => (e.metadata?.era === undefined ? LEGACY_ERA : (e.metadata.era as number));
const knownEra = (era: unknown, registry: Registry): boolean => Number.isInteger(era) && (era as number) >= LEGACY_ERA && (era as number) <= registry.era;

export function fold(events: readonly StoredEvent[], registry: Registry, opts: FoldOptions = {}): FoldResult {
  return foldDetailed(events, registry, opts).result;
}

// The fold plus its per-stream trigger index (handoffs.ts), for the dispatcher: it
// decides what is due from exactly the index the fold checks its writes against.
export function foldDetailed(
  events: readonly StoredEvent[],
  registry: Registry,
  opts: FoldOptions = {},
): { result: FoldResult; indexes: ReadonlyMap<string, TriggerIndex> } {
  const streams = new Map<string, Map<string, EntityState>>();
  const views = new Map<string, StateView>();
  const scope = (stream: string) => {
    let m = streams.get(stream);
    if (!m) {
      m = new Map();
      streams.set(stream, m);
      views.set(stream, makeView(m));
    }
    return { entities: m, view: views.get(stream) as StateView };
  };
  // The events that start handoffs, per stream (handoffs.ts), as of the event being folded.
  const indexes = new Map<string, TriggerIndex>();
  const indexOf = (stream: string) => {
    let m = indexes.get(stream);
    if (!m) indexes.set(stream, (m = new Map()));
    return m;
  };
  const rejections: Rejection[] = [];
  const anomalies: Anomaly[] = [];
  let lastSeq = 0;
  // Labels are judged on the log before them (labels.ts): every event seen, and those applied.
  const seenIds = new Map<string, Map<string, StoredEvent>>();
  const appliedIds = new Map<string, Map<string, StoredEvent>>();
  const idsOf = (m: Map<string, Map<string, StoredEvent>>, stream: string) => {
    let x = m.get(stream);
    if (!x) m.set(stream, (x = new Map()));
    return x;
  };
  const creationNameOf = (t: string, v?: number) => registry.creationName(t, v);

  // Replay check of tira's own writes (ruling 2026-10-18: "the machine writes, it never
  // infers"): every event tira applied must cite a move, and the very next non-tira event
  // in its stream must be that move — into the active state, outside the parent tira closed.
  const pending = new Map<string, { seq: number; eventId: string; type: string; trigger: string; key: string }[]>();
  // Who made each entity's latest real state change (a no-op re-send doesn't count), so
  // "closed by tira" survives someone clicking complete on an already-done parent.
  const movedBy = new Map<string, string | undefined>();
  const settle = (e: StoredEvent, ev: Evaluation | undefined) => {
    const ps = pending.get(e.stream);
    if (!ps?.length) return;
    pending.delete(e.stream);
    const { view } = scope(e.stream);
    const moved = ev?.ok ? view.getKey(ev.key) : undefined;
    const t = moved ? registry.get(moved.type)?.tree : undefined;
    const intoActive = !!(ev?.ok && t && ev.outcome === "transition" && ev.region === t.region && ev.regions[t.region] === t.active);
    for (const p of ps) {
      const parent = view.getKey(p.key);
      const ok = p.trigger === e.eventId && intoActive && moved !== undefined && parent !== undefined && !contains(parent, moved.key, view);
      if (!ok) {
        anomalies.push({
          seq: p.seq, stream: e.stream, eventId: p.eventId, type: p.type,
          problem: `tira's write cites move ${p.trigger}, but the next event (seq ${e.seq}) is not a move outside ${p.key}`,
        });
      }
    }
  };

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // tira's START of an unstarted parent is the first half of one close (EvaluateOptions):
  // it gets the paired treatment only when the very next event in its stream is tira's
  // COMPLETE of the same node, citing the same move.
  const pairedStarts = new Map<number, StoredEvent>(); // START seq -> its COMPLETE
  const prevInStream = new Map<string, StoredEvent>();
  for (const e of ordered) {
    const a = prevInStream.get(e.stream);
    if (a && isTiraPair(a, e, registry, creationNameOf)) pairedStarts.set(a.seq, e);
    prevInStream.set(e.stream, e);
  }
  // The pair only counts if its COMPLETE also lands on top of the START.
  const completes = (done: StoredEvent, entities: Map<string, EntityState>, ev: Extract<Evaluation, { ok: true }>) => {
    const after = new Map(entities);
    after.set(ev.key, { ...(entities.get(ev.key) as EntityState), regions: ev.regions });
    const ci = toIntent(done, creationNameOf);
    return ci !== undefined && evaluate(registry, after, makeView(after), ci, { era: eraOf(done) }).ok;
  };
  for (const e of ordered) {
    if (opts.upToSeq !== undefined && e.seq > opts.upToSeq) break;
    lastSeq = e.seq;
    const anomaly = (problem: string) =>
      anomalies.push({ seq: e.seq, stream: e.stream, eventId: e.eventId, type: e.type, problem });
    const byTira = e.metadata?.actor === MACHINE_ACTOR;
    idsOf(seenIds, e.stream).set(e.eventId, e);

    if (e.type === REJECTED) {
      if (!isRejectedData(e.data)) {
        anomaly("malformed command.rejected record");
        if (!byTira) settle(e, undefined);
        continue;
      }
      const d = e.data;
      rejections.push({
        seq: e.seq, stream: e.stream, eventId: e.eventId, code: d.reason.code, detail: d.reason.detail, intent: d.intent,
      });
      if (!byTira) settle(e, undefined);
      continue;
    }
    const intent = toIntent(e, creationNameOf);
    if (!intent) {
      anomaly("unrecognised event shape");
      if (!byTira) settle(e, undefined);
      continue;
    }
    // Outcome labels: an oracle writes labels only, and a label must stand on the log before it.
    if (isOracle(intent.actor) && !isLabelBirth(intent)) {
      anomaly(`${intent.actor} is an oracle: it writes labels and nothing else`);
      settle(e, undefined);
      continue;
    }
    if (isLabelBirth(intent)) {
      const seen = idsOf(seenIds, e.stream);
      const applied = idsOf(appliedIds, e.stream);
      const problem = labelProblem(intent, { seen: (id) => (id === e.eventId ? undefined : seen.get(id)), applied: (id) => applied.get(id) });
      if (problem) {
        anomaly(`${problem.self ? "self-label" : "bad-label"}: ${problem.detail}`);
        settle(e, undefined);
        continue;
      }
    }
    const { entities, view } = scope(e.stream);
    const idx = indexOf(e.stream);
    // Replay check of the dispatcher's writes: each must be a receiver the handoff
    // rules call for at this point (with its correlation id), or a block it relayed
    // for the orchestrator under the B1 conditions.
    if (e.metadata?.actor === DISPATCHER) {
      const k = entityKey(intent.entity);
      const called = intent.kind === "event" && intent.event === "BLOCKED" && intent.payload.requested_by !== undefined
        ? intent.payload.requested_by === ORCHESTRATOR && blockRefusal(view, view.getKey(k), ORCHESTRATOR, intent.payload.block_reason) === undefined
        : due(view, idx).some((r) => entityKey(r.target) === k && r.kind === intent.kind && (intent.kind === "create" || r.event === intent.event) && r.correlationId === e.metadata.correlationId);
      if (!called) anomaly(`the dispatcher wrote ${e.type} on ${k}, but no handoff rule called for it`);
    }
    // Versioned rules: each event is judged by the rules of the era it was written in.
    const era = eraOf(e);
    if (!knownEra(era, registry)) {
      anomaly(`written under rules era ${show(e.metadata?.era)}, which this build doesn't know (eras ${LEGACY_ERA} to ${registry.era})`);
      if (!byTira) settle(e, undefined);
      continue;
    }
    const paired = pairedStarts.get(e.seq);
    let ev = evaluate(registry, entities, view, intent, { pairedClose: paired !== undefined, era });
    if (ev.ok && paired && !completes(paired, entities, ev)) ev = evaluate(registry, entities, view, intent, { era });
    if (!ev.ok) {
      anomaly(`${ev.code}: ${ev.detail}`);
      if (!byTira) settle(e, undefined);
      continue;
    }
    opts.onApply?.(e, intent, ev, view);
    idsOf(appliedIds, e.stream).set(e.eventId, e);
    const prev = entities.get(ev.key);
    const createdBy = prev ? prev.createdBy : intent.actor;
    const tree = prev?.tree ?? ev.tree;
    entities.set(ev.key, {
      stream: e.stream,
      type: intent.entity.type,
      id: intent.entity.id,
      ...(intent.entity.version === undefined ? {} : { version: intent.entity.version }),
      key: ev.key,
      regions: ev.regions,
      createdSeq: prev?.createdSeq ?? e.seq,
      lastSeq: e.seq,
      lastRecordedAt: e.recordedAt,
      ...(createdBy === undefined ? {} : { createdBy }),
      ...(intent.actor === undefined ? {} : { lastActor: intent.actor }),
      ...(tree === undefined ? {} : { tree }),
      ...(ev.context === undefined ? {} : { context: ev.context }),
      ...(prev?.born !== undefined ? { born: prev.born } : !prev && registry.get(intent.entity.type)?.keepBirth ? { born: intent.payload } : {}),
    });
    idx.set(indexKey(ev.key, e.type), { eventId: e.eventId, seq: e.seq, payload: intent.payload });
    if (ev.outcome !== "noop") movedBy.set(`${e.stream}\u0000${ev.key}`, intent.actor);
    // A birth appends the child to its parent's list (append-at-end, ruling 1).
    if (!prev && ev.tree?.parent !== undefined) {
      const parent = entities.get(ev.tree.parent);
      if (parent?.tree) entities.set(parent.key, { ...parent, tree: { ...parent.tree, children: [...parent.tree.children, ev.key] } });
    }
    if (byTira) {
      // tira only ever opens and closes finished parents
      const t = registry.get(intent.entity.type)?.tree;
      const target = entities.get(ev.key);
      if (!t || !target || !isDrained(t, target, view)) anomaly(`tira wrote to ${ev.key}, which is not a finished parent`);
      const trigger = (e.data as unknown as EventData)?.payload?.trigger;
      if (typeof trigger === "string" && trigger.length > 0) {
        pending.set(e.stream, [...(pending.get(e.stream) ?? []), { seq: e.seq, eventId: e.eventId, type: e.type, trigger, key: ev.key }]);
      } else {
        anomaly("tira wrote this without citing a move");
      }
    } else {
      settle(e, ev);
    }
  }
  // tira's writes still waiting for their move: fine only when replay stopped mid-append.
  for (const [stream, ps] of pending) {
    const cut = opts.upToSeq !== undefined && ordered.some((x) => x.stream === stream && x.seq > (opts.upToSeq as number));
    if (cut) continue;
    for (const p of ps) {
      anomalies.push({ seq: p.seq, stream, eventId: p.eventId, type: p.type, problem: `tira's write cites move ${p.trigger}, but no move follows it` });
    }
  }

  const entities: EntityState[] = [];
  const derived: FoldResult["derived"] = {};
  const trees: FoldResult["trees"] = {};
  for (const stream of [...streams.keys()].sort(compareCodeUnits)) {
    const view = views.get(stream) as StateView;
    for (const ent of view.all()) {
      entities.push(ent);
      const def = registry.get(ent.type);
      const values: Record<string, unknown> = {};
      if (def?.tree) {
        values.drained = isDrained(def.tree, ent, view);
        values.awaitingClose = awaitingClose(def.tree, ent, view); // tira closes it on your next move elsewhere
        values.closedByTira = isTerminal(def.tree, ent) && movedBy.get(`${stream}\u0000${ent.key}`) === MACHINE_ACTOR;
      }
      for (const [name, fn] of Object.entries(def?.derived ?? {})) values[name] = fn(ent, { now: opts.now, vantage: opts.vantage, view });
      if (Object.keys(values).length > 0) (derived[stream] ??= {})[ent.key] = values;
    }
    for (const def of registry.types()) {
      if (!def.tree || view.all(def.type).length === 0) continue;
      (trees[stream] ??= {})[def.type] = {
        roots: roots(def.type, view).map((r) => r.key),
        cursor: cursor(def.tree, def.type, view)?.key ?? null,
        active: activeNodes(def.tree, def.type, view).map((a) => a.key),
      };
    }
  }
  const handoffs: FoldResult["handoffs"] = {};
  for (const stream of [...streams.keys()].sort(compareCodeUnits)) {
    const waiting = pendingHandoffs(views.get(stream) as StateView, indexOf(stream), registry, streams.get(stream) as Map<string, EntityState>);
    if (waiting.length > 0) handoffs[stream] = waiting;
  }
  const claimable: FoldResult["frontier"] = {};
  for (const stream of [...streams.keys()].sort(compareCodeUnits)) {
    const view = views.get(stream) as StateView;
    if (view.all("brief").length > 0) claimable[stream] = frontier(view).map((b) => b.key);
  }
  const labels: Record<string, LabelSummary> = {};
  const labelStreams = new Set([...views.keys(), ...anomalies.map((a) => a.stream)]);
  for (const stream of [...labelStreams].sort(compareCodeUnits)) {
    const recorded = views.get(stream)?.all(LABEL) ?? [];
    const refused = anomalies.filter((a) => a.stream === stream && a.type.startsWith(`${LABEL}.`)).length;
    if (recorded.length > 0 || refused > 0) labels[stream] = summarize(recorded, refused);
  }
  return {
    result: { lastSeq, entities, derived, trees, rejections, anomalies, handoffs, frontier: claimable, ...(Object.keys(labels).length > 0 ? { labels } : {}) },
    indexes,
  };
}

// Stable serialization: sorted keys at every level. Two folds of the same log
// with the same options must produce identical strings (build-plan.md T2).
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort(compareCodeUnits)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value)) ?? "undefined";
}
