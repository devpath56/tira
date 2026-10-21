// Handoffs: the only coupling between regions and entities (regions proposal, signed
// off 2026-10-17; B1 §4). The dispatcher, the single writer of handoff receivers (N2,
// A9), reads the folded state and appends receiver events, each carrying a correlation
// id = the first event of the pair, and a causation id = the event that made it due.
//
// The policy is a pure function of one stream's folded state plus an index of the
// events that started handoffs. The dispatcher uses it to decide what to write; the
// fold uses it on replay to check every dispatcher write was called for (the machine
// writes, it never infers). Each rule's condition turns false once its receiver lands,
// so writing what's due is idempotent and a crash between the two halves of a pair
// just leaves it due.
//
//   H1 brief.dispatched (or a blocked_by dependency's drop.verified) -> brief.claimable
//   H2 drop.filed by the claimant of an open brief -> brief.evidence (if silent) + brief.drop-written
//   H3 drop.verified -> brief.verified-done {done_test_result}
//   H4 drop.rejected -> brief.blocked {block_reason: defective}            (A7)
//   H5 session.ended -> brief.released {reason: session-ended} for briefs it held (A10)
//   H6 a dependency's drop.verified -> brief.unblocked (dependency blocks only, A5)
//   F1 idea.approve-node (idea materialized) -> node.born {idea_id}        (R2, ruling 2026-10-18)
// Plus one relay: the orchestrator asks to block a brief; the dispatcher writes
// brief.blocked {block_reason, requested_by} when the B1 §4 conditions hold.
import type { Registry } from "../tables/registry.ts";
import { ORCHESTRATOR, depsOf, isSuperseded, unverifiedDeps, verifiedDrop } from "../tables/factory.ts";
import { evaluate, type Intent } from "./evaluate.ts";
import type { EntityRef, EntityState, StateView } from "./types.ts";
import { entityKey } from "./types.ts";
import { show } from "../text.ts";
import { compareCodeUnits } from "./view.ts";

export interface TriggerRecord {
  eventId: string;
  seq: number;
  payload: Record<string, unknown>;
}

// The last event of each stored type per entity, in one stream: "brief:b@1|brief.dispatched".
export type TriggerIndex = Map<string, TriggerRecord>;
export const indexKey = (key: string, storedType: string) => `${key}|${storedType}`;

export type Rule = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "F1" | "block";

export interface Receiver {
  rule: Rule;
  target: EntityRef;
  kind: "event" | "create";
  event?: string; // table event, for kind "event"
  payload: Record<string, unknown>;
  correlationId: string;
  causationId: string;
}

export interface PendingHandoff {
  rule: Rule;
  key: string; // the entity the receiver would land on
  since: number; // seq of the event that started it
  waitingOn: string; // plain words: what it waits for
}

const HELD = new Set(["claimed-silent", "claimed-active"]);
const liveBriefs = (view: StateView) => view.all("brief").filter((b) => !isSuperseded(view, b));
export { unverifiedDeps };
const ref = (e: EntityState): EntityRef => ({ type: e.type, id: e.id, ...(e.version === undefined ? {} : { version: e.version }) });
const briefOf = (view: StateView, d: EntityState) => (d.version === undefined ? undefined : view.get({ type: "brief", id: d.id, version: d.version }));

// The latest event among a brief's dispatch and its dependencies' verifications.
function latestCause(view: StateView, idx: TriggerIndex, b: EntityState, first: TriggerRecord): TriggerRecord {
  let best = first;
  for (const id of depsOf(b)) {
    const d = verifiedDrop(view, id);
    const t = d ? idx.get(indexKey(d.key, "drop.verified")) : undefined;
    if (t && t.seq > best.seq) best = t;
  }
  return best;
}

