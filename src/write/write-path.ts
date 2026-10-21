// The guarded write path: the only way events reach the store.
// command -> replay the stream -> evaluate (legality, guards, tree gates) ->
// append the event, OR append a `command.rejected` record (acceptance review Q4
// default: denials live in the same stream; the fold collects them, never applies them).
//
// One writer per stream; actors are many and travel in metadata
// (b0-factory-mapping.md G10). Within a process, submits to the same stream of the
// same store are queued — across every WritePath instance on that store — so
// concurrent actors are evaluated one after another: a second claim sees the first.
// Across processes, the append carries expectedRevision, and a lost race re-reads and
// re-evaluates after a jittered backoff (bounded by maxAttempts).
//
// Note: the promise submit() returns is also observed by the queue, so an ignored
// rejected submit() does not raise unhandledRejection. Always await submit().
//
// Provisional semantics (not in the spec; flagged for the PM):
// - eventId identifies a COMMAND. Re-submitting the same eventId with the same
//   content returns "duplicate" (even if the original was rejected); re-submitting
//   it with different content throws. A corrected command needs a new eventId.
// - Commands that are not well-formed (wrong shapes, empty ids) throw instead of
//   being logged: they cannot be represented as an intent at all.
// - Entities come into existence with an explicit `create` command, starting at
//   each region's initial state (acceptance review M3 / Q-B3: creation is unspecced).
//
// tira holds the pen (ruling 2026-10-18). When a command moves work INTO the active
// state (START / UNBLOCK / REOPEN -> in_progress) on a node outside a drained, still-open
// parent, tira closes that parent itself: START (if nobody started it) + COMPLETE, written
// as actor "tira", through evaluate() like any command, each citing the move (payload
// `trigger` + metadata causationId = the move's eventId). The chain climbs: closing one
// parent can drain and close the next. tira's events go in the SAME atomic append as the
// move, just ahead of it, so the one-active rule is never broken mid-way. If the move
// itself is rejected, tira writes nothing. "tira" is reserved: submit() refuses it, in
// any casing or spacing.
import { randomInt, randomUUID } from "node:crypto";
import { ALL, WrongExpectedRevisionError, type EventStore, type NewEvent, type StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { step } from "../tables/table.ts";
import { evaluate, type Intent, type RejectCode } from "../fold/evaluate.ts";
import { REJECTED, toIntent, toNewEvent, toRejectedEvent, type RejectedData } from "../fold/events.ts";
import { canonicalJson, fold, makeView } from "../fold/fold.ts";
import { children, nextCloseFor } from "../fold/tree.ts";
import { MACHINE_ACTOR, entityKey, type EntityRef, type EntityState } from "../fold/types.ts";
import { DISPATCHER, FX_KEY } from "../tables/factory.ts";
import { fxKey, transitionOf } from "./fxkey.ts";

export type Command = {
  stream: string;
  entity: EntityRef;
  payload?: Record<string, unknown>;
  eventId?: string; // idempotency key: a retried command never lands twice
  actor?: string;
  correlationId?: string; // handoff receivers: the first event of the pair (stored in metadata)
  causationId?: string; // the event that caused this one (stored in metadata)
} & ({ kind: "create" } | { kind: "event"; event: string });

type Refusal = { code: RejectCode; detail: string };

export interface TiraClose {
  key: string; // the parent tira closed
  seqs: number[]; // its start (if any) and complete events
}

export type WriteResult =
  | {
      status: "appended";
      seq: number;
      outcome: "created" | "transition" | "noop";
      key: string;
      regions: Record<string, string>;
      closedByTira?: TiraClose[]; // parents tira closed because this command moved work on
    }
  | { status: "rejected"; seq: number; code: RejectCode; detail: string }
  | { status: "duplicate"; seq: number; original: "appended" | "rejected" }
  | { status: "skipped"; seq: number }; // a dispatcher receiver that was no longer due: nothing written

export interface WritePathOptions {
  maxAttempts?: number; // re-read/re-evaluate on a lost cross-process race; default 10
}

// Queues are shared by every WritePath on the same store object.
const QUEUES = new WeakMap<EventStore, Map<string, Promise<unknown>>>();
function queueFor(store: EventStore): Map<string, Promise<unknown>> {
  let q = QUEUES.get(store);
  if (!q) {
    q = new Map();
    QUEUES.set(store, q);
  }
  return q;
}

// Jittered so racing processes don't retry in lockstep. Not security-sensitive;
// crypto.randomInt just avoids Math.random being flagged as a weak PRNG.
const backoff = (attempt: number) =>
  new Promise((r) => setTimeout(r, randomInt(0, Math.min(100, 5 * 2 ** attempt) + 1)));

// The machine roles' names are reserved: tira's, and the factory dispatcher's (B1: the
// single writer of handoff receivers). Anything that reads as one of them on the page is
// theirs: any casing or spacing, invisible characters, accents, and the common lookalike
// letters (Cyrillic а/і/т, Turkish ı, Greek ι/α/τ).
const LOOKALIKE: Record<string, string> = {
  "а": "a", "с": "c", "е": "e", "і": "i", "о": "o", "р": "p", "т": "t", "х": "x", "һ": "h", "ԁ": "d", // Cyrillic
  "ı": "i", "ι": "i", "α": "a", "τ": "t", "ο": "o", "ρ": "p", "ε": "e", "η": "h", // Turkish, Greek
};
const skeleton = (s: string) =>
  [...s.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Cc}\s]/gu, "").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join("");
