// tira holds the pen (ruling 2026-10-18): when work moves on past a finished branch, tira
// writes the parent's completion itself, labelled as tira's, citing the move. These tests
// are the five acceptance proofs from the ruling, plus the replay check and the two calls
// made with Isha (unstarted parents: start + complete; the last branch stays open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath, type WriteResult } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { MACHINE_ACTOR } from "../src/fold/types.ts";
import type { StoredEvent } from "../src/store/types.ts";
import type { GuardFn } from "../src/tables/table.ts";
import type { EventData } from "../src/fold/events.ts";

const S = "tasktree-dash";

function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent?: string, extra: Record<string, unknown> = {}) =>
    wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: { ...(parent ? { parent_id: parent } : {}), ...extra } });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}, eventId?: string) =>
    wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload, ...(eventId ? { eventId } : {}) });
  const log = () => store.readStream(S);
  const now = async () => fold(await log(), registry);
  const state = async (id: string) => (await now()).entities.find((e) => e.id === id)?.regions.lifecycle;
  const tiraEvents = async () => (await log()).filter((e) => e.metadata.actor === MACHINE_ACTOR);
  return { store, registry, wp, born, send, log, now, state, tiraEvents };
}
type T = ReturnType<typeof setup>;
const st = (r: WriteResult) => (r.status === "rejected" ? `rejected:${r.code}` : r.status === "appended" ? `appended:${r.outcome}` : r.status);
const ok = async (p: Promise<WriteResult>) => {
  const r = await p;
  assert.equal(r.status, "appended", r.status === "rejected" ? `${r.code}: ${r.detail}` : r.status);
  return r;
};
const payload = (e: StoredEvent) => (e.data as unknown as EventData).payload;

// p{c} and q: finish c, and p is drained (finished but still open).
async function drainedP(t: T) {
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.born("q"));
  await ok(t.send("c", "START"));
  await ok(t.send("c", "COMPLETE", { evidenceRef: "c.md" }));
  assert.equal((await t.now()).derived[S]?.["node:p"]?.drained, true);
  assert.deepEqual(await t.tiraEvents(), []); // draining alone writes nothing
}

// No done or cancelled parent ever sits above open work.
async function invariantHolds(t: T) {
  const r = await t.now();
  for (const e of r.entities) {
    if (!["done", "cancelled"].includes(e.regions.lifecycle as string)) continue;
    for (const k of e.tree?.children ?? []) {
      const c = r.entities.find((x) => x.key === k);
      assert.ok(["done", "cancelled"].includes(c?.regions.lifecycle as string), `${e.key} is closed above open ${k}`);
    }
  }
  assert.deepEqual(r.anomalies, []);
}

// ---------- proof 1: tira closes only on a defined log event ----------

test("proof 1a: a late child added after drain, before moving on → nothing closed", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.born("late", "p"));
  assert.deepEqual(await t.tiraEvents(), []);
  assert.equal((await t.now()).derived[S]?.["node:p"]?.drained, false); // un-drained
  await ok(t.send("late", "START")); // work inside p is not "moving on"
  assert.deepEqual(await t.tiraEvents(), []);
});

test("proof 1b: moving on → tira closes the parent, citing the move, in the same append, just ahead of it", async () => {
  const t = setup();
  await drainedP(t);
  const move = await ok(t.send("q", "START", {}, "move-to-q"));
  assert.ok(move.status === "appended");
  assert.deepEqual(move.closedByTira, [{ key: "node:p", seqs: [move.seq - 2, move.seq - 1] }]); // start + complete
  const tira = await t.tiraEvents();
  assert.deepEqual(tira.map((e) => e.type), ["node.start", "node.complete"]); // p was never started (decided: start + complete)
  for (const e of tira) {
    assert.equal(payload(e).trigger, "move-to-q");
    assert.equal(e.metadata.causationId, "move-to-q");
    assert.match(String(payload(e).reason), /work moved on \(START node:q\)/);
  }
  assert.equal(payload(tira[1] as StoredEvent).evidenceRef, "children closed: node:c");
  const all = await t.log();
  assert.equal(all.at(-1)?.eventId, "move-to-q"); // the move lands right after tira's events
  assert.equal(await t.state("p"), "done");
  await invariantHolds(t);
});

