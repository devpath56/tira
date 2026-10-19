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

export type Command = {
  stream: string;
  entity: EntityRef;
  payload?: Record<string, unknown>;
  eventId?: string; // idempotency key: a retried command never lands twice
  actor?: string;
} & ({ kind: "create" } | { kind: "event"; event: string });

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
  | { status: "duplicate"; seq: number; original: "appended" | "rejected" };

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

// Anything that reads as "tira" on the page is tira's: any casing or spacing, invisible
// characters, accents, and the common lookalike letters (Cyrillic а/і/т, Turkish ı, Greek ι/α/τ).
const LOOKALIKE: Record<string, string> = { "а": "a", "і": "i", "т": "t", "ı": "i", "ι": "i", "α": "a", "τ": "t" };
const skeleton = (s: string) =>
  [...s.normalize("NFKD").replace(/[\p{M}\p{Cf}\s]/gu, "").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join("");
const isReserved = (actor: string | undefined) => actor !== undefined && skeleton(actor) === MACHINE_ACTOR;

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
  if (cmd.actor !== undefined && !nonEmpty(cmd.actor)) throw new TypeError("actor must be a non-empty string");
  if (cmd.kind !== "create" && cmd.kind !== "event") throw new TypeError(`bad kind: ${String((cmd as { kind: unknown }).kind)}`);
  if (cmd.kind === "event" && !nonEmpty(cmd.event)) throw new TypeError("event required");
}

// The intent a stored event recorded, for comparing a retried command with its original.
const recordedIntent = (e: StoredEvent, registry: Registry): Intent | undefined =>
  e.type === REJECTED
    ? (e.data as unknown as RejectedData | undefined)?.intent
    : toIntent(e, (t) => registry.creationName(t));

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

  private enqueue(cmd: Command, internal: boolean): Promise<WriteResult> {
    let snapshot: Command;
    try {
      checkShape(cmd);
      // Evaluate the command as it was at submit(), not as it is when dequeued.
      snapshot = structuredClone(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    const queues = queueFor(this.store);
    const prev = queues.get(snapshot.stream) ?? Promise.resolve();
    const run = prev.then(
      () => this.submitNow(snapshot, internal),
      () => this.submitNow(snapshot, internal),
    );
    const settled = run.catch(() => undefined);
    queues.set(snapshot.stream, settled);
    void settled.then(() => {
      if (queues.get(snapshot.stream) === settled) queues.delete(snapshot.stream);
    });
    return run;
  }

  private async submitNow(cmd: Command, internal: boolean): Promise<WriteResult> {
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
      const expectedRevision = last ? last.streamRevision : -1;
      const { batch, result } = this.decide(intent, events, internal, moveId);
      try {
        const { seqs } = await this.store.append(cmd.stream, batch, { expectedRevision });
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
  private decide(intent: Intent, events: StoredEvent[], internal: boolean, moveId: string) {
    if (!internal && isReserved(intent.actor)) {
      // Proof 3: the "tira" label comes from the caller, never from what a command says.
      const detail = `actor "${MACHINE_ACTOR}" is reserved for tira's own writes`;
      return {
        batch: [toRejectedEvent({ ...intent, actor: undefined }, "reserved-actor", detail, moveId)],
        result: (seqs: number[]): WriteResult => ({ status: "rejected", seq: seqs[0] as number, code: "reserved-actor", detail }),
      };
    }
    const state = fold(events, this.registry);
    const entities = new Map<string, EntityState>(state.entities.map((e) => [e.key, e]));
    const plan = internal ? undefined : this.planTiraCloses(intent, entities, moveId);
    const after = plan?.overlay ?? entities;
    const ev = evaluate(this.registry, after, makeView(after), intent);
    if (ev.ok) {
      const move = toNewEvent(intent, moveId, (t) => this.registry.creationName(t));
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
        const e = toNewEvent(mIntent, undefined, (x) => this.registry.creationName(x));
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