const RESERVED = new Set([MACHINE_ACTOR, DISPATCHER]);
const isReserved = (actor: string | undefined) => actor !== undefined && RESERVED.has(skeleton(actor));
// For callers that act under a fixed name (tira serve): refuse a reserved one up front.
export const isReservedActor = isReserved;

// What a command would do, without writing it (WritePath.preview): the same decision the
// write makes, tira's closes included.
export type Preview =
  | { ok: true; outcome: "created" | "transition" | "noop"; key: string; regions: Record<string, string>; closes: string[] }
  | { ok: false; code: RejectCode; detail: string };

const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;

function checkShape(cmd: Command): void {
  if (!isObj(cmd)) throw new TypeError("command must be an object");
  if (!nonEmpty(cmd.stream) || cmd.stream === ALL) throw new TypeError(`bad stream: ${String(cmd.stream)}`);
  if (!isObj(cmd.entity) || !nonEmpty(cmd.entity.type) || !nonEmpty(cmd.entity.id)) {
    throw new TypeError("entity must be { type, id, version? }");
  }
  if (cmd.entity.version !== undefined && (!Number.isInteger(cmd.entity.version) || cmd.entity.version < 1)) {
    throw new TypeError("entity.version must be an integer >= 1");
  }
  if (cmd.payload !== undefined && !isObj(cmd.payload)) throw new TypeError("payload must be an object");
  if (cmd.eventId !== undefined && !nonEmpty(cmd.eventId)) throw new TypeError("eventId must be a non-empty string");
  // fx: ids are transition-embedded (B2): only the rule's exact shape may use the prefix
  if (cmd.eventId?.startsWith("fx:") && !FX_KEY.test(cmd.eventId)) throw new TypeError("an fx: eventId must be fx: + 64 lowercase hex (see src/write/fxkey.ts)");
  if (cmd.actor !== undefined && !nonEmpty(cmd.actor)) throw new TypeError("actor must be a non-empty string");
  for (const k of ["correlationId", "causationId"] as const) {
    if (cmd[k] !== undefined && !nonEmpty(cmd[k])) throw new TypeError(`${k} must be a non-empty string`);
  }
  if (cmd.kind !== "create" && cmd.kind !== "event") throw new TypeError(`bad kind: ${String((cmd as { kind: unknown }).kind)}`);
  if (cmd.kind === "event" && !nonEmpty(cmd.event)) throw new TypeError("event required");
}

// B2: an fx: id must be its own transition's key. Checked on what the caller sent, before the
// dispatcher relays it or anything is stored, so a mix-up (say, a refusal recorded under the
// refused transition's key, which the real send needs later) is refused at once with the
// expected key, instead of clashing with a later write.
function checkFxKey(cmd: Command, registry: Registry): void {
  if (!cmd.eventId?.startsWith("fx:")) return;
  const want = fxKey(transitionOf(cmd, (t, v) => registry.creationName(t, v)));
  if (cmd.eventId !== want) throw new TypeError(`${cmd.eventId} isn't this transition's fx: key (it would be ${want}; see src/write/fxkey.ts)`);
}

