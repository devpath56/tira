// A4 — guarded write path. Scenario names refer to build-plan.md §5; these cover the
// single-node parts of S2, S6, S7 and T1, T3, T4. Tree behaviour (S1, S3, S4, T7:
// children, drain, cursor) is C1 and is not tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath, type Command, type WriteResult } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { REJECTED } from "../src/fold/events.ts";
import type { EventStore } from "../src/store/types.ts";

const STREAM = "tasktree-dash";
const N = { type: "node", id: "loading_state" };

function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const send = (event: string, payload: Record<string, unknown> = {}, extra: Partial<Command> = {}) =>
    wp.submit({ stream: STREAM, kind: "event", entity: N, event, payload, ...extra } as Command);
  const create = () => wp.submit({ stream: STREAM, kind: "create", entity: N, actor: "isha" });
  const state = async () => fold(await store.readStream(STREAM), registry);
  const lifecycle = async () => (await state()).entities.find((e) => e.id === N.id)?.regions.lifecycle;
  return { store, registry, wp, send, create, state, lifecycle };
}

const status = (r: WriteResult) => (r.status === "rejected" ? `rejected:${r.code}` : r.status === "appended" ? `appended:${r.outcome}` : r.status);

test("S2 done-without-proof: bare COMPLETE rejected and logged; evidenced COMPLETE -> done", async () => {
  const t = setup();
  await t.create();
  await t.send("START");
  assert.equal(status(await t.send("COMPLETE")), "rejected:guard-failed");
  assert.equal(await t.lifecycle(), "in_progress");
  assert.equal(status(await t.send("COMPLETE", { evidenceRef: "spinner.mp4" })), "appended:transition");
  assert.equal(await t.lifecycle(), "done");
  const s = await t.state();
  assert.equal(s.rejections.length, 1);
  assert.equal(s.rejections[0]?.code, "guard-failed");
  assert.deepEqual(s.anomalies, []);
});

test("S6 honest undo: bare REOPEN rejected; reasoned REOPEN -> in_progress; trail kept", async () => {
  const t = setup();
  await t.create();
  await t.send("START");
  await t.send("COMPLETE", { evidenceRef: "palette.png" });
  assert.equal(status(await t.send("REOPEN")), "rejected:guard-failed");
  assert.equal(status(await t.send("REOPEN", { reason: "wrong palette file" })), "appended:transition");
  assert.equal(status(await t.send("COMPLETE", { evidenceRef: "palette-v2.png" })), "appended:transition");
  const types = (await t.store.readStream(STREAM)).map((e) => e.type);
  assert.deepEqual(types, ["node.born", "node.start", "node.complete", REJECTED, "node.reopen", "node.complete"]);
  assert.equal(await t.lifecycle(), "done");
});

test("S7 false finish: CANCEL is terminal; START after CANCEL rejected", async () => {
  const t = setup();
  await t.create();
  await t.send("START");
  await t.send("CANCEL");
  assert.equal(status(await t.send("START")), "rejected:denied");
  assert.equal(await t.lifecycle(), "cancelled");
});

test("T1 invalid transitions: rejected, state unchanged, rejection logged", async () => {
  const t = setup();
  await t.create();
  assert.equal(status(await t.send("COMPLETE", { evidenceRef: "e" })), "rejected:denied"); // from unstarted
  await t.send("START");
  assert.equal(status(await t.send("UNBLOCK")), "rejected:denied"); // from in_progress
  await t.send("CANCEL");
  assert.equal(status(await t.send("REOPEN", { reason: "r" })), "rejected:denied"); // from cancelled
  const s = await t.state();
  assert.equal(await t.lifecycle(), "cancelled");
  assert.deepEqual(s.rejections.map((r) => r.code), ["denied", "denied", "denied"]);
});