// Every receiver that is due now, in a fixed order.
export function due(view: StateView, idx: TriggerIndex): Receiver[] {
  const out: Receiver[] = [];
  const on = (rule: Rule, target: EntityState, event: string, payload: Record<string, unknown>, first: TriggerRecord, cause: TriggerRecord = first) =>
    out.push({ rule, target: ref(target), kind: "event", event, payload, correlationId: first.eventId, causationId: cause.eventId });

  for (const b of liveBriefs(view)) {
    const ready = unverifiedDeps(view, b).length === 0;
    // H6 first: a dependency block lifts once every dependency is verified (before H1, so a
    // brief never sits claimable and blocked at once between the two writes).
    const blocked = idx.get(indexKey(b.key, "brief.blocked"));
    if (blocked && b.regions.outcome === "blocked" && b.context?.outcome?.block_reason === "dependency" && ready) {
      const cause = latestCause(view, idx, b, blocked);
      on("H6", b, "UNBLOCKED", {}, cause, cause);
    }
    // H1: dispatched, not claimable yet, every dependency verified.
    const dispatched = idx.get(indexKey(b.key, "brief.dispatched"));
    if (dispatched && b.regions.gate === "gated" && b.regions.claim === "waiting" && ready) {
      on("H1", b, "CLAIMABLE", {}, dispatched, latestCause(view, idx, b, dispatched));
    }
  }
  for (const d of view.all("drop")) {
    const b = briefOf(view, d);
    if (!b || isSuperseded(view, b)) continue;
    // H2: the claimant's drop on an open brief: evidence (silent -> active), then drop-written.
    const filed = idx.get(indexKey(d.key, "drop.filed"));
    if (filed && HELD.has(b.regions.claim as string) && b.context?.claim?.claimant === d.createdBy && b.regions.outcome === "open") {
      if (b.regions.claim === "claimed-silent") on("H2", b, "EVIDENCE", { type: "drop" }, filed);
      else on("H2", b, "DROP_WRITTEN", {}, filed);
    }
    // H3 / H4: the orchestrator's verdict on the drop resolves the brief.
    if (b.regions.outcome === "dropped-unverified") {
      const verified = d.regions.lifecycle === "verified" ? idx.get(indexKey(d.key, "drop.verified")) : undefined;
      if (verified) on("H3", b, "VERIFIED_DONE", { done_test_result: verified.payload.done_test_result }, verified);
      const rejected = d.regions.lifecycle === "rejected" ? idx.get(indexKey(d.key, "drop.rejected")) : undefined;
      if (rejected) on("H4", b, "BLOCKED", { block_reason: "defective" }, rejected);
    }
  }
  // H5: an ended session lets go of open briefs it held.
  for (const s of view.all("session")) {
    const ended = s.regions.lifecycle === "ended" ? idx.get(indexKey(s.key, "session.ended")) : undefined;
    if (!ended) continue;
    for (const b of liveBriefs(view)) {
      if (HELD.has(b.regions.claim as string) && b.context?.claim?.claimant === s.id && b.regions.outcome === "open") {
        on("H5", b, "RELEASED", { reason: "session-ended" }, ended);
      }
    }
  }
  // F1: a materialized idea is born as a node (same id), under the parent it was approved for.
  for (const i of view.all("idea")) {
    const approved = i.regions.lifecycle === "materialized" ? idx.get(indexKey(i.key, "idea.approve-node")) : undefined;
    if (!approved || view.get({ type: "node", id: i.id })) continue;
    const parent = approved.payload.parent_id;
    out.push({
      rule: "F1", target: { type: "node", id: i.id }, kind: "create",
      payload: { idea_id: i.id, ...(typeof parent === "string" ? { parent_id: parent } : {}) },
      correlationId: approved.eventId, causationId: approved.eventId,
    });
  }
  return out;
}

export const intentOf = (r: Receiver, actor: string): Intent =>
  r.kind === "create"
    ? { kind: "create", entity: r.target, payload: r.payload, actor }
    : { kind: "event", entity: r.target, event: r.event as string, payload: r.payload, actor };

