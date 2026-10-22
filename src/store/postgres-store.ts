// Postgres implementation of the EventStore interface (packing.md §3): the shared store for tira
// with many people and many workspaces (decided 2026-10-21; it replaces KurrentDB as the named
// upgrade). It keeps every rule the SQLite store keeps, judged by the same contract tests
// (test/store.test.ts), and like it never validates domain rules.
//
// - Append-only is structural: triggers abort UPDATE, DELETE and TRUNCATE on the events table.
//   (Dropping the table needs its owner: in production tira connects as a login that owns
//   nothing and may only insert and read; see the README.)
// - seq is global, gapless and monotonic. Postgres's own numbering (a sequence or identity) leaves
//   gaps when a transaction rolls back, and two writers can commit their numbers out of order, so
//   a reader could pass seq 11 before seq 10 lands. Instead every append locks the one counter row
//   (SELECT … FOR UPDATE) for its whole transaction: appends run one at a time, each takes the next
//   numbers, and commits in that order. Ample for a team; the lock is the price of one order.
// - Data and metadata are stored as text, exactly as written (jsonb would re-order keys).
// - Each store works in one schema (default "tira"); tests use a fresh schema each.
import pg from "pg";
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
import { pollSubscribe } from "./poll.ts";

export interface PostgresStoreOptions {
  url: string; // postgres://user:password@host:port/database
  schema?: string; // default "tira"
  pollIntervalMs?: number; // subscribe() poll loop; default 50
  maxConnections?: number; // this store's pool; default 4 (appends run one at a time anyway)
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// The schema, once per database: its own lock, so two processes starting together don't race.
const ddl = (s: string) => `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.events (
  seq             BIGINT PRIMARY KEY,
  stream          TEXT NOT NULL,
  stream_revision INTEGER NOT NULL,
  event_id        TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  data            TEXT NOT NULL,
  metadata        TEXT,
  recorded_at     TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE (stream, stream_revision)
);
CREATE TABLE IF NOT EXISTS ${s}.event_seq (
  one  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (one),
  last BIGINT NOT NULL
);
INSERT INTO ${s}.event_seq (one, last) VALUES (TRUE, 0) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION ${s}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'events are append-only'; END $$;
CREATE OR REPLACE TRIGGER no_update_events BEFORE UPDATE ON ${s}.events
  FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();
CREATE OR REPLACE TRIGGER no_delete_events BEFORE DELETE ON ${s}.events
  FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();
CREATE OR REPLACE TRIGGER no_truncate_events BEFORE TRUNCATE ON ${s}.events
  FOR EACH STATEMENT EXECUTE FUNCTION ${s}.events_append_only();
`;

interface Row {
  seq: string; // BIGINT comes back as text
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
  seq: Number(r.seq),
  streamRevision: r.stream_revision,
  type: r.type,
  data: JSON.parse(r.data) as Record<string, unknown>,
  metadata: r.metadata ? (JSON.parse(r.metadata) as StoredEvent["metadata"]) : {},
  recordedAt: r.recorded_at,
});