test("proof 1c: a late child then moving on → still nothing closed (p has open work)", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.born("late", "p"));
  const move = await ok(t.send("q", "START"));
  assert.equal(move.status === "appended" ? move.closedByTira : "x", undefined);
  assert.deepEqual(await t.tiraEvents(), []);
  assert.equal(await t.state("p"), "unstarted");
  // the rest of the scripted log: finish the late child (p drains again, nothing written),
  // then move on again → now tira closes p, citing that move
  await ok(t.send("q", "COMPLETE", { evidenceRef: "q.md" }));
  await ok(t.send("late", "START"));
  await ok(t.send("late", "COMPLETE", { evidenceRef: "late.md" }));
  assert.deepEqual(await t.tiraEvents(), []);
  await ok(t.born("r"));
  const next = await ok(t.send("r", "START", {}, "move-to-r"));
  assert.deepEqual(next.status === "appended" ? next.closedByTira?.map((c) => c.key) : [], ["node:p"]);
  for (const e of await t.tiraEvents()) assert.equal(payload(e).trigger, "move-to-r");
  await invariantHolds(t);
});

test("REOPEN into in-progress is a move too", async () => {
  const t = setup();
  await ok(t.born("q"));
  await ok(t.send("q", "START"));
  await ok(t.send("q", "COMPLETE", { evidenceRef: "q.md" }));
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("c", "CANCEL")); // p is finished but open
  const reopen = await ok(t.send("q", "REOPEN", { reason: "found a bug" }));
  assert.deepEqual(reopen.status === "appended" ? reopen.closedByTira?.map((c) => c.key) : [], ["node:p"]);
  assert.equal(await t.state("p"), "done");
  await invariantHolds(t);
});

test("tira's start + complete is one close: the one-active rule doesn't block it", async () => {
  // A is in progress (so it is the active task); B finishes while A is active.
  const t = setup();
  await ok(t.born("A"));
  for (const id of ["a1", "a2"]) await ok(t.born(id, "A"));
  await ok(t.born("B"));
  await ok(t.born("b1", "B"));
  await ok(t.send("A", "START"));
  await ok(t.send("b1", "CANCEL"));
  const r = await ok(t.send("a1", "START")); // descending into A is moving on from B
  assert.deepEqual(r.status === "appended" ? r.closedByTira?.map((c) => c.key) : [], ["node:B"]);
  assert.equal(await t.state("B"), "done");
  assert.deepEqual((await t.now()).rejections, []); // nothing refused, tira's included
  await invariantHolds(t);
  // and two parents waiting at once, the unstarted one first in the tree: both close,
  // and the move lands (A is in progress and drained: its close frees the active slot)
  const u = setup();
  await ok(u.born("B"));
  await ok(u.born("b1", "B"));
  await ok(u.born("A"));
  await ok(u.born("a1", "A"));
  await ok(u.born("z"));
  await ok(u.send("A", "START"));
  await ok(u.send("a1", "START"));
  await ok(u.send("a1", "COMPLETE", { evidenceRef: "a1.md" }));
  await ok(u.send("b1", "CANCEL"));
  const z = await ok(u.send("z", "START"));
  assert.deepEqual(z.status === "appended" ? z.closedByTira?.map((c) => c.key) : [], ["node:B", "node:A"]);
  assert.deepEqual((await u.tiraEvents()).map((e) => e.type), ["node.start", "node.complete", "node.complete"]);
  assert.equal(await u.state("z"), "in_progress");
  await invariantHolds(u);
});

test("a close tira can't finish is all or nothing: refused and logged as tira's, the move still lands", async () => {
  const t = setup();
  await drainedP(t);
  // fault injection: make COMPLETE's evidence guard refuse tira, so the start succeeds and the complete fails
  const guards = t.registry.guards as Record<string, GuardFn>;
  const orig = guards.hasEvidenceRef as GuardFn;
  guards.hasEvidenceRef = (ctx) => ctx.actor !== MACHINE_ACTOR && orig(ctx);
  const move = await ok(t.send("q", "START", {}, "move-to-q"));
  assert.equal(move.status === "appended" ? move.closedByTira : "x", undefined);
  const log = await t.log();
  const [refusal, last] = log.slice(-2);
  assert.equal(refusal?.type, "command.rejected");
  assert.equal(refusal?.metadata.actor, MACHINE_ACTOR);
  assert.equal(last?.eventId, "move-to-q");
  const r = await t.now();
  assert.deepEqual(r.rejections.map((x) => [x.code, x.intent.kind === "event" ? x.intent.event : "", x.intent.actor]), [["guard-failed", "COMPLETE", MACHINE_ACTOR]]);
  assert.equal(await t.state("p"), "unstarted"); // its start was dropped with it: no half-open parent
  assert.deepEqual((await t.tiraEvents()).filter((e) => e.type !== "command.rejected"), []);
  assert.deepEqual(r.anomalies, []);
});

