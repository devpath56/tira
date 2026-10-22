// A2 — EventStore contract tests (packing.md §3 "Rules the interface enforces"), run against every
// store: SQLite always; Postgres when TIRA_PG_URL names a database (CI sets it). Each Postgres test
// works in a fresh schema, dropped after it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { PostgresEventStore } from "../src/store/postgres-store.ts";
import { ALL, DuplicateEventIdError, WrongExpectedRevisionError, type StoredEvent } from "../src/store/types.ts";
import type { ClosableStore } from "../src/store/open.ts";

const ev = (type: string, eventId?: string) => ({ ...(eventId ? { eventId } : {}), type, data: { n: type } });

interface Kit {
  store: ClosableStore;
  tamper: string[]; // SQL that edits or removes stored events: each must be refused
  exec(sql: string): Promise<unknown>;
  reopen(): Promise<ClosableStore>; // another store on the same data (a durable kit only)
  done(): Promise<void>;
}
interface Backend {
  name: string;
  skip: string | false;
  open(opts?: { pollIntervalMs?: number; durable?: boolean }): Promise<Kit>;
  slow: number; // how much longer live delivery may take (a network round trip per poll)
}

const sqlite: Backend = {
  name: "sqlite",
  skip: false,
  slow: 1,
  async open(opts = {}) {
    const dir = opts.durable ? mkdtempSync(join(tmpdir(), "tira-")) : undefined;
    const path = dir === undefined ? ":memory:" : join(dir, "events.db");
    const make = () => new SqliteEventStore({ path, ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }) });
    const store = make();
    const others: SqliteEventStore[] = [];
    return {
      store,
      tamper: ["UPDATE events SET type = 'tampered'", "DELETE FROM events"],
      exec: async (sql) => store.db.exec(sql),
      async reopen() {
        if (dir === undefined) throw new Error("open the kit durable to reopen it");
        const s = make();
        others.push(s);
        return s;
      },
      async done() {
        for (const s of [store, ...others]) {
          try {
            s.close();
          } catch {
            // already closed by the test
          }
        }
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

const PG_URL = process.env.TIRA_PG_URL;
let admin: pg.Pool | undefined;
after(() => admin?.end());
const postgres: Backend = {
  name: "postgres",
  skip: PG_URL ? false : "set TIRA_PG_URL to a Postgres database to run these (CI does)",
  slow: 3,
  async open(opts = {}) {
    const url = PG_URL as string;
    const schema = `tira_t_${randomBytes(6).toString("hex")}`;
    const make = () => new PostgresEventStore({ url, schema, ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }) });
    const store = make();
    const others: PostgresEventStore[] = [];
    admin ??= new pg.Pool({ connectionString: url });
    return {
      store,
      tamper: [`UPDATE ${schema}.events SET type = 'tampered'`, `DELETE FROM ${schema}.events`, `TRUNCATE ${schema}.events`],
      exec: (sql) => store.exec(sql),
      async reopen() {
        const s = make();
        others.push(s);
        return s;
      },
      async done() {
        await Promise.all([store, ...others].map((s) => s.close()));
        await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      },
    };
  },
};