// Everything a command is checked for before it is queued: its shape, and its fx: key.
export function checkCommand(cmd: Command, registry: Registry): void {
  checkShape(cmd);
  checkFxKey(cmd, registry);
}

// The intent a stored event recorded, for comparing a retried command with its original.
const recordedIntent = (e: StoredEvent, registry: Registry): Intent | undefined =>
  e.type === REJECTED
    ? (e.data as unknown as RejectedData | undefined)?.intent
    : toIntent(e, (t, v) => registry.creationName(t, v));

interface ClosePlan {
  overlay: Map<string, EntityState>; // the tree after tira's closes
  records: NewEvent[]; // tira's events, ready to append ahead of the move
  closed: { key: string; indexes: number[] }[]; // which records closed which parent
}

export class WritePath {
  private readonly store: EventStore;
  private readonly registry: Registry;
  private readonly maxAttempts: number;

  constructor(store: EventStore, registry: Registry, opts: WritePathOptions = {}) {
    this.store = store;
    this.registry = registry;
    this.maxAttempts = opts.maxAttempts ?? 10;
  }

  // Every external caller (CLI, factory, tests acting as people) comes through here.
  submit(cmd: Command): Promise<WriteResult> {
    return this.enqueue(cmd, false);
  }

  // What this command would do if submitted now, decided exactly as submit() decides it
  // (reserved names, tira's closes planned first, then the rules), without writing anything.
  // A later write can change the answer: callers that act on it must re-check.
  async preview(cmd: Command): Promise<Preview> {
    checkCommand(cmd, this.registry);
    const payload = cmd.payload ?? {};
    const intent: Intent = cmd.kind === "create"
      ? { kind: "create", entity: cmd.entity, payload, actor: cmd.actor }
      : { kind: "event", entity: cmd.entity, event: cmd.event, payload, actor: cmd.actor };
    return this.decide(intent, await this.store.readStream(cmd.stream), false, "preview").verdict;
  }

  // In-process only: the factory dispatcher writing a handoff receiver as itself, through
  // the same evaluate() as everyone (handoffs.ts decides what it writes).
  // `stillDue` is checked against the stream as it is when the write happens (inside the
  // per-stream queue, and again after a lost race): two commands finishing at once can't
  // both write the same receiver.
  submitAsDispatcher(cmd: Command, stillDue?: (events: StoredEvent[]) => boolean): Promise<WriteResult> {
    return this.enqueue({ ...cmd, actor: DISPATCHER }, true, undefined, stillDue);
  }

  // In-process only: log a command as rejected without evaluating it (a request the
  // dispatcher won't relay). The rejection keeps the caller's actor.
  refuse(cmd: Command, code: RejectCode, detail: string): Promise<WriteResult> {
    return this.enqueue(cmd, true, { code, detail });
  }

  // In-process only: tira closing a parent on its own authority, through the same
  // evaluate() as everyone. Used for fault injection (proof 2: a close on a parent that
  // isn't drained is denied and logged). A close that succeeds here has no move to cite,
  // so replay flags it — tira closes only on a move.
  closeAsTira(stream: string, entity: EntityRef, reason = "tira close requested"): Promise<WriteResult> {
    const event = this.registry.get(entity.type)?.tree?.completeEvent ?? "COMPLETE";
    return this.enqueue(
      { stream, kind: "event", entity, event, actor: MACHINE_ACTOR, payload: { reason, evidenceRef: "requested" } },
      true,
    );
  }