test("UNBLOCK into in-progress is a move too; a rejected move makes tira write nothing", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.send("q", "START"));
  await ok(t.send("q", "BLOCK"));
  // a fresh finished branch r{s}, then UNBLOCK q elsewhere is the move that closes r
  await ok(t.born("r"));
  await ok(t.born("s", "r"));
  await ok(t.send("s", "CANCEL"));
  const unblock = await ok(t.send("q", "UNBLOCK"));
  assert.deepEqual(unblock.status === "appended" ? unblock.closedByTira?.map((c) => c.key) : [], ["node:r"]);
  // a move the rules reject (q is already in progress) writes no tira events
  const before = (await t.tiraEvents()).length;
  await ok(t.born("u"));
  await ok(t.born("v", "u"));
  await ok(t.send("v", "CANCEL")); // u is now finished-but-open
  assert.equal(st(await t.send("p", "START")), "rejected:denied"); // p is done: START denied
  assert.equal((await t.tiraEvents()).length, before);
  assert.equal(await t.state("u"), "unstarted");
  // a legal-looking START that the one-active rule refuses (q is active): tira had u's
  // close lined up, and still writes nothing
  await ok(t.born("w"));
  const refused = await t.send("w", "START");
  assert.equal(st(refused), "rejected:gate");
  assert.match(refused.status === "rejected" ? refused.detail : "", /one active task: node:q is already active/);
  assert.equal((await t.tiraEvents()).length, before);
  assert.equal(await t.state("u"), "unstarted");
});

test("only starting work counts as moving on: blocking or cancelling elsewhere writes nothing", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.send("q", "BLOCK"));
  await ok(t.send("q", "CANCEL"));
  assert.deepEqual(await t.tiraEvents(), []);
  assert.equal(await t.state("p"), "unstarted");
  assert.equal((await t.now()).derived[S]?.["node:p"]?.awaitingClose, true);
});

// ---------- proof 2: no side door ----------

test("proof 2: tira trying to close a parent with open work is denied and logged as tira's", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("p", "START"));
  const r = await t.wp.closeAsTira(S, { type: "node", id: "p" }, "fault injection");
  assert.equal(st(r), "rejected:gate");
  const [rej] = (await t.now()).rejections;
  assert.equal(rej?.intent.actor, MACHINE_ACTOR);
  assert.match(rej?.detail ?? "", /subtree not drained: node:p has open children node:c/);
  assert.equal((await t.log()).at(-1)?.metadata.actor, MACHINE_ACTOR);
  assert.equal(await t.state("p"), "in_progress");
});

// ---------- proof 3: the label comes from the caller ----------

test("proof 3: a caller claiming to be tira is refused; a payload claiming it changes nothing", async () => {
  const t = setup();
  await ok(t.born("a"));
  const claim = await t.wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "a" }, event: "START", actor: MACHINE_ACTOR });
  assert.equal(st(claim), "rejected:reserved-actor");
  const stored = (await t.log()).at(-1);
  assert.equal(stored?.metadata.actor, undefined); // the refusal is not written under tira's name
  assert.equal(await t.state("a"), "unstarted");
  const sneaky = await ok(t.send("a", "START", { actor: MACHINE_ACTOR, machine: true, trigger: "x" }));
  assert.equal(sneaky.status, "appended");
  const last = (await t.log()).at(-1);
  assert.equal(last?.metadata.actor, "isha");
  assert.deepEqual(await t.tiraEvents(), []);
  // any casing or spacing that reads as tira is tira's
  for (const actor of ["Tira", "TIRA", " tira ", "ｔｉｒａ", "ti\u200bra", "tir\u0430", "t\u0131ra", "TİRA"]) {
    const r = await t.wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "a" }, event: "COMPLETE", actor, payload: { evidenceRef: "x" } });
    assert.equal(st(r), "rejected:reserved-actor", actor);
  }
  // a retried claim is a duplicate, like any retry
  const c1 = { stream: S, kind: "event" as const, entity: { type: "node", id: "a" }, event: "BLOCK", actor: MACHINE_ACTOR, eventId: "claim-1" };
  assert.equal(st(await t.wp.submit(c1)), "rejected:reserved-actor");
  assert.equal(st(await t.wp.submit(c1)), "duplicate");
  assert.equal((await t.now()).entities.find((e) => e.id === "a")?.lastActor, "isha");
});

