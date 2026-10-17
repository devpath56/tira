// The guarded write path: the only way events reach the store.
// command -> replay the stream -> evaluate (legality, guards, invariant) ->
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
import { randomInt } from "node:crypto";
import { ALL, WrongExpectedRevisionError, type EventStore, type StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { evaluate, type Intent, type RejectCode } from "../fold/evaluate.ts";
import { REJECTED, toIntent, toNewEvent, toRejectedEvent, type RejectedData } from "../fold/events.ts";
import { canonicalJson, fold, makeView } from "../fold/fold.ts";
import type { EntityRef, EntityState } from "../fold/types.ts";

export type Command = {
  stream: string;
  entity: EntityRef;
  payload?: Record<string, unknown>;
  eventId?: string; // idempotency key: a retried command never lands twice
  actor?: string;
} & ({ kind: "create" } | { kind: "event"; event: string });

export type WriteResult =
  | {
      status: "appended";
      seq: number;
      outcome: "created" | "transition" | "noop";
      key: string;
      regions: Record<string, string>;
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
const recordedIntent = (e: StoredEvent): Intent | undefined =>
  e.type === REJECTED ? (e.data as unknown as RejectedData | undefined)?.intent : toIntent(e);

export class WritePath {
  private readonly store: EventStore;
  private readonly registry: Registry;
  private readonly maxAttempts: number;

  constructor(store: EventStore, registry: Registry, opts: WritePathOptions = {}) {
    this.store = store;
    this.registry = registry;
    this.maxAttempts = opts.maxAttempts ?? 10;
  }

  submit(cmd: Command): Promise<WriteResult> {
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
      () => this.submitNow(snapshot),
      () => this.submitNow(snapshot),
    );
    const settled = run.catch(() => undefined);
    queues.set(snapshot.stream, settled);
    void settled.then(() => {
      if (queues.get(snapshot.stream) === settled) queues.delete(snapshot.stream);
    });
    return run;
  }

  private async submitNow(cmd: Command): Promise<WriteResult> {
    const payload = cmd.payload ?? {};
    const intent: Intent =
      cmd.kind === "create"
        ? { kind: "create", entity: cmd.entity, payload, actor: cmd.actor }
        : { kind: "event", entity: cmd.entity, event: cmd.event, payload, actor: cmd.actor };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const events = await this.store.readStream(cmd.stream);
      if (cmd.eventId !== undefined) {
        const prior = events.find((e) => e.eventId === cmd.eventId);
        if (prior) {
          if (canonicalJson(recordedIntent(prior)) !== canonicalJson(intent)) {
            throw new Error(`eventId ${cmd.eventId} was already used for a different command`);
          }
          return { status: "duplicate", seq: prior.seq, original: prior.type === REJECTED ? "rejected" : "appended" };
        }
      }
      const state = fold(events, this.registry);
      const entities = new Map<string, EntityState>(state.entities.map((e) => [e.key, e]));
      const ev = evaluate(this.registry, entities, makeView(entities), intent);
      const last = events.at(-1);
      const expectedRevision = last ? last.streamRevision : -1;
      const record = ev.ok
        ? toNewEvent(intent, cmd.eventId)
        : toRejectedEvent(intent, ev.code, ev.detail, cmd.eventId);
      try {
        const { seqs } = await this.store.append(cmd.stream, [record], { expectedRevision });
        const seq = seqs[0] as number;
        if (!ev.ok) return { status: "rejected", seq, code: ev.code, detail: ev.detail };
        return { status: "appended", seq, outcome: ev.outcome, key: ev.key, regions: ev.regions };
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
}