test("blocking a task needs a reason, like re-opening one (2026-10-20): bare blocks are refused and logged", async () => {
  const t = setup();
  await t.create();
  assert.equal(status(await t.send("BLOCK")), "rejected:guard-failed"); // from unstarted
  assert.equal(status(await t.send("BLOCK", { reason: "  " })), "appended:transition"); // the rule takes whitespace (as for REOPEN); the page shows "no reason given"
  await t.send("UNBLOCK");
  assert.equal(await t.lifecycle(), "in_progress");
  assert.equal(status(await t.send("BLOCK")), "rejected:guard-failed"); // from in progress
  assert.equal(status(await t.send("BLOCK", { reason: 42 })), "rejected:guard-failed");
  assert.equal(await t.lifecycle(), "in_progress");
  assert.equal(status(await t.send("BLOCK", { reason: "waiting on the token decision" })), "appended:transition");
  assert.equal(await t.lifecycle(), "blocked");
  assert.equal(status(await t.send("BLOCK")), "appended:noop"); // already blocked: nothing changes, no reason needed
  const s = await t.state();
  assert.deepEqual(s.rejections.map((r) => [r.code, r.intent.kind === "event" ? r.intent.event : "create"]), [["guard-failed", "BLOCK"], ["guard-failed", "BLOCK"], ["guard-failed", "BLOCK"]]);
});

test("T3 idempotent no-ops: duplicate START/COMPLETE/BLOCK/CANCEL are logged, state changes once", async () => {
  const t = setup();
  await t.create();
  assert.equal(status(await t.send("START")), "appended:transition");
  assert.equal(status(await t.send("START")), "appended:noop");
  await t.send("BLOCK", { reason: "waiting" });
  assert.equal(status(await t.send("BLOCK")), "appended:noop"); // already blocked: a no-op, no reason needed
  await t.send("UNBLOCK");
  await t.send("COMPLETE", { evidenceRef: "e" });
  assert.equal(status(await t.send("COMPLETE", { evidenceRef: "e" })), "appended:noop");
  const s = await t.state();
  assert.deepEqual(s.rejections, []);
  assert.equal((await t.store.readStream(STREAM)).filter((e) => e.type === "node.start").length, 2);
  // CANCEL twice on a fresh node
  const u = setup();
  await u.create();
  await u.send("CANCEL");
  assert.equal(status(await u.send("CANCEL")), "appended:noop");
});

test("T4 done -> cancelled: direct CANCEL denied; via reasoned REOPEN lands cancelled", async () => {
  const t = setup();
  await t.create();
  await t.send("START");
  await t.send("COMPLETE", { evidenceRef: "e" });
  assert.equal(status(await t.send("CANCEL")), "rejected:denied");
  await t.send("REOPEN", { reason: "scope dropped" });
  assert.equal(status(await t.send("CANCEL")), "appended:transition");
  assert.equal(await t.lifecycle(), "cancelled");
});

test("ADD_CHILD on a done node is denied (ruling: re-open first)", async () => {
  const t = setup();
  await t.create();
  await t.send("START");
  assert.equal(status(await t.send("ADD_CHILD")), "appended:noop"); // lifecycle no-op while live
  await t.send("COMPLETE", { evidenceRef: "e" });
  assert.equal(status(await t.send("ADD_CHILD")), "rejected:denied");
});

test("unknown entity, unknown type, unknown event, double create: all rejected and logged", async () => {
  const t = setup();
  assert.equal(status(await t.send("START")), "rejected:unknown-entity");
  assert.equal(status(await t.create()), "appended:created");
  assert.equal(status(await t.create()), "rejected:already-exists");
  assert.equal(status(await t.send("TELEPORT")), "rejected:unknown-event");
  const r = await t.wp.submit({ stream: STREAM, kind: "create", entity: { type: "spaceship", id: "x" } });
  assert.equal(status(r), "rejected:unknown-entity-type");
  assert.equal((await t.state()).rejections.length, 4);
});