// ---------- proof 5: the race ----------

test("proof 5, order A: tira closes first → the late child is refused and logged", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.send("q", "START")); // tira closes p
  const late = await t.born("late", "p");
  assert.equal(st(late), "rejected:denied");
  assert.equal(await t.state("p"), "done");
  await invariantHolds(t);
});

test("proof 5, order B: the late child lands first → tira has nothing to close; a forced close is refused and logged", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.born("late", "p"));
  // through the normal path, p is no longer finished, so moving on plans no close at all
  const move = await ok(t.send("q", "START"));
  assert.equal(move.status === "appended" ? move.closedByTira : "x", undefined);
  assert.deepEqual(await t.tiraEvents(), []);
  // forcing the close anyway (the fault-injection door) is refused by the gate, and logged
  await ok(t.send("q", "COMPLETE", { evidenceRef: "q.md" }));
  await ok(t.send("p", "START")); // so the only thing in the way of COMPLETE is the open child
  const close = await t.wp.closeAsTira(S, { type: "node", id: "p" }, "raced the late child");
  assert.equal(st(close), "rejected:gate");
  assert.equal((await t.now()).rejections.at(-1)?.intent.actor, MACHINE_ACTOR);
  assert.equal(await t.state("p"), "in_progress");
  await invariantHolds(t);
});

// ---------- the two calls made with Isha ----------

test("the last branch of a tree stays open: nowhere to move on to, so tira writes nothing", async () => {
  const t = setup();
  await ok(t.born("root"));
  await ok(t.born("only", "root"));
  await ok(t.send("only", "START"));
  await ok(t.send("only", "COMPLETE", { evidenceRef: "e" }));
  const r = await t.now();
  assert.equal(r.derived[S]?.["node:root"]?.drained, true);
  assert.equal(r.trees[S]?.node?.cursor, null);
  assert.deepEqual(await t.tiraEvents(), []);
  assert.equal(await t.state("root"), "unstarted"); // closes on the next move elsewhere, or by hand
});

test("the closed-by-tira mark survives a repeat click; a retried move adds nothing", async () => {
  const t = setup();
  await drainedP(t);
  const move = await ok(t.send("q", "START", {}, "move-to-q"));
  const n = (await t.log()).length;
  const again = await t.send("q", "START", {}, "move-to-q");
  assert.deepEqual(again, { status: "duplicate", seq: move.seq, original: "appended" });
  assert.equal((await t.log()).length, n);
  assert.equal(st(await t.send("p", "COMPLETE", { evidenceRef: "again" })), "appended:noop");
  assert.equal((await t.now()).derived[S]?.["node:p"]?.closedByTira, true);
});

test("a parent someone already started gets only a complete from tira", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.born("q"));
  await ok(t.send("p", "START"));
  await ok(t.send("c", "START"));
  await ok(t.send("c", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("q", "START"));
  assert.deepEqual((await t.tiraEvents()).map((e) => e.type), ["node.complete"]);
  await invariantHolds(t);
});

// ---------- replay check: tira writes, it never infers ----------

test("a tira close with no move behind it is flagged on replay (tira closes only on a move)", async () => {
  const t = setup();
  await drainedP(t);
  await ok(t.send("p", "START")); // p finished and in progress: COMPLETE is legal by the rules
  await ok(t.wp.closeAsTira(S, { type: "node", id: "p" })); // in-process fault injection
  assert.match((await t.now()).anomalies.map((a) => a.problem).join(" | "), /tira wrote this without citing a move/);
});