  private enqueue(cmd: Command, internal: boolean, refusal?: Refusal, stillDue?: (events: StoredEvent[]) => boolean): Promise<WriteResult> {
    let snapshot: Command;
    try {
      // internal writes are tira's and the dispatcher's own (a relayed block keeps the caller's
      // fx: id as its own, checked before the relay: Dispatcher.submit)
      if (internal) checkShape(cmd);
      else checkCommand(cmd, this.registry);
      // Evaluate the command as it was at submit(), not as it is when dequeued.
      snapshot = structuredClone(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    const queues = queueFor(this.store);
    const prev = queues.get(snapshot.stream) ?? Promise.resolve();
    const run = prev.then(
      () => this.submitNow(snapshot, internal, refusal, stillDue),
      () => this.submitNow(snapshot, internal, refusal, stillDue),
    );
    const settled = run.catch(() => undefined);
    queues.set(snapshot.stream, settled);
    void settled.then(() => {
      if (queues.get(snapshot.stream) === settled) queues.delete(snapshot.stream);
    });
    return run;
  }

  private async submitNow(cmd: Command, internal: boolean, refusal?: Refusal, stillDue?: (events: StoredEvent[]) => boolean): Promise<WriteResult> {
    const payload = cmd.payload ?? {};
    const intent: Intent =
      cmd.kind === "create"
        ? { kind: "create", entity: cmd.entity, payload, actor: cmd.actor }
        : { kind: "event", entity: cmd.entity, event: cmd.event, payload, actor: cmd.actor };
    // The move's id is fixed before any attempt, so tira's events can cite it.
    const moveId = cmd.eventId ?? randomUUID();
    // A refused claim to be tira is logged without the name, so a retry compares that way.
    const asLogged: Intent = !internal && isReserved(intent.actor) ? { ...intent, actor: undefined } : intent;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const events = await this.store.readStream(cmd.stream);
      if (cmd.eventId !== undefined) {
        const prior = events.find((e) => e.eventId === cmd.eventId);
        if (prior) {
          if (canonicalJson(recordedIntent(prior, this.registry)) !== canonicalJson(asLogged)) {
            throw new Error(`eventId ${cmd.eventId} was already used for a different command`);
          }
          return { status: "duplicate", seq: prior.seq, original: prior.type === REJECTED ? "rejected" : "appended" };
        }
      }
      const last = events.at(-1);
      if (stillDue && !stillDue(events)) return { status: "skipped", seq: last?.seq ?? 0 };
      const expectedRevision = last ? last.streamRevision : -1;
      const meta = { ...(cmd.correlationId ? { correlationId: cmd.correlationId } : {}), ...(cmd.causationId ? { causationId: cmd.causationId } : {}) };
      const { batch, result } = refusal
        ? { batch: [toRejectedEvent(intent, refusal.code, refusal.detail, moveId)], result: (seqs: number[]): WriteResult => ({ status: "rejected", seq: seqs[0] as number, ...refusal }) }
        : this.decide(intent, events, internal, moveId, meta);
      // Versioned rules: every event carries the era it was decided under, so replay can judge
      // it by the same rules after they change.
      const stamped = batch.map((x) => ({ ...x, metadata: { ...x.metadata, era: this.registry.era } }));
      try {
        const { seqs } = await this.store.append(cmd.stream, stamped, { expectedRevision });
        return result(seqs);
      } catch (err) {
        if (err instanceof WrongExpectedRevisionError && attempt < this.maxAttempts) {
          await backoff(attempt);
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  // What to append for this intent, and how to report it once the store assigns seqs.
  private decide(intent: Intent, events: StoredEvent[], internal: boolean, moveId: string, meta: { correlationId?: string; causationId?: string } = {}) {
    if (!internal && isReserved(intent.actor)) {
      // Proof 3: the machine's labels come from the caller, never from what a command says.
      const name = skeleton(intent.actor as string);
      const detail = `actor "${name}" is reserved for ${name === MACHINE_ACTOR ? "tira's" : "the dispatcher's"} own writes`;
      return {
        batch: [toRejectedEvent({ ...intent, actor: undefined }, "reserved-actor", detail, moveId)],
        result: (seqs: number[]): WriteResult => ({ status: "rejected", seq: seqs[0] as number, code: "reserved-actor", detail }),
        verdict: { ok: false, code: "reserved-actor", detail } as Preview,
      };
    }
    const state = fold(events, this.registry);
    const entities = new Map<string, EntityState>(state.entities.map((e) => [e.key, e]));
    const plan = internal ? undefined : this.planTiraCloses(intent, entities, moveId);
    const after = plan?.overlay ?? entities;
    const ev = evaluate(this.registry, after, makeView(after), intent);
    if (ev.ok) {
      const born = toNewEvent(intent, moveId, (t, v) => this.registry.creationName(t, v));
      const move = Object.keys(meta).length > 0 ? { ...born, metadata: { ...born.metadata, ...meta } } : born;
      return {
        batch: [...(plan?.records ?? []), move],
        result: (seqs: number[]): WriteResult => ({
          status: "appended",
          seq: seqs.at(-1) as number,
          outcome: ev.outcome,
          key: ev.key,
          regions: ev.regions,
          ...(plan && plan.closed.length > 0
            ? { closedByTira: plan.closed.map((c) => ({ key: c.key, seqs: c.indexes.map((i) => seqs[i] as number) })) }
            : {}),
        }),
        verdict: { ok: true, outcome: ev.outcome, key: ev.key, regions: ev.regions, closes: (plan?.closed ?? []).map((c) => c.key) } as Preview,
      };
    }
    // The move is rejected: tira writes nothing, and the reason is judged on the tree as
    // it stands — not on tira's would-be closes.
    const asIs = plan ? evaluate(this.registry, entities, makeView(entities), intent) : ev;
    const why = asIs.ok ? ev : asIs;
    const code: RejectCode = why.ok ? "denied" : why.code;
    const detail = why.ok ? "rejected" : why.detail;
    return {
      batch: [toRejectedEvent(intent, code, detail, moveId)],
      result: (seqs: number[]): WriteResult => ({ status: "rejected", seq: seqs[0] as number, code, detail }),
      verdict: { ok: false, code, detail } as Preview,
    };
  }

  // Which parents tira closes for this command, as events ready to append ahead of it.
  // Only for a move into the tree's active state, on a type with machineCloses.
  private planTiraCloses(intent: Intent, entities: ReadonlyMap<string, EntityState>, moveId: string): ClosePlan | undefined {
    if (intent.kind !== "event") return undefined;
    const def = this.registry.get(intent.entity.type);
    const t = def?.tree;
    if (!def || !t?.machineCloses || t.completeEvent === undefined || t.startEvent === undefined) return undefined;
    const targetKey = entityKey(intent.entity);
    const target = entities.get(targetKey);
    const hit = this.registry.resolve(def.type, intent.event);
    if (!target || !hit || hit.region !== t.region) return undefined;
    const res = step(hit.table, target.regions[t.region] as string, intent.event, this.registry.guards, {
      payload: intent.payload, actor: intent.actor, entity: target, view: makeView(entities),
    });
    if (res.outcome !== "transition" || res.to !== t.active) return undefined;

    const overlay = new Map(entities);
    const records: NewEvent[] = [];
    const closed: ClosePlan["closed"] = [];
    const moveLabel = `${intent.event} ${targetKey}`;
    for (let guard = 0; guard <= entities.size; guard++) {
      const ov = makeView(overlay);
      const parent = nextCloseFor(t, def.type, ov, targetKey);
      if (!parent) break;
      const kids = children(parent, ov).map((c) => c.key);
      const steps: { event: string; payload: Record<string, unknown>; paired?: boolean }[] = [];
      if (parent.regions[t.region] !== t.active) {
        steps.push({ event: t.startEvent, payload: { reason: `opening ${parent.key} to close it: work moved on (${moveLabel})`, trigger: moveId }, paired: true });
      }
      steps.push({
        event: t.completeEvent,
        payload: { evidenceRef: `children closed: ${kids.join(", ")}`, reason: `work moved on (${moveLabel})`, trigger: moveId },
      });
      // A close is all or nothing: if any step is refused, tira keeps none of this parent's
      // events (no half-open parent) and logs the refusal under its own name.
      const before = overlay.get(parent.key) as EntityState;
      const mine: NewEvent[] = [];
      let refused: NewEvent | undefined;
      for (const s of steps) {
        const mIntent: Intent = { kind: "event", entity: { type: def.type, id: parent.id }, event: s.event, payload: s.payload, actor: MACHINE_ACTOR };
        const mev = evaluate(this.registry, overlay, makeView(overlay), mIntent, { pairedClose: s.paired === true });
        if (!mev.ok) {
          refused = toRejectedEvent(mIntent, mev.code, mev.detail);
          break;
        }
        overlay.set(mev.key, { ...(overlay.get(mev.key) as EntityState), regions: mev.regions, lastActor: MACHINE_ACTOR });
        const e = toNewEvent(mIntent, undefined, (x, v) => this.registry.creationName(x, v));
        mine.push({ ...e, metadata: { actor: MACHINE_ACTOR, causationId: moveId } });
      }
      if (refused) {
        overlay.set(parent.key, before);
        records.push(refused);
        break;
      }
      closed.push({ key: parent.key, indexes: mine.map((_, i) => records.length + i) });
      records.push(...mine);
    }
    return { overlay, records, closed };
  }
}
