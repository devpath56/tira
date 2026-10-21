// Health sweeps (src/sweep/sweep.ts): each check on state the fold would never produce
// (so the check is proven to fire), on tampered logs, and on real logs, which sweep clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { canonicalJson, compareCodeUnits, fold } from "../src/fold/fold.ts";
import type { EntityState } from "../src/fold/types.ts";
import type { Command } from "../src/write/write-path.ts";
import { CHECKS, checkStructure, sweep, type CheckId } from "../src/sweep/sweep.ts";

const S = "sweep";
const defined = { definition: "what it is", done_criteria: "how we know" };

function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  type Cmd = Command extends infer C ? (C extends unknown ? Omit<C, "stream"> : never) : never; // keep the create/event union
  const run = (cmd: Cmd) => d.submit({ stream: S, ...cmd } as Command);
  const node = (id: string, parent?: string, payload: Record<string, unknown> = defined) =>
    run({ kind: "create", entity: { type: "node", id }, actor: "isha", payload: { ...payload, ...(parent ? { parent_id: parent } : {}) } });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) =>
    run({ kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  const done = async (id: string) => {
    await send(id, "START");
    await send(id, "COMPLETE", { evidenceRef: `${id}.png` });
  };
  const log = () => store.readStream(S);
  const swept = async (upToSeq?: number) => sweep(await log(), registry, S, upToSeq === undefined ? {} : { upToSeq });
  return { store, registry, node, send, done, log, swept };
}

// app ─ a ─ a1
//     └ b
async function small() {
  const t = setup();
  await t.node("app");
  await t.node("a", "app");
  await t.node("a1", "a");
  await t.node("b", "app");
  return t;
}

const lines = (out: Map<CheckId, { key?: string; detail: string }[]>) =>
  [...out].flatMap(([id, fs]) => fs.map((f) => `${id} ${f.key ?? "-"}: ${f.detail}`)).sort(compareCodeUnits);

// the folded entities of a small tree, as copies to break
async function brokenCopy(edit: (by: Map<string, EntityState>) => void) {
  const t = await small();
  const ents = structuredClone(fold(await t.log(), t.registry).entities);
  const by = new Map(ents.map((e) => [e.key, e]));
  edit(by);
  return lines(checkStructure([...by.values()], t.registry));
}
const tree = (e: EntityState | undefined) => {
  if (!e?.tree) throw new Error("no tree");
  return e.tree;
};

test("a healthy tree sweeps clean: every check runs, in order, and nothing is found", async () => {
  const t = await small();
  await t.done("a1");
  const r = await t.swept();
  assert.deepEqual(r.checks.map((c) => c.id), CHECKS.map((c) => c.id));
  assert.deepEqual(r.checks.map((c) => c.findings.length), CHECKS.map(() => 0));
  assert.deepEqual([r.stream, r.atSeq, r.broken, r.attention], [S, (await t.log()).at(-1)?.seq, 0, 0]);
});

test("orphans: a parent that doesn't exist, isn't a task, or a task with no place in the tree", async () => {
  assert.deepEqual(await brokenCopy((by) => { tree(by.get("node:a1")).parent = "node:gone"; }), [
    "links node:a: lists node:a1, whose parent is node:gone",
    "orphans node:a1: its parent node:gone doesn't exist",
  ]);
  assert.deepEqual(await brokenCopy((by) => {
    by.set("idea:x", { ...(by.get("node:b") as EntityState), type: "idea", key: "idea:x", id: "x" });
    tree(by.get("node:b")).parent = "idea:x";
  }), [
    "links node:app: lists node:b, whose parent is idea:x",
    "orphans node:b: its parent idea:x isn't a node",
  ]);
  assert.deepEqual(await brokenCopy((by) => { delete (by.get("node:b") as EntityState).tree; }), [
    "links node:app: lists node:b, whose parent is none (a root)",
    "orphans node:b: has no place in the tree",
  ]);
});

test("loops: parents that come back round are reported once, from the smallest key; their depths aren't", async () => {
  assert.deepEqual(await brokenCopy((by) => {
    tree(by.get("node:a")).parent = "node:a1"; // a1 → a → a1
  }), [
    "links node:a: names node:a1 as its parent, but node:a1 doesn't list it",
    "links node:app: lists node:a, whose parent is node:a1",
    "loops node:a: parents loop: node:a → node:a1 → node:a",
  ]);
  // a task that names itself
  assert.ok((await brokenCopy((by) => { tree(by.get("node:b")).parent = "node:b"; })).includes("loops node:b: parents loop: node:b → node:b"));
});

test("loops: briefs whose blocked_by loop between current versions; a superseded version's edges don't count", async () => {
  const t = setup();
  const mk = (id: string, deps: string[], version = 1) => ({
    stream: S, type: "brief", id, version, key: `brief:${id}@${version}`, regions: { gate: "draft", claim: "unclaimed", outcome: "open" },
    createdSeq: 1, lastSeq: 1, lastRecordedAt: "", born: { blocked_by: deps },
  }) as EntityState;
  const found = (ents: EntityState[]) => lines(checkStructure(ents, t.registry));
  assert.deepEqual(found([mk("b", ["c"]), mk("c", ["a"]), mk("a", ["b"])]), ["loops brief:a: blocked_by loops: a → b → c → a"]);
  assert.deepEqual(found([mk("b", [], 2), mk("a", ["b"]), mk("b", ["a"])]), []); // b@2 dropped the edge; b@1's doesn't count, in any order
  assert.deepEqual(found([mk("a", ["b"]), mk("b", ["a"]), mk("b", [], 2)]), []);
  assert.deepEqual(found([mk("a", ["a"])]), ["loops brief:a: blocked_by loops: a → a"]);
  assert.deepEqual(found([mk("a", ["nobody"])]), []); // waiting on a brief that doesn't exist yet is not a loop
});

test("links: a parent lists each child once, only children that name it, and every child that does", async () => {
  assert.deepEqual(await brokenCopy((by) => { tree(by.get("node:app")).children.push("node:a"); }), [
    "counts node:a: reached 2 times from the roots", // its children are walked once
    "links node:app: lists node:a twice",
  ]);
  assert.deepEqual(await brokenCopy((by) => { tree(by.get("node:app")).children.push("node:ghost"); }), ["links node:app: lists node:ghost, which doesn't exist"]);
  assert.deepEqual(await brokenCopy((by) => { tree(by.get("node:app")).children = ["node:a"]; }), [
    "counts -: 4 nodes, but only 3 are reached from the roots",
    "links node:b: names node:app as its parent, but node:app doesn't list it",
  ]);
});

test("counts: more than one task in progress, and a parent over the children cap", async () => {
  assert.deepEqual(await brokenCopy((by) => {
    (by.get("node:a1") as EntityState).regions.lifecycle = "in_progress";
    (by.get("node:b") as EntityState).regions.lifecycle = "in_progress";
  }), ["counts -: 2 tasks in progress at once (node:a1, node:b); the gate allows one"]);
  // a parent in progress above the working task is not a second one
  assert.deepEqual(await brokenCopy((by) => {
    (by.get("node:a1") as EntityState).regions.lifecycle = "in_progress";
    (by.get("node:a") as EntityState).regions.lifecycle = "in_progress";
  }), []);
  assert.deepEqual(await brokenCopy((by) => {
    const app = by.get("node:app") as EntityState;
    for (let i = 0; i < 20; i++) {
      const k = `node:x${i}`;
      by.set(k, { ...structuredClone(by.get("node:b") as EntityState), id: `x${i}`, key: k });
      tree(app).children.push(k);
    }
  }), ["counts node:app: has 22 children; the cap is 20"]);
});

test("depth: the recorded depth matches where the task sits, within the cap of 8", async () => {
  assert.deepEqual(await brokenCopy((by) => { tree(by.get("node:a1")).depth = 2; }), ["depth node:a1: records depth 2, but sits at depth 3"]);
  const t = setup();
  const nine = Array.from({ length: 9 }, (_, i) => `n${i + 1}`);
  const ents = nine.map((id, i) => ({
    stream: S, type: "node", id, key: `node:${id}`, regions: { lifecycle: "unstarted" }, createdSeq: i + 1, lastSeq: i + 1, lastRecordedAt: "",
    tree: { ...(i > 0 ? { parent: `node:${nine[i - 1]}` } : {}), children: i < 8 ? [`node:${nine[i + 1]}`] : [], depth: i + 1, kind: "planned" },
  }) as EntityState);
  assert.deepEqual(lines(checkStructure(ents, t.registry)), ["depth node:n9: sits at depth 9; the cap is 8"]);
});

test("closed parents: a done or cancelled task with open work under it", async () => {
  assert.deepEqual(await brokenCopy((by) => { (by.get("node:a") as EntityState).regions.lifecycle = "done"; }), ["closed-parents node:a: is done, but node:a1 is unstarted"]);
  assert.deepEqual(await brokenCopy((by) => {
    (by.get("node:app") as EntityState).regions.lifecycle = "cancelled";
    (by.get("node:a") as EntityState).regions.lifecycle = "cancelled";
    (by.get("node:a1") as EntityState).regions.lifecycle = "done";
  }), ["closed-parents node:app: is cancelled, but node:b is unstarted"]);
});

test("rules: a tampered log (an event that skipped the write path) is broken, with its seq", async () => {
  const t = await small();
  await t.store.append(S, [{ type: "node.complete", data: { entity: { id: "b" }, payload: {} } }]); // no START, no evidence
  const r = await t.swept();
  const rules = r.checks.find((c) => c.id === "rules");
  assert.equal(rules?.findings.length, 1);
  assert.equal(rules?.findings[0]?.seq, 5);
  assert.match(rules?.findings[0]?.detail ?? "", /^node\.complete: denied/);
  assert.equal(r.broken, 1);
});

test("hollow: a task whose birth gives no definition or no done criteria (blank counts as none)", async () => {
  const t = setup();
  await t.node("full");
  await t.node("bare", undefined, {});
  await t.node("half", undefined, { definition: "what it is" });
  await t.node("blank", undefined, { definition: "  ", done_criteria: "how we know" });
  await t.node("typed", undefined, { definition: 42, done_criteria: "how we know" });
  const hollow = (await t.swept()).checks.find((c) => c.id === "hollow");
  assert.deepEqual(hollow?.findings.map((f) => `${f.key}: ${f.detail}`), [
    "node:bare: no definition or done_criteria",
    "node:blank: no definition",
    "node:half: no done_criteria",
    "node:typed: no definition",
  ]);
  assert.equal(hollow?.severity, "attention");
  assert.equal((await t.swept()).broken, 0);
});

test("regrown: work added under a task that was done and re-opened (a leaf too); not under an open parent, even a drained one", async () => {
  const t = await small();
  const seqOf = async (type: string, id: string) => (await t.log()).filter((e) => e.type === type && (e.data.entity as { id: string }).id === id).map((e) => e.seq);
  await t.node("b2", "app"); // app has open work
  await t.done("b");
  await t.send("b", "COMPLETE", { evidenceRef: "b.png" }); // a no-op: b is already done, and was done first at the seq above
  await t.send("b", "REOPEN", { reason: "bigger than it looked" });
  const beforeB1 = (await t.log()).at(-1)?.seq as number;
  await t.node("b1", "b"); // regrown: b was done
  await t.done("b1");
  await t.send("b", "COMPLETE", { evidenceRef: "b.png" });
  await t.node("c", "app"); // app was never done: not regrown
  await t.done("a1"); // a is drained, still open
  await t.node("a2", "a"); // ordinary planning inside an open parent: not regrown
  await t.done("a2");
  await t.done("a");
  await t.send("a", "REOPEN", { reason: "missed a case" });
  const beforeA3 = (await t.log()).at(-1)?.seq as number;
  await t.node("a3", "a"); // regrown: a was done
  const r = await t.swept();
  assert.deepEqual(r.checks.find((c) => c.id === "regrown")?.findings.map((f) => [f.key, f.seq, f.detail]), [
    ["node:a", (await seqOf("node.born", "a3"))[0], `was done at seq ${(await seqOf("node.complete", "a"))[0]}, then node:a3 was added`],
    ["node:b", (await seqOf("node.born", "b1"))[0], `was done at seq ${(await seqOf("node.complete", "b"))[0]}, then node:b1 was added`],
  ]);
  assert.equal(r.broken, 0);
  // as of earlier points in the log
  assert.deepEqual((await t.swept(beforeA3)).checks.find((c) => c.id === "regrown")?.findings.map((f) => f.key), ["node:b"]);
  assert.deepEqual((await t.swept(beforeB1)).checks.find((c) => c.id === "regrown")?.findings, []);
});

test("--at in the middle of tira's close (its START and COMPLETE, before the move they cite) isn't broken", async () => {
  const t = setup();
  await t.node("p");
  await t.node("c", "p");
  await t.node("q");
  await t.send("c", "START");
  await t.send("c", "CANCEL", { reason: "not needed" });
  await t.send("q", "START"); // tira closes p (drained), then the move lands
  const log = await t.log();
  const tira = log.filter((e) => e.metadata.actor === "tira").map((e) => e.seq);
  assert.equal(tira.length, 2);
  for (const at of [...tira, log.at(-1)?.seq as number]) {
    const r = await t.swept(at);
    assert.deepEqual([r.atSeq, r.broken], [at, 0], `as of seq ${at}`);
  }
});

test("hollow: a task born from an idea takes the idea's definition and done criteria", async () => {
  const t = setup();
  type Cmd = Parameters<Dispatcher["submit"]>[0];
  const d = new Dispatcher(t.store, t.registry);
  const idea = (event: string | undefined, payload: Record<string, unknown> = {}) =>
    d.submit((event === undefined
      ? { stream: S, kind: "create", entity: { type: "idea", id: "x" }, actor: "isha", payload }
      : { stream: S, kind: "event", entity: { type: "idea", id: "x" }, event, actor: "isha", payload }) as Cmd);
  await t.node("app");
  await idea(undefined, defined);
  for (const ev of ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"]) await idea(ev);
  const approve = await idea("APPROVE_NODE", { parent_id: "app" });
  assert.deepEqual(approve.handoffs.map((h) => `${h.rule} ${h.key}`), ["F1 node:x"]);
  assert.deepEqual((await t.swept()).checks.find((c) => c.id === "hollow")?.findings, []);
});

test("loops are spelled from their smallest key, however they are entered; other types in a child list are named", async () => {
  // a sits under the loop c → b → c, and the walk enters it at c
  assert.ok((await brokenCopy((by) => {
    tree(by.get("node:a")).parent = "node:c";
    by.set("node:c", { ...structuredClone(by.get("node:b") as EntityState), id: "c", key: "node:c" });
    tree(by.get("node:c")).parent = "node:b";
    tree(by.get("node:b")).parent = "node:c";
  })).includes("loops node:b: parents loop: node:b → node:c → node:b"));
  assert.ok((await brokenCopy((by) => {
    by.set("idea:i", { ...structuredClone(by.get("node:b") as EntityState), type: "idea", id: "i", key: "idea:i" });
    tree(by.get("node:app")).children.push("idea:i");
  })).includes("links node:app: lists idea:i, which isn't a node"));
});

test("no shape of state can hang or crash a sweep: shared child lists, very deep chains", async () => {
  const t = setup();
  const n = (id: string, i: number, extra: Partial<EntityState["tree"]> = {}) => ({
    stream: S, type: "node", id, key: `node:${id}`, regions: { lifecycle: "unstarted" }, createdSeq: i, lastSeq: i, lastRecordedAt: "",
    tree: { children: [], depth: 1, kind: "planned", ...extra },
  }) as EntityState;
  // each task lists the next two: walked once each, not Fibonacci-many times (so d3 is
  // reached twice, by d1 and d2, and its children aren't walked again)
  const dag = Array.from({ length: 24 }, (_, i) => n(`d${i}`, i + 1, { children: [i + 1, i + 2].filter((j) => j < 24).map((j) => `node:d${j}`), ...(i > 0 ? { parent: `node:d${i - 1}` } : {}), depth: i + 1 }));
  const found = lines(checkStructure(dag, t.registry));
  assert.ok(found.includes("counts node:d3: reached 2 times from the roots"), found.join("\n"));
  assert.ok(found.includes("counts node:d23: reached 2 times from the roots"), found.join("\n"));
  // 10,000 deep: reported, not a stack overflow
  const deep = Array.from({ length: 10_000 }, (_, i) => n(`c${i}`, i + 1, { children: i < 9_999 ? [`node:c${i + 1}`] : [], ...(i > 0 ? { parent: `node:c${i - 1}` } : {}), depth: i + 1 }));
  const deepFound = lines(checkStructure(deep, t.registry));
  assert.ok(deepFound.includes("depth node:c9999: sits at depth 10000; the cap is 8"));
});

test("a sweep is deterministic: same log, same bytes; a shuffled copy and other streams change nothing", async () => {
  const t = await small();
  await t.done("a1");
  await t.node("late", "a", {});
  const log = await t.log();
  const other = new SqliteEventStore();
  await new Dispatcher(other, t.registry).submit({ stream: "elsewhere", kind: "create", entity: { type: "node", id: "zz" }, actor: "isha", payload: {} });
  const mixed = [...log, ...(await other.readStream("elsewhere")).map((e) => ({ ...e, seq: e.seq + 1000 }))];
  const once = canonicalJson(sweep(log, t.registry, S));
  assert.equal(canonicalJson(sweep(log, t.registry, S)), once);
  assert.equal(canonicalJson(sweep([...log].reverse(), t.registry, S)), once);
  assert.equal(canonicalJson(sweep(mixed, t.registry, S)), once);
});