test("replay flags tira writes with no move, a wrong move, or a missing trigger", async () => {
  const mk = async () => {
    const t = setup();
    await drainedP(t);
    await ok(t.send("p", "START")); // p open and in progress: a tira COMPLETE is legal by itself
    return t;
  };
  const tiraComplete = (trigger?: string) => ({
    type: "node.complete",
    data: { entity: { id: "p" }, payload: { evidenceRef: "x", reason: "x", ...(trigger ? { trigger } : {}) } },
    metadata: { actor: MACHINE_ACTOR, ...(trigger ? { causationId: trigger } : {}) },
  });
  // 1. no trigger at all
  const a = await mk();
  await a.store.append(S, [tiraComplete()]);
  assert.match((await a.now()).anomalies.map((x) => x.problem).join(" | "), /tira wrote this without citing a move/);
  // 2. cites a move that never comes
  const b = await mk();
  await b.store.append(S, [tiraComplete("ghost")]);
  assert.match((await b.now()).anomalies.map((x) => x.problem).join(" | "), /cites move ghost, but no move follows it/);
  // 3. the next event isn't the cited move
  const c = await mk();
  await c.store.append(S, [tiraComplete("m1"), { eventId: "m2", type: "node.start", data: { entity: { id: "q" }, payload: {} }, metadata: { actor: "isha" } }]);
  assert.match((await c.now()).anomalies.map((x) => x.problem).join(" | "), /cites move m1, but the next event \(seq \d+\) is not a move outside node:p/);
  // 4. the cited move comes next, but isn't starting work
  const e = await mk();
  await e.store.append(S, [tiraComplete("m1"), { eventId: "m1", type: "node.cancel", data: { entity: { id: "q" }, payload: {} }, metadata: { actor: "isha" } }]);
  assert.match((await e.now()).anomalies.map((x) => x.problem).join(" | "), /cites move m1, but the next event \(seq \d+\) is not a move outside node:p/);
  // 5. the cited move is inside the parent tira closed (re-opening it)
  const f = await mk();
  await f.store.append(S, [tiraComplete("m1"), { eventId: "m1", type: "node.reopen", data: { entity: { id: "p" }, payload: { reason: "x" } }, metadata: { actor: "isha" } }]);
  assert.deepEqual((await f.now()).anomalies.map((x) => x.problem), ["tira's write cites move m1, but the next event (seq 8) is not a move outside node:p"]); // the only anomaly: the reopen itself is legal
  // 6. the cited move is refused, or illegal
  const g = await mk();
  await g.store.append(S, [tiraComplete("m1")]);
  assert.equal(st(await g.send("p", "START", {}, "m1")), "rejected:denied"); // p is done
  assert.match((await g.now()).anomalies.map((x) => x.problem).join(" | "), /cites move m1, but the next event \(seq \d+\) is not a move outside node:p/);
  const h = await mk();
  await h.store.append(S, [tiraComplete("m1"), { eventId: "m1", type: "node.complete", data: { entity: { id: "q" }, payload: { evidenceRef: "x" } }, metadata: { actor: "isha" } }]);
  assert.match((await h.now()).anomalies.map((x) => x.problem).join(" | "), /cites move m1, but the next event \(seq \d+\) is not a move outside node:p/);
  // 7. the real thing passes, and replaying to N inside tira's append is not an anomaly
  const d = await mk();
  await d.store.append(S, [tiraComplete("m1"), { eventId: "m1", type: "node.start", data: { entity: { id: "q" }, payload: {} }, metadata: { actor: "isha" } }]);
  const all = await d.log();
  assert.deepEqual(fold(all, d.registry).anomalies, []);
  assert.deepEqual(fold(all, d.registry, { upToSeq: (all.at(-1)?.seq as number) - 1 }).anomalies, []);
});

