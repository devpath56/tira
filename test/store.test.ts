// A2 — EventStore contract tests (packing.md §3 "Rules the interface enforces").
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { ALL, DuplicateEventIdError, WrongExpectedRevisionError, type StoredEvent } from "../src/store/types.ts";

const ev = (type: string, eventId?: string) => ({ ...(eventId ? { eventId } : {}), type, data: { n: type } });

test("append assigns gapless global seq and 0-based stream revisions", async () => {
  const s = new SqliteEventStore();
  const a = await s.append("tasktree-a", [ev("x.1"), ev("x.2")]);
  const b = await s.append("tasktree-b", [ev("y.1")]);
  const c = await s.append("tasktree-a", [ev("x.3")]);
  assert.deepEqual([...a.seqs, ...b.seqs, ...c.seqs], [1, 2, 3, 4]);
  assert.equal(c.streamRevision, 2);
  const all = await s.readAll();
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual((await s.readStream("tasktree-a")).map((e) => e.streamRevision), [0, 1, 2]);
});

test("UPDATE and DELETE abort: append-only is structural (rule 1)", async () => {
  const s = new SqliteEventStore();
  await s.append("t", [ev("x")]);
  assert.throws(() => s.db.exec("UPDATE events SET type = 'tampered'"), /append-only/);
  assert.throws(() => s.db.exec("DELETE FROM events"), /append-only/);
  assert.equal((await s.readAll())[0]?.type, "x");
});

test("duplicate eventId returns the original seq without duplicating (rule 3)", async () => {
  const s = new SqliteEventStore();
  const first = await s.append("t", [ev("x", "id-1")]);
  await s.append("t", [ev("y", "id-2")]);
  const retry = await s.append("t", [ev("x", "id-1")]);
  assert.deepEqual(retry.seqs, first.seqs);
  assert.equal((await s.readAll()).length, 2);
});

test("a pure retry succeeds even with a stale expectedRevision", async () => {
  const s = new SqliteEventStore();
  await s.append("t", [ev("x", "id-1")], { expectedRevision: -1 });
  await s.append("t", [ev("y", "id-2")], { expectedRevision: 0 });
  const retry = await s.append("t", [ev("x", "id-1")], { expectedRevision: -1 });
  assert.deepEqual(retry.seqs, [1]);
});

test("duplicate eventId inside one batch is stored once", async () => {
  const s = new SqliteEventStore();
  const r = await s.append("t", [ev("x", "dup"), ev("x", "dup")]);
  assert.deepEqual(r.seqs, [1, 1]);
  assert.equal((await s.readAll()).length, 1);
});

test("same eventId in a different stream is refused", async () => {
  const s = new SqliteEventStore();
  await s.append("a", [ev("x", "id-1")]);
  await assert.rejects(s.append("b", [ev("x", "id-1")]), DuplicateEventIdError);
});

test("expectedRevision mismatch rejects the whole batch, leaving no gap in seq", async () => {
  const s = new SqliteEventStore();
  await s.append("t", [ev("x")]);
  await assert.rejects(s.append("t", [ev("y"), ev("z")], { expectedRevision: -1 }), WrongExpectedRevisionError);
  const ok = await s.append("t", [ev("y")], { expectedRevision: 0 });
  assert.deepEqual(ok.seqs, [2]); // no seq consumed by the failed attempt
});

test("seq stays gapless across failed appends and retries", async () => {
  const s = new SqliteEventStore();
  for (let i = 0; i < 20; i++) {
    await s.append("t", [ev("x", `id-${i}`)]);
    await s.append("t", [ev("x", `id-${i}`)]); // retry
    await assert.rejects(s.append("t", [ev("bad")], { expectedRevision: -5 }));
  }
  const seqs = (await s.readAll()).map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
});

test("readStream: fromRevision, limit, backwards", async () => {
  const s = new SqliteEventStore();
  await s.append("t", [ev("a"), ev("b"), ev("c"), ev("d")]);
  assert.deepEqual((await s.readStream("t", { fromRevision: 2 })).map((e) => e.type), ["c", "d"]);
  assert.deepEqual((await s.readStream("t", { limit: 2 })).map((e) => e.type), ["a", "b"]);
  assert.deepEqual((await s.readStream("t", { direction: "backwards", limit: 2 })).map((e) => e.type), ["d", "c"]);
});

