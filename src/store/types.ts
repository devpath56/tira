// Storage interface — packing.md §3. Everything above the store speaks only this.
// SQLite implements it on one machine, Postgres for a shared tira (packing.md D11).
//
// Deviations from the §3 sketch, made explicit (provisional; flagged for the PM):
// - NewEvent carries an optional eventId. §3 makes eventId the idempotency key
//   ("duplicate eventId => no-op"), which only works if the caller can supply it;
//   the store generates one when absent. An empty eventId is refused.
// - Re-appending an eventId to the SAME stream returns the original seq (§3 rule 3).
//   Re-appending it to a DIFFERENT stream throws DuplicateEventIdError: the id is
//   globally UNIQUE (§3 DDL), and silently returning another stream's seq would lie.
// - subscribe() takes an optional onError. Delivery is at-least-once: if the
//   handler throws, the same event is offered again on the next poll.

export interface EventMetadata {
  actor?: string;
  causationId?: string; // the event that caused this one
  correlationId?: string; // handoffs: the first event of the pair (regions proposal R2)
  era?: number; // the rules era the write path decided it under (registry.ts); absent: legacy
}

export interface NewEvent {
  eventId?: string;
  type: string;
  data: Record<string, unknown>;
  metadata?: EventMetadata;
}

export interface StoredEvent {
  eventId: string;
  stream: string;
  seq: number; // global, gapless, monotonic — the replay cursor
  streamRevision: number; // 0-based position within the stream
  type: string;
  data: Record<string, unknown>;
  metadata: EventMetadata;
  recordedAt: string; // ISO-8601, set by the store; informational only
}

export interface AppendResult {
  seqs: number[]; // one per input event, in order (original seq for duplicates)
  streamRevision: number; // revision of the stream's last event after the append
}

export interface AppendOptions {
  // Revision of the stream's last event the caller saw; -1 for "stream is empty".
  expectedRevision?: number;
}

export interface ReadStreamOptions {
  fromRevision?: number;
  limit?: number;
  direction?: "forwards" | "backwards";
}

export interface ReadAllOptions {
  fromSeq?: number;
  limit?: number;
}

export interface Subscription {
  close(): void;
}

export interface EventStore {
  append(stream: string, events: NewEvent[], opts?: AppendOptions): Promise<AppendResult>;
  readStream(stream: string, opts?: ReadStreamOptions): Promise<StoredEvent[]>;
  readAll(opts?: ReadAllOptions): Promise<StoredEvent[]>;
  subscribe(source: string, handler: SubscribeHandler, opts?: SubscribeOptions): Promise<Subscription>;
}

// May be async: the return value is awaited, and the next event is offered only
// after it settles. (`unknown`, not `void | Promise<void>`, so `e => list.push(e)` fits.)
export type SubscribeHandler = (e: StoredEvent) => unknown;

export interface SubscribeOptions {
  fromSeq?: number;
  // Handler or poll failure; the subscription keeps running and offers the same
  // event again on the next poll. `attempts` counts consecutive failures on it.
  onError?: (err: unknown, info: { seq: number | undefined; attempts: number }) => void;
}

export const ALL = "$all";

export class WrongExpectedRevisionError extends Error {
  readonly stream: string;
  readonly expected: number;
  readonly actual: number;
  constructor(stream: string, expected: number, actual: number) {
    super(`stream ${stream}: expected revision ${expected}, actual ${actual}`);
    this.name = "WrongExpectedRevisionError";
    this.stream = stream;
    this.expected = expected;
    this.actual = actual;
  }
}

export class DuplicateEventIdError extends Error {
  readonly eventId: string;
  constructor(eventId: string, existingStream: string, stream: string) {
    super(`eventId ${eventId} already stored in ${existingStream}, re-appended to ${stream}`);
    this.name = "DuplicateEventIdError";
    this.eventId = eventId;
  }
}