test("retried command (same eventId) never lands twice, whether accepted or rejected", async () => {
  const t = setup();
  await t.create();
  const first = await t.send("START", {}, { eventId: "cmd-1" });
  const retry = await t.send("START", {}, { eventId: "cmd-1" });
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.seq, first.seq);
  const bad = await t.send("COMPLETE", {}, { eventId: "cmd-2" });
  const badRetry = await t.send("COMPLETE", {}, { eventId: "cmd-2" });
  assert.deepEqual(badRetry, { status: "duplicate", seq: bad.seq, original: "rejected" });
  assert.equal((await t.store.readStream(STREAM)).length, 3);
});

test("an eventId reused for a different command throws (a corrected command needs a new id)", async () => {
  const t = setup();
  await t.create();
  await t.send("START", {}, { eventId: "cmd-1" });
  await t.send("COMPLETE", {}, { eventId: "cmd-2" }); // rejected: no evidence
  await assert.rejects(t.send("COMPLETE", { evidenceRef: "now-with-proof" }, { eventId: "cmd-2" }), /different command/);
  await assert.rejects(t.send("BLOCK", {}, { eventId: "cmd-1" }), /different command/);
  assert.equal(status(await t.send("COMPLETE", { evidenceRef: "now-with-proof" }, { eventId: "cmd-3" })), "appended:transition");
});

test("10 concurrent actors on one stream: all evaluated in turn, none thrown", async () => {
  const t = setup();
  await t.create();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => t.send("START", {}, { actor: `session-${i}` })),
  );
  assert.equal(results.filter((r) => status(r) === "appended:transition").length, 1); // only the first START moves state
  assert.equal(results.filter((r) => status(r) === "appended:noop").length, 9);
  // 25 concurrent creates of distinct entities all land
  const creates = await Promise.all(
    Array.from({ length: 25 }, (_, i) => t.wp.submit({ stream: STREAM, kind: "create", entity: { type: "node", id: `n${i}` } })),
  );
  assert.ok(creates.every((r) => r.status === "appended"));
});

test("10 WritePath instances on one store share the queue: all concurrent writes land", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  // maxAttempts 1: no retry to hide behind — only a shared queue avoids revision conflicts
  const paths = Array.from({ length: 10 }, () => new WritePath(store, registry, { maxAttempts: 1 }));
  const rs = await Promise.all(
    paths.map((wp, i) => wp.submit({ stream: STREAM, kind: "create", entity: { type: "node", id: `n${i}` } })),
  );
  assert.ok(rs.every((r) => r.status === "appended"));
  assert.equal(fold(await store.readStream(STREAM), registry).entities.length, 10);
});

test("a command mutated after submit() is evaluated as submitted", async () => {
  const t = setup();
  await t.create();
  const cmd: Command = { stream: STREAM, kind: "event", entity: { ...N }, event: "START" };
  const pending = t.wp.submit(cmd);
  (cmd as { event: string }).event = "CANCEL";
  cmd.entity.id = "someone-else";
  assert.equal(status(await pending), "appended:transition");
  assert.deepEqual((await t.store.readStream(STREAM)).map((e) => e.type), ["node.born", "node.start"]);
});

test("concurrent submits with the same eventId: one lands, the rest are duplicates", async () => {
  const t = setup();
  await t.create();
  const rs = await Promise.all(Array.from({ length: 5 }, () => t.send("START", {}, { eventId: "same" })));
  assert.equal(rs.filter((r) => r.status === "appended").length, 1);
  assert.equal(rs.filter((r) => r.status === "duplicate").length, 4);
  assert.equal((await t.store.readStream(STREAM)).length, 2);
});

test("empty eventId and empty actor are refused", async () => {
  const t = setup();
  await assert.rejects(t.wp.submit({ stream: STREAM, kind: "create", entity: N, eventId: "" }), /eventId/);
  await assert.rejects(t.wp.submit({ stream: STREAM, kind: "create", entity: N, actor: "" }), /actor/);
  await assert.rejects(t.store.append(STREAM, [{ eventId: "", type: "x", data: {} }]), /eventId/);
});