// The orchestrator's ask to block a brief (B1 §4, last row). Returns why not, or undefined.
export function blockRefusal(view: StateView, b: EntityState | undefined, actor: string | undefined, reason: unknown): string | undefined {
  if (actor !== ORCHESTRATOR) return "only the orchestrator can ask to block a brief";
  if (!b) return "no such brief";
  if (isSuperseded(view, b)) return `${b.key} was superseded`;
  if (b.regions.gate !== "gated") return "undispatched briefs are denied, not blocked: send DENIED";
  if (reason === "defective") return "defective blocks come from a rejected drop, not a request";
  if (reason === "verdict" || reason === "retries-exhausted") {
    return HELD.has(b.regions.claim as string) ? undefined : `${show(reason)} blocks need a claimed brief`;
  }
  if (reason === "dependency") return unverifiedDeps(view, b).length > 0 ? undefined : "nothing to wait for: every blocked_by is verified";
  return `block_reason must be dependency, verdict or retries-exhausted, got ${show(reason)}`;
}

// What is waiting on a handoff right now, and on what. Briefs waiting for dependencies
// are pending, not errors (proposal R3); so is a due receiver the rules would refuse, and
// so is a pair only a person can finish (the orchestrator, or a fix).
export function pending(view: StateView, idx: TriggerIndex, registry: Registry, entities: ReadonlyMap<string, EntityState>): PendingHandoff[] {
  const out: PendingHandoff[] = [];
  const add = (rule: Rule, key: string, since: number, waitingOn: string) => out.push({ rule, key, since, waitingOn });
  for (const b of liveBriefs(view)) {
    const dispatched = idx.get(indexKey(b.key, "brief.dispatched"));
    const waiting = unverifiedDeps(view, b);
    if (dispatched && b.regions.gate === "gated" && b.regions.claim === "waiting" && waiting.length > 0) {
      add("H1", b.key, dispatched.seq, `verified drops for ${waiting.join(", ")}`);
    }
  }
  for (const d of view.all("drop")) {
    const b = briefOf(view, d);
    const filed = idx.get(indexKey(d.key, "drop.filed"));
    // H2: a filed drop its brief never took (one drop per version, so drop-written means it did)
    const taken = b !== undefined && idx.get(indexKey(b.key, "brief.drop-written")) !== undefined;
    if (filed && d.regions.lifecycle === "filed" && !taken) {
      const why = !b ? `no brief ${d.id}@${String(d.version)}`
        : isSuperseded(view, b) ? `${b.key} was superseded`
        : !HELD.has(b.regions.claim as string) ? `${b.key} isn't claimed`
        : b.context?.claim?.claimant !== d.createdBy ? `${String(d.createdBy)} doesn't hold ${b.key}`
        : b.regions.outcome !== "open" ? `${b.key} is ${b.regions.outcome}` : undefined;
      if (why) add("H2", b?.key ?? d.key, filed.seq, `the orchestrator: ${why}`);
    }
    // H3: a verified drop whose brief can't take it (e.g. blocked meanwhile): it needs a revise
    const verified = d.regions.lifecycle === "verified" ? idx.get(indexKey(d.key, "drop.verified")) : undefined;
    if (verified && b && taken && b.regions.outcome !== "done-verified" && b.regions.outcome !== "dropped-unverified") {
      add("H3", b.key, verified.seq, `a fix: the drop was verified but ${b.key} is ${b.regions.outcome}`);
    }
  }
  // F1: an approved idea whose node id is already taken by another node
  for (const i of view.all("idea")) {
    const approved = i.regions.lifecycle === "materialized" ? idx.get(indexKey(i.key, "idea.approve-node")) : undefined;
    const node = view.get({ type: "node", id: i.id });
    const born = node ? idx.get(indexKey(node.key, "node.born")) : undefined;
    if (approved && node && born?.payload.idea_id !== i.id) {
      add("F1", node.key, approved.seq, `a fix: ${node.key} already exists and wasn't born from this idea`);
    }
  }
  for (const r of due(view, idx)) {
    const ev = evaluate(registry, entities, view, intentOf(r, "dispatcher"));
    const since = [...idx.values()].find((t) => t.eventId === r.correlationId)?.seq ?? 0;
    add(r.rule, entityKey(r.target), since, ev.ok ? "the dispatcher" : `a fix: ${ev.detail}`);
  }
  return out.sort((a, b) => a.since - b.since || compareCodeUnits(a.key, b.key));
}
