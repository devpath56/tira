// SQLite implementation of the EventStore interface (packing.md §3).
// The store guarantees ordering, durability and idempotency — it never validates
// domain rules (that is the write path's job, before append).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  ALL,
  DuplicateEventIdError,
  WrongExpectedRevisionError,
  type AppendOptions,
  type AppendResult,
  type EventStore,
  type NewEvent,
  type ReadAllOptions,
  type ReadStreamOptions,
  type StoredEvent,
  type SubscribeHandler,
  type SubscribeOptions,
  type Subscription,
} from "./types.ts";

// DDL verbatim from packing.md §3: append-only is structural, not conventional.
const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  stream          TEXT NOT NULL,
  stream_revision INTEGER NOT NULL,
  event_id        TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  data            TEXT NOT NULL,
  metadata        TEXT,
  recorded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream, stream_revision);
CREATE TRIGGER IF NOT EXISTS no_update_events BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_events BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

interface Row {
  seq: number;
  stream: string;
  stream_revision: number;
  event_id: string;
  type: string;
  data: string;
  metadata: string | null;
  recorded_at: string;
}

const toStored = (r: Row): StoredEvent => ({
  eventId: r.event_id,
  stream: r.stream,
  seq: r.seq,
  streamRevision: r.stream_revision,
  type: r.type,
  data: JSON.parse(r.data) as Record<string, unknown>,
  metadata: r.metadata ? (JSON.parse(r.metadata) as StoredEvent["metadata"]) : {},
  recordedAt: r.recorded_at,
});

export interface SqliteStoreOptions {
  path?: string; // default ":memory:"
  pollIntervalMs?: number; // subscribe() poll loop; default 50
}

// Run `work` now and settle a promise with its result: a throw becomes a rejection.
const settled = <T>(work: () => T): Promise<T> => new Promise<T>((resolve) => resolve(work()));

export class SqliteEventStore implements EventStore {
  readonly db: DatabaseSync;
  private readonly pollIntervalMs: number;

  constructor(opts: SqliteStoreOptions = {}) {
    const path = opts.path ?? ":memory:";
    this.db = new DatabaseSync(path);
    // A file-backed store is read by the UI while the writer appends (packing.md §4):
    // WAL lets readers proceed during a write; busy_timeout waits instead of failing.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(DDL);
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
  }

  close(): void {
    this.db.close();
  }

  private lastRevision(stream: string): number {
    const r = this.db
      .prepare("SELECT MAX(stream_revision) AS rev FROM events WHERE stream = ?")
      .get(stream) as { rev: number | null } | undefined;
    return r?.rev ?? -1;
  }

  // The store is synchronous underneath; these return promises for the interface (§3).
  // `settled` runs the work now, as an async method would, and turns a throw into a rejection.
  append(stream: string, events: NewEvent[], opts: AppendOptions = {}): Promise<AppendResult> {
    return settled(() => this.appendNow(stream, events, opts));
  }

  private appendNow(stream: string, events: NewEvent[], opts: AppendOptions): AppendResult {
    if (stream === ALL) throw new Error(`cannot append to ${ALL}`);
    for (const e of events) {
      if (e.eventId !== undefined && (typeof e.eventId !== "string" || e.eventId.length === 0)) {
        throw new TypeError("eventId must be a non-empty string");
      }
    }
    const findById = this.db.prepare("SELECT seq, stream FROM events WHERE event_id = ?");
    const insert = this.db.prepare(
      "INSERT INTO events (stream, stream_revision, event_id, type, data, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Duplicates are resolved first: a pure retry must succeed even though the
      // stream has moved past the caller's expectedRevision.
      const resolved = events.map((e) => {
        const eventId = e.eventId ?? randomUUID();
        const existing =
          e.eventId !== undefined ? (findById.get(eventId) as { seq: number; stream: string } | undefined) : undefined;
        if (existing && existing.stream !== stream) {
          throw new DuplicateEventIdError(eventId, existing.stream, stream);
        }
        return { e, eventId, existingSeq: existing?.seq };
      });
      const fresh = resolved.filter((r) => r.existingSeq === undefined);
      let rev = this.lastRevision(stream);
      if (fresh.length > 0 && opts.expectedRevision !== undefined && opts.expectedRevision !== rev) {
        throw new WrongExpectedRevisionError(stream, opts.expectedRevision, rev);
      }
      const seqs: number[] = [];
      const seen = new Map<string, number>(); // duplicates inside one batch
      for (const r of resolved) {
        if (r.existingSeq !== undefined) {
          seqs.push(r.existingSeq);
          continue;
        }
        const dup = seen.get(r.eventId);
        if (dup !== undefined) {
          seqs.push(dup);
          continue;
        }
        rev += 1;
        const res = insert.run(
          stream,
          rev,
          r.eventId,
          r.e.type,
          JSON.stringify(r.e.data),
          r.e.metadata ? JSON.stringify(r.e.metadata) : null,
        );
        const seq = Number(res.lastInsertRowid);
        seen.set(r.eventId, seq);
        seqs.push(seq);
      }
      this.db.exec("COMMIT");
      return { seqs, streamRevision: rev };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  readStream(stream: string, opts: ReadStreamOptions = {}): Promise<StoredEvent[]> {
    return settled(() => this.readStreamNow(stream, opts));
  }

  private readStreamNow(stream: string, opts: ReadStreamOptions): StoredEvent[] {
    const backwards = opts.direction === "backwards";
    const from = opts.fromRevision ?? (backwards ? Number.MAX_SAFE_INTEGER : 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE stream = ? AND stream_revision ${backwards ? "<=" : ">="} ?
         ORDER BY stream_revision ${backwards ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(stream, from, opts.limit ?? -1) as unknown as Row[];
    return rows.map(toStored);
  }

  readAll(opts: ReadAllOptions = {}): Promise<StoredEvent[]> {
    return settled(() => this.readAllNow(opts));
  }

  private readAllNow(opts: ReadAllOptions): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq >= ? ORDER BY seq ASC LIMIT ?")
      .all(opts.fromSeq ?? 1, opts.limit ?? -1) as unknown as Row[];
    return rows.map(toStored);
  }

  // Catch-up from fromSeq, then stay subscribed. MVP: a poll loop over seq (§3).
  // At-least-once: the cursor moves past an event only after the handler settles.
  // A handler that keeps failing on one event blocks the ones after it (by design:
  // order is the contract); onError reports the consecutive-failure count so the
  // caller can decide to close. Known follow-up: backoff / dead-letter.
  async subscribe(source: string, handler: SubscribeHandler, opts: SubscribeOptions = {}): Promise<Subscription> {
    let next = opts.fromSeq ?? 1;
    let closed = false;
    let draining = false;
    let failing: { seq: number | undefined; attempts: number } = { seq: undefined, attempts: 0 };
    const report = (err: unknown, seq: number | undefined) => {
      failing = { seq, attempts: failing.seq === seq ? failing.attempts + 1 : 1 };
      try {
        opts.onError?.(err, failing);
      } catch {
        // an onError that throws must not take the poll loop down
      }
    };
    const drain = async () => {
      if (closed || draining) return;
      draining = true;
      let current: number | undefined;
      try {
        for (const e of await this.readAll({ fromSeq: next })) {
          if (closed) return;
          current = e.seq;
          if (source === ALL || e.stream === source) await handler(e);
          next = e.seq + 1;
        }
      } catch (err) {
        report(err, current);
      } finally {
        draining = false;
      }
    };
    await drain();
    const timer = setInterval(() => void drain(), this.pollIntervalMs);
    return {
      close() {
        closed = true;
        clearInterval(timer);
      },
    };
  }
}