test("readAll: fromSeq for replay-to-N", async () => {
  const s = new SqliteEventStore();
  await s.append("a", [ev("1"), ev("2")]);
  await s.append("b", [ev("3")]);
  assert.deepEqual((await s.readAll({ fromSeq: 2 })).map((e) => e.seq), [2, 3]);
  assert.deepEqual((await s.readAll({ limit: 1 })).map((e) => e.seq), [1]);
});

test("metadata and data round-trip; recordedAt is set by the store", async () => {
  const s = new SqliteEventStore();
  await s.append("t", [{ type: "x", data: { a: [1, { b: true }] }, metadata: { actor: "isha", causationId: "c1" } }]);
  const [e] = await s.readAll();
  assert.deepEqual(e?.data, { a: [1, { b: true }] });
  assert.deepEqual(e?.metadata, { actor: "isha", causationId: "c1" });
  assert.match(e?.recordedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("subscribe: catch-up, then live; stream filter; close stops delivery", async () => {
  const s = new SqliteEventStore({ pollIntervalMs: 5 });
  await s.append("a", [ev("a1")]);
  await s.append("b", [ev("b1")]);
  const seenAll: StoredEvent[] = [];
  const seenA: StoredEvent[] = [];
  const subAll = await s.subscribe(ALL, (e) => seenAll.push(e));
  const subA = await s.subscribe("a", (e) => seenA.push(e));
  assert.deepEqual(seenAll.map((e) => e.type), ["a1", "b1"]); // catch-up is synchronous with subscribe
  await s.append("a", [ev("a2")]);
  await new Promise((r) => setTimeout(r, 30));
  subAll.close();
  subA.close();
  await s.append("a", [ev("a3")]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seenAll.map((e) => e.type), ["a1", "b1", "a2"]);
  assert.deepEqual(seenA.map((e) => e.type), ["a1", "a2"]);
});

test("subscribe: fromSeq skips earlier events", async () => {
  const s = new SqliteEventStore({ pollIntervalMs: 5 });
  await s.append("a", [ev("1"), ev("2"), ev("3")]);
  const seen: number[] = [];
  const sub = await s.subscribe(ALL, (e) => seen.push(e.seq), { fromSeq: 3 });
  sub.close();
  assert.deepEqual(seen, [3]);
});

test("subscribe: a throwing handler gets the same event again (at-least-once); onError hears it", async () => {
  const s = new SqliteEventStore({ pollIntervalMs: 5 });
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
  await new Promise((r) => setTimeout(r, 30));
  sub.close();
  assert.deepEqual(seen, [1, 2]); // 2 was redelivered, not lost
  assert.equal(errors.length, 1);
});

test("subscribe: an async handler is awaited; a rejection is redelivered, never unhandled", async () => {
  const s = new SqliteEventStore({ pollIntervalMs: 5 });
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
    await new Promise((r) => setTimeout(r, 60));
    sub.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(seen, [1, 2, 3]); // in order, 2 after its two failures
  assert.deepEqual(infos, [{ seq: 2, attempts: 1 }, { seq: 2, attempts: 2 }]);
});

test("subscribe: closing the store under a live subscription does not crash the process", async () => {
  const s = new SqliteEventStore({ pollIntervalMs: 5 });
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const sub = await s.subscribe(ALL, () => {}, { onError: (err) => errors.push(err) });
    s.close();
    await new Promise((r) => setTimeout(r, 30));
    sub.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.ok(errors.length > 0); // the failure is reported, not swallowed
});

test("a file-backed store survives reopen (durability)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tira-"));
  const path = join(dir, "events.db");
  try {
    const s1 = new SqliteEventStore({ path });
    await s1.append("t", [ev("x", "id-1")]);
    s1.close();
    const s2 = new SqliteEventStore({ path });
    assert.deepEqual((await s2.readAll()).map((e) => e.eventId), ["id-1"]);
    assert.throws(() => s2.db.exec("DELETE FROM events"), /append-only/);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