test("actor is recorded in metadata", async () => {
  const t = setup();
  await t.create();
  await t.send("START", {}, { actor: "session-7" });
  const [, started] = await t.store.readStream(STREAM);
  assert.equal(started?.metadata.actor, "session-7");
});

test("malformed commands throw instead of being logged", async () => {
  const t = setup();
  await assert.rejects(t.wp.submit({ stream: "$all", kind: "create", entity: N }), /bad stream/);
  await assert.rejects(t.wp.submit({ stream: STREAM, kind: "create", entity: { type: "node", id: "" } }), /entity must be/);
  await assert.rejects(t.wp.submit({ stream: STREAM, kind: "event", entity: N, event: "START", payload: [] as never }), /payload/);
  assert.equal((await t.store.readStream(STREAM)).length, 0);
});

test("lost expectedRevision race: re-read and re-evaluate against the new state", async () => {
  const t = setup();
  await t.create();
  // A store wrapper that lets a rival write land between our read and our append, once.
  let raced = false;
  const racing: EventStore = {
    readStream: (s, o) => t.store.readStream(s, o),
    readAll: (o) => t.store.readAll(o),
    subscribe: (s, h, o) => t.store.subscribe(s, h, o),
    append: async (s, evs, o) => {
      if (!raced) {
        raced = true;
        await t.wp.submit({ stream: STREAM, kind: "event", entity: N, event: "START" }); // rival
      }
      return t.store.append(s, evs, o);
    },
  };
  const wp = new WritePath(racing, t.registry);
  const r = await wp.submit({ stream: STREAM, kind: "event", entity: N, event: "START" });
  // Our START was evaluated as a transition, lost the race, and was re-evaluated as a no-op.
  assert.equal(status(r), "appended:noop");
  assert.deepEqual((await t.store.readStream(STREAM)).map((e) => e.type), ["node.born", "node.start", "node.start"]);
});

test("cross-process race on an EMPTY stream: the loser re-evaluates (create -> already-exists)", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const rival = new WritePath(store, registry); // a second process
  let raced = false;
  const racing: EventStore = {
    readStream: (s, o) => store.readStream(s, o),
    readAll: (o) => store.readAll(o),
    subscribe: (s, h, o) => store.subscribe(s, h, o),
    append: async (s, evs, o) => {
      if (!raced) {
        raced = true;
        await rival.submit({ stream: STREAM, kind: "create", entity: N });
      }
      return store.append(s, evs, o);
    },
  };
  const r = await new WritePath(racing, registry).submit({ stream: STREAM, kind: "create", entity: N });
  assert.equal(status(r), "rejected:already-exists");
  assert.deepEqual((await store.readStream(STREAM)).map((e) => e.type), ["node.born", REJECTED]);
});

test("idea pipeline: no-skip enforced through the write path (approve before propose rejected)", async () => {
  const t = setup();
  const I = { type: "idea", id: "7" };
  const go = (event: string, payload: Record<string, unknown> = {}) =>
    t.wp.submit({ stream: STREAM, kind: "event", entity: I, event, payload });
  await t.wp.submit({ stream: STREAM, kind: "create", entity: I, payload: { text: "Table needs pagination" } });
  assert.equal(status(await go("APPROVE_NODE")), "rejected:denied");
  await go("DRAFT_FILE");
  assert.equal(status(await go("REJECT_FILE")), "rejected:guard-failed"); // reject needs reason
  await go("APPROVE_FILE");
  assert.equal(status(await go("APPROVE_NODE")), "rejected:denied"); // propose first
  await go("PROPOSE_NODE");
  assert.equal(status(await go("APPROVE_NODE")), "appended:transition");
  const s = await t.state();
  assert.equal(s.entities.find((e) => e.key === "idea:7")?.regions.lifecycle, "materialized");
});