test("replay gives tira's start the paired treatment only when its complete follows", async () => {
  // A is active; B is finished and unstarted. A lone tira START of B breaks one-active.
  const mk = async () => {
    const t = setup();
    await ok(t.born("A"));
    await ok(t.born("a1", "A"));
    await ok(t.born("B"));
    await ok(t.born("b1", "B"));
    await ok(t.born("L")); // a leaf: never tira's to close
    await ok(t.send("A", "START"));
    await ok(t.send("b1", "CANCEL"));
    return t;
  };
  const tira = (type: string, trigger: string, id = "B", payload: Record<string, unknown> = { evidenceRef: "x" }, actor = MACHINE_ACTOR) => ({
    type, data: { entity: { id }, payload: { ...payload, reason: "x", trigger } }, metadata: { actor, causationId: trigger },
  });
  const problems = async (t: T) => (await t.now()).anomalies.map((x) => x.problem).join(" | ");
  const twoActive = /gate: one active task: node:A is already active/;
  const move = { eventId: "m1", type: "node.start", data: { entity: { id: "a1" }, payload: {} }, metadata: { actor: "isha" } };
  const real = await mk();
  await real.store.append(S, [tira("node.start", "m1"), tira("node.complete", "m1"), move]);
  assert.deepEqual((await real.now()).anomalies, []);
  const lone = await mk();
  await lone.store.append(S, [tira("node.start", "m1"), move]);
  assert.match((await lone.now()).anomalies.map((x) => x.problem).join(" | "), /gate: one active task: node:A is already active/);
  const mismatched = await mk();
  await mismatched.store.append(S, [tira("node.start", "m1"), tira("node.complete", "m2"), move]);
  assert.match(await problems(mismatched), twoActive);
  // forged pairs: the complete is someone else's, or on another node, or refused
  const human = await mk();
  await human.store.append(S, [tira("node.start", "m1"), tira("node.complete", "m1", "B", { evidenceRef: "x" }, "isha"), move]);
  assert.match(await problems(human), twoActive);
  // B's start "paired" with a complete that lands, but on another node (C, finished and
  // in progress under A): B must not get the pair treatment
  const otherNode = setup();
  await ok(otherNode.born("A"));
  await ok(otherNode.born("a1", "A"));
  await ok(otherNode.born("C", "A"));
  await ok(otherNode.born("c1", "C"));
  await ok(otherNode.born("B"));
  await ok(otherNode.born("b1", "B"));
  await ok(otherNode.send("A", "START"));
  await ok(otherNode.send("C", "START"));
  await ok(otherNode.send("c1", "CANCEL"));
  await ok(otherNode.send("b1", "CANCEL"));
  await otherNode.store.append(S, [tira("node.start", "m1"), tira("node.complete", "m1", "C"), move]);
  assert.match(await problems(otherNode), /gate: one active task: node:C is already active/);
  assert.equal(await otherNode.state("B"), "unstarted");
  const refused = await mk();
  await refused.store.append(S, [tira("node.start", "m1"), tira("node.complete", "m1", "B", {}), move]); // no evidence: COMPLETE fails
  assert.match(await problems(refused), twoActive);
  assert.equal(await refused.state("B"), "unstarted"); // the start was not applied on its own
  assert.deepEqual((await refused.now()).trees[S]?.node?.active, ["node:a1"]);
  // a pair on a leaf gets no pair treatment (only finished parents do)...
  const leafWhileBusy = await mk();
  await leafWhileBusy.store.append(S, [tira("node.start", "m1", "L"), tira("node.complete", "m1", "L"), move]);
  assert.match(await problems(leafWhileBusy), twoActive);
  // ...and even with nothing else active, tira only ever closes finished parents
  const leaf = setup();
  await ok(leaf.born("L"));
  await ok(leaf.born("q"));
  const toQ = { eventId: "m1", type: "node.start", data: { entity: { id: "q" }, payload: {} }, metadata: { actor: "isha" } };
  await leaf.store.append(S, [tira("node.start", "m1", "L"), tira("node.complete", "m1", "L"), toQ]);
  assert.match(await problems(leaf), /tira wrote to node:L, which is not a finished parent/);
});

// ---------- the bet: every parent completion is an explicit recorded event ----------

test("every closed parent has its own complete event in the log (zero silent drains)", async () => {
  const t = setup();
  await ok(t.born("dashboard"));
  await ok(t.born("card", "dashboard"));
  await ok(t.born("visual", "card"));
  for (const id of ["colors", "font"]) await ok(t.born(id, "visual"));
  await ok(t.born("table", "dashboard"));
  await ok(t.send("colors", "START"));
  await ok(t.send("colors", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("font", "CANCEL"));
  await ok(t.send("table", "START")); // the only gesture: moving on
  const log = await t.log();
  const r = await t.now();
  const closedParents = r.entities.filter((e) => (e.tree?.children.length ?? 0) > 0 && e.regions.lifecycle === "done");
  assert.deepEqual(closedParents.map((e) => e.id).sort(), ["card", "visual"]);
  for (const p of closedParents) {
    const done = log.find((e) => e.type === "node.complete" && (e.data as unknown as EventData).entity.id === p.id);
    assert.ok(done, `${p.key} has no complete event`);
    assert.equal(done?.metadata.actor, MACHINE_ACTOR);
  }
  await invariantHolds(t);
});