export class PostgresEventStore implements EventStore {
  readonly schema: string;
  private readonly pool: pg.Pool;
  private readonly pollIntervalMs: number;
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(opts: PostgresStoreOptions) {
    this.schema = opts.schema ?? "tira";
    if (!SCHEMA_NAME.test(this.schema)) throw new TypeError(`bad schema name: ${this.schema}`);
    // a small pool: appends queue on the counter lock anyway, and many processes share the server
    this.pool = new pg.Pool({ connectionString: opts.url, max: opts.maxConnections ?? 4 });
    // an idle connection the server drops must not take the process down; the next query reconnects
    this.pool.on("error", () => {});
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
    // Set up only what is missing: re-creating a trigger locks the table against writes, and
    // every CLI command opens a store.
    this.ready = this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tira-schema:${this.schema}`]);
      const made = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = r.relnamespace
         WHERE ns.nspname = $1 AND r.relname = 'events' AND t.tgname IN ('no_update_events', 'no_delete_events', 'no_truncate_events')`,
        [this.schema],
      );
      if ((made.rows[0]?.n ?? 0) < 3) await c.query(ddl(this.schema));
    });
    this.ready.catch(() => {}); // reported by the first call that waits on it
  }

  // Run SQL as this store's connection (tests, and the manual tamper checks in the README).
  async exec(sql: string): Promise<void> {
    await this.ready;
    await this.pool.query(sql);
  }

  // Safe to call twice: the second call does nothing.
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.pool.end();
  }

  private async transaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await work(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async append(stream: string, events: NewEvent[], opts: AppendOptions = {}): Promise<AppendResult> {
    if (stream === ALL) throw new Error(`cannot append to ${ALL}`);
    for (const e of events) {
      if (e.eventId !== undefined && (typeof e.eventId !== "string" || e.eventId.length === 0)) {
        throw new TypeError("eventId must be a non-empty string");
      }
    }
    await this.ready;
    const s = this.schema;
    return this.transaction(async (c) => {
      // the one writer: the counter row stays locked until this append commits or rolls back
      const counter = await c.query<{ last: string }>(`SELECT last FROM ${s}.event_seq WHERE one FOR UPDATE`);
      let last = Number(counter.rows[0]?.last ?? 0);
      // Duplicates are resolved first: a pure retry must succeed even though the
      // stream has moved past the caller's expectedRevision.
      const ids = events.flatMap((e) => (e.eventId === undefined ? [] : [e.eventId]));
      const found = ids.length === 0 ? [] : (await c.query<{ seq: string; stream: string; event_id: string }>(
        `SELECT seq, stream, event_id FROM ${s}.events WHERE event_id = ANY($1::text[])`, [ids])).rows;
      const byId = new Map(found.map((f) => [f.event_id, f]));
      const resolved = events.map((e) => {
        const eventId = e.eventId ?? randomUUID();
        const existing = e.eventId !== undefined ? byId.get(eventId) : undefined;
        if (existing && existing.stream !== stream) throw new DuplicateEventIdError(eventId, existing.stream, stream);
        return { e, eventId, existingSeq: existing === undefined ? undefined : Number(existing.seq) };
      });
      const fresh = resolved.filter((r) => r.existingSeq === undefined);
      const top = await c.query<{ rev: number | null }>(`SELECT MAX(stream_revision) AS rev FROM ${s}.events WHERE stream = $1`, [stream]);
      let rev = top.rows[0]?.rev ?? -1;
      if (fresh.length > 0 && opts.expectedRevision !== undefined && opts.expectedRevision !== rev) {
        throw new WrongExpectedRevisionError(stream, opts.expectedRevision, rev);
      }
      const seqs: number[] = [];
      const rows: { seq: number; rev: number; eventId: string; e: NewEvent }[] = [];
      const seen = new Map<string, number>(); // duplicates inside one batch
      for (const r of resolved) {
        const dup = r.existingSeq ?? seen.get(r.eventId);
        if (dup !== undefined) {
          seqs.push(dup);
          continue;
        }
        last += 1;
        rev += 1;
        rows.push({ seq: last, rev, eventId: r.eventId, e: r.e });
        seen.set(r.eventId, last);
        seqs.push(last);
      }
      if (rows.length > 0) {
        await c.query(
          `INSERT INTO ${s}.events (seq, stream, stream_revision, event_id, type, data, metadata)
           SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[])`,
          [rows.map((x) => x.seq), rows.map(() => stream), rows.map((x) => x.rev), rows.map((x) => x.eventId), rows.map((x) => x.e.type),
            rows.map((x) => JSON.stringify(x.e.data)), rows.map((x) => (x.e.metadata ? JSON.stringify(x.e.metadata) : null))],
        );
      }
      await c.query(`UPDATE ${s}.event_seq SET last = $1 WHERE one`, [last]);
      return { seqs, streamRevision: rev };
    });
  }

  async readStream(stream: string, opts: ReadStreamOptions = {}): Promise<StoredEvent[]> {
    await this.ready;
    const backwards = opts.direction === "backwards";
    const from = opts.fromRevision ?? (backwards ? 2147483647 : 0);
    const r = await this.pool.query<Row>(
      `SELECT * FROM ${this.schema}.events WHERE stream = $1 AND stream_revision ${backwards ? "<=" : ">="} $2
       ORDER BY stream_revision ${backwards ? "DESC" : "ASC"} LIMIT $3`,
      [stream, from, opts.limit ?? null],
    );
    return r.rows.map(toStored);
  }

  async readAll(opts: ReadAllOptions = {}): Promise<StoredEvent[]> {
    await this.ready;
    const r = await this.pool.query<Row>(
      `SELECT * FROM ${this.schema}.events WHERE seq >= $1 ORDER BY seq ASC LIMIT $2`,
      [opts.fromSeq ?? 1, opts.limit ?? null],
    );
    return r.rows.map(toStored);
  }

  // Catch-up from fromSeq, then stay subscribed: the same poll loop as the SQLite store (poll.ts).
  subscribe(source: string, handler: SubscribeHandler, opts: SubscribeOptions = {}): Promise<Subscription> {
    return pollSubscribe((o) => this.readAll(o), source, handler, opts, this.pollIntervalMs);
  }
}