for (const b of [sqlite, postgres]) {
  const it = (name: string, body: () => Promise<void>) => test(`${b.name}: ${name}`, { skip: b.skip }, body);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * b.slow));
  // a kit for one test, cleaned up whatever the test does
  const using = async (opts: Parameters<Backend["open"]>[0], body: (k: Kit) => Promise<void>) => {
    const k = await b.open(opts);
    try {
      await body(k);
    } finally {
      await k.done();
    }
  };

  it("append assigns gapless global seq and 0-based stream revisions", () => using({}, async ({ store: s }) => {
    const a = await s.append("tasktree-a", [ev("x.1"), ev("x.2")]);
    const bb = await s.append("tasktree-b", [ev("y.1")]);
    const c = await s.append("tasktree-a", [ev("x.3")]);
    assert.deepEqual([...a.seqs, ...bb.seqs, ...c.seqs], [1, 2, 3, 4]);
    assert.equal(c.streamRevision, 2);
    const all = await s.readAll();
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual((await s.readStream("tasktree-a")).map((e) => e.streamRevision), [0, 1, 2]);
  }));

  it("UPDATE, DELETE (and TRUNCATE) abort: append-only is structural (rule 1)", () => using({}, async (k) => {
    await k.store.append("t", [ev("x")]);
    for (const sql of k.tamper) await assert.rejects(k.exec(sql), /append-only/, sql);
    assert.equal((await k.store.readAll())[0]?.type, "x");
  }));

  it("duplicate eventId returns the original seq without duplicating (rule 3)", () => using({}, async ({ store: s }) => {
    const first = await s.append("t", [ev("x", "id-1")]);
    await s.append("t", [ev("y", "id-2")]);
    const retry = await s.append("t", [ev("x", "id-1")]);
    assert.deepEqual(retry.seqs, first.seqs);
    assert.equal((await s.readAll()).length, 2);
  }));

  it("a pure retry succeeds even with a stale expectedRevision", () => using({}, async ({ store: s }) => {
    await s.append("t", [ev("x", "id-1")], { expectedRevision: -1 });
    await s.append("t", [ev("y", "id-2")], { expectedRevision: 0 });
    const retry = await s.append("t", [ev("x", "id-1")], { expectedRevision: -1 });
    assert.deepEqual(retry.seqs, [1]);
  }));

  it("duplicate eventId inside one batch is stored once", () => using({}, async ({ store: s }) => {
    const r = await s.append("t", [ev("x", "dup"), ev("x", "dup")]);
    assert.deepEqual(r.seqs, [1, 1]);
    assert.equal((await s.readAll()).length, 1);
  }));

  it("same eventId in a different stream is refused", () => using({}, async ({ store: s }) => {
    await s.append("a", [ev("x", "id-1")]);
    await assert.rejects(s.append("b", [ev("x", "id-1")]), DuplicateEventIdError);
  }));

  it("expectedRevision mismatch rejects the whole batch, leaving no gap in seq", () => using({}, async ({ store: s }) => {
    await s.append("t", [ev("x")]);
    await assert.rejects(s.append("t", [ev("y"), ev("z")], { expectedRevision: -1 }), WrongExpectedRevisionError);
    const ok = await s.append("t", [ev("y")], { expectedRevision: 0 });
    assert.deepEqual(ok.seqs, [2]); // no seq consumed by the failed attempt
  }));

  it("seq stays gapless across failed appends and retries", () => using({}, async ({ store: s }) => {
    for (let i = 0; i < 20; i++) {
      await s.append("t", [ev("x", `id-${i}`)]);
      await s.append("t", [ev("x", `id-${i}`)]); // retry
      await assert.rejects(s.append("t", [ev("bad")], { expectedRevision: -5 }));
    }
    const seqs = (await s.readAll()).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  }));

  it("two connections writing at once: every append lands, seq gapless and in order, each stream's revisions in order", () => using({ durable: true }, async (k) => {
    const other = await k.reopen();
    const n = 25;
    await Promise.all(Array.from({ length: n }, (_, i) => [
      k.store.append("a", [ev(`a${i}`)]),
      other.append("b", [ev(`b${i}`)]),
      other.append("a", [ev(`a'${i}`)]),
    ]).flat());
    const all = await k.store.readAll();
    assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 3 * n }, (_, i) => i + 1));
    assert.deepEqual((await other.readStream("a")).map((e) => e.streamRevision), Array.from({ length: 2 * n }, (_, i) => i));
    assert.deepEqual((await k.store.readStream("b")).map((e) => e.streamRevision), Array.from({ length: n }, (_, i) => i));
  }));

  it("readStream: fromRevision, limit, backwards", () => using({}, async ({ store: s }) => {
    await s.append("t", [ev("a"), ev("b"), ev("c"), ev("d")]);
    assert.deepEqual((await s.readStream("t", { fromRevision: 2 })).map((e) => e.type), ["c", "d"]);
    assert.deepEqual((await s.readStream("t", { limit: 2 })).map((e) => e.type), ["a", "b"]);
    assert.deepEqual((await s.readStream("t", { direction: "backwards", limit: 2 })).map((e) => e.type), ["d", "c"]);
  }));

  it("readAll: fromSeq for replay-to-N", () => using({}, async ({ store: s }) => {
    await s.append("a", [ev("1"), ev("2")]);
    await s.append("b", [ev("3")]);
    assert.deepEqual((await s.readAll({ fromSeq: 2 })).map((e) => e.seq), [2, 3]);
    assert.deepEqual((await s.readAll({ limit: 1 })).map((e) => e.seq), [1]);
  }));

  it("metadata and data round-trip, key order and all; recordedAt is set by the store", () => using({}, async ({ store: s }) => {
    await s.append("t", [{ type: "x", data: { z: 1, a: [1, { b: true }], m: "ü" }, metadata: { actor: "isha", causationId: "c1" } }]);
    const [e] = await s.readAll();
    assert.deepEqual(e?.data, { z: 1, a: [1, { b: true }], m: "ü" });
    assert.deepEqual(Object.keys(e?.data ?? {}), ["z", "a", "m"]); // stored as written
    assert.deepEqual(e?.metadata, { actor: "isha", causationId: "c1" });
    assert.match(e?.recordedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }));

  it("subscribe: catch-up, then live; stream filter; close stops delivery", () => using({ pollIntervalMs: 5 }, async ({ store: s }) => {
    await s.append("a", [ev("a1")]);
    await s.append("b", [ev("b1")]);
    const seenAll: StoredEvent[] = [];
    const seenA: StoredEvent[] = [];
    const subAll = await s.subscribe(ALL, (e) => seenAll.push(e));
    const subA = await s.subscribe("a", (e) => seenA.push(e));
    assert.deepEqual(seenAll.map((e) => e.type), ["a1", "b1"]); // catch-up is synchronous with subscribe
    await s.append("a", [ev("a2")]);
    await wait(30);
    subAll.close();
    subA.close();
    await s.append("a", [ev("a3")]);
    await wait(30);
    assert.deepEqual(seenAll.map((e) => e.type), ["a1", "b1", "a2"]);
    assert.deepEqual(seenA.map((e) => e.type), ["a1", "a2"]);
  }));

  it("subscribe: fromSeq skips earlier events", () => using({ pollIntervalMs: 5 }, async ({ store: s }) => {
    await s.append("a", [ev("1"), ev("2"), ev("3")]);
    const seen: number[] = [];
    const sub = await s.subscribe(ALL, (e) => seen.push(e.seq), { fromSeq: 3 });
    sub.close();
    assert.deepEqual(seen, [3]);
  }));

  it("subscribe: a throwing handler gets the same event again (at-least-once); onError hears it", () => using({ pollIntervalMs: 5 }, async ({ store: s }) => {
    await s.append("a", [ev("1"), ev("2")]);
    const seen: number[] = [];
    const errors: unknown[] = [];
    let failOnce = true;
    const sub = await s.subscribe(
      ALL,
      (e) => {
        if (e.seq === 2 && failOnce) {
          failOnce = false;
          throw new Error("handler hiccup");
        }
        seen.push(e.seq);
      },
      { onError: (err) => errors.push(err) },
    );
    await wait(30);
    sub.close();
    assert.deepEqual(seen, [1, 2]); // 2 was redelivered, not lost
    assert.equal(errors.length, 1);
  }));

  it("subscribe: an async handler is awaited; a rejection is redelivered, never unhandled", () => using({ pollIntervalMs: 5 }, async ({ store: s }) => {
    await s.append("a", [ev("1"), ev("2"), ev("3")]);
    const seen: number[] = [];
    const infos: { seq: number | undefined; attempts: number }[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    let failures = 2;
    try {
      const sub = await s.subscribe(
        ALL,
        async (e) => {
          await new Promise((r) => setTimeout(r, 1));
          if (e.seq === 2 && failures-- > 0) throw new Error("async hiccup");
          seen.push(e.seq);
        },
        { onError: (_err, info) => infos.push(info) },
      );
      await wait(60);
      sub.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    assert.deepEqual(seen, [1, 2, 3]); // in order, 2 after its two failures
    assert.deepEqual(infos, [{ seq: 2, attempts: 1 }, { seq: 2, attempts: 2 }]);
  }));

  it("subscribe: closing the store under a live subscription does not crash the process", () => using({ pollIntervalMs: 5 }, async ({ store: s }) => {
    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const sub = await s.subscribe(ALL, () => {}, { onError: (err) => errors.push(err) });
      await s.close();
      await wait(30);
      sub.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    assert.ok(errors.length > 0); // the failure is reported, not swallowed
  }));

  it("a durable store survives reopen; its counter carries on", () => using({ durable: true }, async (k) => {
    await k.store.append("t", [ev("x", "id-1")]);
    await k.store.close();
    const again = await k.reopen();
    assert.deepEqual((await again.readAll()).map((e) => e.eventId), ["id-1"]);
    assert.deepEqual((await again.append("t", [ev("y")])).seqs, [2]); // the counter carries on
  }));
}

test("a postgres:// URL opens the Postgres store; anything else, a SQLite file; a URL's password is never printed", async () => {
  const { openStore, dbLabel } = await import("../src/store/open.ts");
  for (const url of ["postgres://tira@127.0.0.1:1/none", "postgresql://tira@127.0.0.1:1/none"]) {
    const s = openStore(url);
    assert.ok(s instanceof PostgresEventStore, url);
    await s.close();
  }
  // ?schema= picks the schema (default "tira"), and isn't passed on to the driver
  const named = openStore("postgres://tira@127.0.0.1:1/none?schema=trial_one");
  assert.ok(named instanceof PostgresEventStore);
  assert.equal(named.schema, "trial_one");
  await named.close();
  const plain = openStore("postgres://tira@127.0.0.1:1/none");
  assert.equal((plain as PostgresEventStore).schema, "tira");
  await plain.close();
  const s = openStore(":memory:");
  assert.ok(s instanceof SqliteEventStore);
  await s.close();
  assert.equal(dbLabel("postgres://tira:s3cret@db.example:5432/tira"), "postgres://tira:***@db.example:5432/tira");
  assert.equal(dbLabel("postgres://db.example/tira"), "postgres://db.example/tira");
  assert.equal(dbLabel("tira.db"), "tira.db");
});
