// Track C1 — tree, drain, cursor, and the two same-lifecycle gates, through the real
// write path + store + fold. Scenario names refer to build-plan.md §5; the fixture is
// the dashboard tree from the demo deck (demo/s1–s7 *.d2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath, type WriteResult } from "../src/write/write-path.ts";
import { canonicalJson, fold } from "../src/fold/fold.ts";

const S = "tasktree-dash";

function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent?: string, extra: Record<string, unknown> = {}) =>
    wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: { ...(parent ? { parent_id: parent } : {}), ...extra } });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) =>
    wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  const now = async (upToSeq?: number) => fold(await store.readStream(S), registry, upToSeq === undefined ? {} : { upToSeq });
  const state = async (id: string) => (await now()).entities.find((e) => e.id === id)?.regions.lifecycle;
  const drained = async (id: string) => (await now()).derived[S]?.[`node:${id}`]?.drained;
  const tree = async () => (await now()).trees[S]?.node;
  return { store, registry, wp, born, send, now, state, drained, tree };
}
type T = ReturnType<typeof setup>;
const st = (r: WriteResult) => (r.status === "rejected" ? `rejected:${r.code}` : r.status === "appended" ? `appended:${r.outcome}` : r.status);
const ok = async (p: Promise<WriteResult>) => {
  const r = await p;
  assert.equal(r.status, "appended", r.status === "rejected" ? `${r.code}: ${r.detail}` : r.status);
  return r;
};

// Dashboard tree from the deck: dashboard{metrics_card{fetch_metrics, improve_visual{colors,
// loading_state, font}}, table, filters}, with fetch_metrics already done.
async function dashboard(t: T) {
  await ok(t.born("dashboard"));
  await ok(t.born("metrics_card", "dashboard"));
  await ok(t.born("fetch_metrics", "metrics_card"));
  await ok(t.born("improve_visual", "metrics_card"));
  for (const id of ["colors", "loading_state", "font"]) await ok(t.born(id, "improve_visual"));
  await ok(t.born("table", "dashboard"));
  await ok(t.born("filters", "dashboard"));
  await ok(t.send("fetch_metrics", "START"));
  await ok(t.send("fetch_metrics", "COMPLETE", { evidenceRef: "metrics-api.md" }));
}
async function s1(t: T) {
  await ok(t.send("colors", "START"));
  await ok(t.send("colors", "BLOCK", { reason: "design-tokens" }));
  await ok(t.born("design_tokens", "improve_visual", { kind: "discovered", discovered_during: "colors" }));
  await ok(t.send("design_tokens", "START"));
  await ok(t.send("design_tokens", "COMPLETE", { evidenceRef: "token-spec.md" }));
  await ok(t.send("colors", "UNBLOCK"));
  await ok(t.send("colors", "COMPLETE", { evidenceRef: "palette.png" }));
}
async function s2(t: T) {
  await ok(t.send("loading_state", "START"));
  assert.equal(st(await t.send("loading_state", "COMPLETE")), "rejected:guard-failed");
  await ok(t.send("loading_state", "COMPLETE", { evidenceRef: "spinner.mp4" }));
}
async function s7(t: T) {
  await ok(t.send("font", "START"));
  await ok(t.send("font", "CANCEL"));
  assert.equal(st(await t.send("font", "START")), "rejected:denied");
}

// ---------- births: parent, order, depth, provenance ----------

test("births: node.born with parent; children append at the end; depth from the root", async () => {
  const t = setup();
  await dashboard(t);
  const r = await t.now();
  const iv = r.entities.find((e) => e.id === "improve_visual");
  assert.deepEqual(iv?.tree?.children, ["node:colors", "node:loading_state", "node:font"]);
  assert.equal(iv?.tree?.parent, "node:metrics_card");
  assert.equal(iv?.tree?.depth, 3);
  assert.equal(r.entities.find((e) => e.id === "dashboard")?.tree?.depth, 1);
  assert.deepEqual(r.trees[S]?.node?.roots, ["node:dashboard"]);
  const types = (await t.store.readStream(S)).map((e) => e.type);
  assert.equal(types[0], "node.born");
  assert.ok(!types.includes("node.created"));
  // discovered work lands at the END of the list, not next to what it was found during
  await ok(t.born("design_tokens", "improve_visual", { kind: "discovered", discovered_during: "colors" }));
  const after = (await t.now()).entities.find((e) => e.id === "improve_visual");
  assert.deepEqual(after?.tree?.children, ["node:colors", "node:loading_state", "node:font", "node:design_tokens"]);
});

test("provenance: kind defaults to planned; discovered must name discovered_during; actor recorded", async () => {
  const t = setup();
  await ok(t.born("root"));
  await ok(t.born("a", "root"));
  const r = await t.now();
  assert.deepEqual(r.entities.find((e) => e.id === "a")?.tree?.kind, "planned");
  assert.equal(r.entities.find((e) => e.id === "a")?.createdBy, "isha");
  assert.equal(st(await t.born("b", "root", { kind: "discovered" })), "rejected:bad-provenance");
  assert.equal(st(await t.born("b", "root", { kind: "found" })), "rejected:bad-provenance");
  assert.equal(st(await t.born("b", "root", { kind: "discovered", discovered_during: "ghost" })), "rejected:bad-provenance");
  await ok(t.born("b", "root", { kind: "discovered", discovered_during: "a" }));
  const b = (await t.now()).entities.find((e) => e.id === "b");
  assert.deepEqual(b?.tree, { parent: "node:root", children: [], depth: 2, kind: "discovered", discoveredDuring: "node:a" });
});

test("births: unknown parent, parent in another stream, and duplicate ids are rejected", async () => {
  const t = setup();
  assert.equal(st(await t.born("a", "ghost")), "rejected:unknown-parent");
  await t.wp.submit({ stream: "tasktree-other", kind: "create", entity: { type: "node", id: "elsewhere" } });
  assert.equal(st(await t.born("a", "elsewhere")), "rejected:unknown-parent");
  await ok(t.born("a"));
  assert.equal(st(await t.born("a")), "rejected:already-exists");
});

test("caps (ruling 1): depth 8 and 20 children per parent", async () => {
  const t = setup();
  await ok(t.born("d1"));
  for (let d = 2; d <= 8; d++) await ok(t.born(`d${d}`, `d${d - 1}`));
  const deep = await t.born("d9", "d8");
  assert.equal(st(deep), "rejected:tree-cap");
  assert.match(deep.status === "rejected" ? deep.detail : "", /depth 9 exceeds the cap of 8/);
  await ok(t.born("wide"));
  for (let i = 1; i <= 20; i++) await ok(t.born(`w${i}`, "wide"));
  const extra = await t.born("w21", "wide");
  assert.equal(st(extra), "rejected:tree-cap");
  assert.match(extra.status === "rejected" ? extra.detail : "", /already has 20 children/);
});

// ---------- drain + the COMPLETE gate (ruling A2) ----------

test("drain: a parent drains when every child is done or cancelled; a leaf never drains", async () => {
  const t = setup();
  await dashboard(t);
  assert.equal(await t.drained("colors"), false); // leaf
  assert.equal(await t.drained("improve_visual"), false);
  await s1(t);
  await s2(t);
  assert.equal(await t.drained("improve_visual"), false); // font still open
  await s7(t);
  assert.equal(await t.drained("improve_visual"), true); // done, done, done, cancelled
  assert.equal(await t.drained("metrics_card"), false); // improve_visual itself is still open
});

test("COMPLETE gate: a parent can't complete until every child is done or cancelled", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c1", "p"));
  await ok(t.born("c2", "p"));
  await ok(t.send("p", "START"));
  const early = await t.send("p", "COMPLETE", { evidenceRef: "e" });
  assert.equal(st(early), "rejected:gate");
  assert.match(early.status === "rejected" ? early.detail : "", /subtree not drained: node:p has open children node:c1, node:c2/);
  await ok(t.send("c1", "CANCEL"));
  await ok(t.send("c2", "START"));
  await ok(t.send("c2", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("p", "COMPLETE", { evidenceRef: "children done" }));
  assert.equal(await t.state("p"), "done");
});

// ---------- one active task (ruling A4) ----------

test("one-active gate: a second START elsewhere is rejected; descending into a child is not", async () => {
  const t = setup();
  await ok(t.born("root"));
  for (const id of ["a", "b"]) await ok(t.born(id, "root"));
  await ok(t.born("a1", "a"));
  await ok(t.send("a", "START"));
  assert.deepEqual((await t.tree())?.active, ["node:a"]);
  const other = await t.send("b", "START");
  assert.equal(st(other), "rejected:gate");
  assert.match(other.status === "rejected" ? other.detail : "", /one active task: node:a is already active/);
  await ok(t.send("a1", "START")); // descent: a now has an in_progress descendant
  assert.deepEqual((await t.tree())?.active, ["node:a1"]);
  await ok(t.send("a1", "COMPLETE", { evidenceRef: "e" }));
  assert.deepEqual((await t.tree())?.active, ["node:a"]); // back up to the parent
  // Starting root is work outside a's (now finished) branch, so tira closes a first.
  const up = await ok(t.send("root", "START"));
  assert.deepEqual(up.status === "appended" ? up.closedByTira?.map((c) => c.key) : [], ["node:a"]);
  assert.deepEqual((await t.tree())?.active, ["node:root"]);
  assert.equal(await t.state("a"), "done");
});

test("one-active gate covers UNBLOCK and REOPEN into in_progress, not just START", async () => {
  const t = setup();
  for (const id of ["a", "b"]) await ok(t.born(id));
  await ok(t.send("a", "START"));
  await ok(t.send("a", "BLOCK", { reason: "waiting" }));
  await ok(t.send("b", "START")); // a is blocked, so b may start
  assert.equal(st(await t.send("a", "UNBLOCK")), "rejected:gate"); // ruling: the gate covers UNBLOCK
  await ok(t.send("b", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("a", "UNBLOCK"));
  assert.equal(st(await t.send("b", "REOPEN", { reason: "regression" })), "rejected:gate"); // and REOPEN
  assert.equal(await t.state("b"), "done");
});

// ---------- cursor (ruling A3, leaf-scoped) ----------

test("cursor: first open leaf in DFS order; skips blocked work", async () => {
  const t = setup();
  await dashboard(t);
  assert.equal((await t.tree())?.cursor, "node:colors");
  await ok(t.send("colors", "START"));
  await ok(t.send("colors", "BLOCK", { reason: "waiting" }));
  assert.equal((await t.tree())?.cursor, "node:loading_state"); // blocked is skipped
  await ok(t.send("loading_state", "CANCEL"));
  await ok(t.send("font", "CANCEL"));
  // nothing open is left under improve_visual but blocked colors, so the cursor moves on
  assert.equal((await t.tree())?.cursor, "node:table");
  await ok(t.send("colors", "UNBLOCK"));
  assert.equal((await t.tree())?.cursor, "node:colors");
});

test("cursor: skips parents waiting for tira to close them; null when nothing is left", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.born("q"));
  await ok(t.send("c", "CANCEL"));
  // p is finished (its only child is closed) but still open: tira closes it when work moves
  // on, so the cursor doesn't park on it waiting for a click
  assert.equal((await t.tree())?.cursor, "node:q");
  await ok(t.send("q", "CANCEL"));
  assert.equal((await t.tree())?.cursor, null);
});

// ---------- scenarios ----------

test("S1 interruption: block, discover, resume; cursor returns to loading_state; replay identical", async () => {
  const t = setup();
  await dashboard(t);
  await ok(t.send("colors", "START"));
  await ok(t.send("colors", "BLOCK", { reason: "design-tokens" }));
  await ok(t.born("design_tokens", "improve_visual", { kind: "discovered", discovered_during: "colors" }));
  await ok(t.send("design_tokens", "START"));
  // mid-interruption: the active task is design_tokens; the DFS cursor is the first open leaf
  const mid = await t.tree();
  assert.deepEqual(mid?.active, ["node:design_tokens"]);
  assert.equal(mid?.cursor, "node:loading_state");
  await ok(t.send("design_tokens", "COMPLETE", { evidenceRef: "token-spec.md" }));
  await ok(t.send("colors", "UNBLOCK"));
  await ok(t.send("colors", "COMPLETE", { evidenceRef: "palette.png" }));
  assert.equal(await t.state("colors"), "done");
  assert.equal(await t.state("design_tokens"), "done");
  assert.equal((await t.tree())?.cursor, "node:loading_state");
  const dt = (await t.now()).entities.find((e) => e.id === "design_tokens");
  assert.deepEqual([dt?.tree?.kind, dt?.tree?.discoveredDuring], ["discovered", "node:colors"]);
  const log = await t.store.readStream(S);
  assert.equal(canonicalJson(fold(log, t.registry)), canonicalJson(fold([...log].reverse(), defaultRegistry())));
});

test("S7 false finish: cancel is terminal; improve_visual drains on done-or-cancelled", async () => {
  const t = setup();
  await dashboard(t);
  await s1(t);
  await s2(t);
  await s7(t);
  assert.equal(await t.state("font"), "cancelled");
  assert.equal(await t.drained("improve_visual"), true);
});

test("S3 backtrack: cursor lands on table; moving on there makes tira close the finished chain", async () => {
  const t = setup();
  await dashboard(t);
  await s1(t);
  await s2(t);
  await s7(t);
  const before = await t.now();
  assert.equal(before.trees[S]?.node?.cursor, "node:table"); // as build-plan S3 says
  assert.equal(before.derived[S]?.["node:improve_visual"]?.drained, true);
  assert.equal(before.derived[S]?.["node:metrics_card"]?.drained, false); // improve_visual not closed yet
  // Moving on: tira closes improve_visual, which drains metrics_card, which it closes too.
  const move = await ok(t.send("table", "START"));
  assert.deepEqual(move.status === "appended" ? move.closedByTira?.map((c) => c.key) : [], ["node:improve_visual", "node:metrics_card"]);
  const r = await t.now();
  assert.equal(await t.state("improve_visual"), "done");
  assert.equal(await t.state("metrics_card"), "done");
  assert.equal(r.derived[S]?.["node:metrics_card"]?.drained, true); // drain climbed the chain
  assert.equal(r.derived[S]?.["node:dashboard"]?.drained, false);
  assert.equal(r.trees[S]?.node?.cursor, "node:table");
  assert.deepEqual(r.trees[S]?.node?.active, ["node:table"]);
  assert.deepEqual(r.anomalies, []);
});

test("S4 scope creep: ADD_CHILD under a done branch is denied; after a reasoned REOPEN it lands", async () => {
  const t = setup();
  await dashboard(t); // fetch_metrics is done; metrics_card is not
  const denied = await t.born("cache_metrics", "fetch_metrics");
  assert.equal(st(denied), "rejected:denied");
  assert.match(denied.status === "rejected" ? denied.detail : "", /done \+ ADD_CHILD \(re-open node:fetch_metrics first\)/);
  assert.equal(st(await t.send("fetch_metrics", "REOPEN")), "rejected:guard-failed"); // reason required
  await ok(t.send("fetch_metrics", "REOPEN", { reason: "cache scope added" }));
  await ok(t.born("cache_metrics", "fetch_metrics"));
  const fm = (await t.now()).entities.find((e) => e.id === "fetch_metrics");
  assert.deepEqual(fm?.tree?.children, ["node:cache_metrics"]);
});

test("T7 drained resurrection: no new child under a done parent until it is re-opened; then it un-drains", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("c", "START"));
  await ok(t.send("c", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("p", "START"));
  await ok(t.send("p", "COMPLETE", { evidenceRef: "e" }));
  assert.equal(await t.drained("p"), true);
  assert.equal(st(await t.born("late", "p")), "rejected:denied");
  await ok(t.send("p", "REOPEN", { reason: "missed a case" }));
  await ok(t.born("late", "p"));
  assert.equal(await t.drained("p"), false);
});

test("T8 time travel: cursor and drain at several N match the history", async () => {
  const t = setup();
  await dashboard(t); // seqs 1–10
  const before = (await t.now()).lastSeq;
  await s1(t);
  const at = async (n: number) => (await t.now(n)).trees[S]?.node?.cursor;
  assert.equal(await at(before), "node:colors");
  assert.equal(await at(before + 2), "node:loading_state"); // colors started then blocked
  assert.equal(await at(before + 4), "node:loading_state"); // design_tokens in progress
});

test("one-active: descent works through an unstarted middle node (any depth, not just children)", async () => {
  const t = setup();
  await ok(t.born("root"));
  await ok(t.born("mid", "root"));
  await ok(t.born("leaf", "mid"));
  await ok(t.send("root", "START"));
  await ok(t.send("leaf", "START")); // grandchild of the active root; mid stays unstarted
  assert.deepEqual((await t.tree())?.active, ["node:leaf"]);
});

test("roots keep birth order (not key order) for the DFS cursor", async () => {
  const t = setup();
  await ok(t.born("z"));
  await ok(t.born("a"));
  const tr = await t.tree();
  assert.deepEqual(tr?.roots, ["node:z", "node:a"]);
  assert.equal(tr?.cursor, "node:z");
});

test("provenance is strict: discovered needs an actor; kind null is rejected; no parent_id on non-tree types", async () => {
  const t = setup();
  await ok(t.born("a"));
  const anon = await t.wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "b" }, payload: { parent_id: "a", kind: "discovered", discovered_during: "a" } });
  assert.equal(st(anon), "rejected:bad-provenance");
  assert.equal(st(await t.born("c", "a", { kind: null })), "rejected:bad-provenance");
  const idea = await t.wp.submit({ stream: S, kind: "create", entity: { type: "idea", id: "7" }, payload: { parent_id: "a" } });
  assert.equal(st(idea), "rejected:unknown-parent");
});

// ---------- edge rulings (2026-10-18) ----------

test("a blocked parent's children stay workable — the cursor descends into them (ruling 2026-10-18)", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("p", "START"));
  await ok(t.send("p", "BLOCK", { reason: "waiting" }));
  assert.equal((await t.tree())?.cursor, "node:c");
});

test("no cancelling a parent with open children: close them first (ruling 2026-10-18)", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.born("g", "c"));
  const early = await t.send("c", "CANCEL");
  assert.equal(st(early), "rejected:gate");
  assert.match(early.status === "rejected" ? early.detail : "", /can't cancel node:c while children are open: node:g \(close them first\)/);
  await ok(t.send("g", "CANCEL")); // one by one is fine; the log records each
  await ok(t.send("c", "CANCEL"));
  assert.equal(await t.drained("p"), true);
});

test("no re-opening a task under a done parent: re-open the parent first, with a reason", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("c", "START"));
  await ok(t.send("c", "COMPLETE", { evidenceRef: "e" }));
  await ok(t.send("p", "START"));
  await ok(t.send("p", "COMPLETE", { evidenceRef: "e" }));
  const early = await t.send("c", "REOPEN", { reason: "regression" });
  assert.equal(st(early), "rejected:gate");
  assert.match(early.status === "rejected" ? early.detail : "", /re-open node:p first: node:c sits under a closed parent/);
  await ok(t.send("p", "REOPEN", { reason: "regression found in c" }));
  await ok(t.send("c", "REOPEN", { reason: "regression" }));
  assert.deepEqual([await t.state("p"), await t.state("c")], ["in_progress", "in_progress"]);
});

test("a parent with work in progress under it can't be cancelled", async () => {
  const t = setup();
  await ok(t.born("p"));
  await ok(t.born("c", "p"));
  await ok(t.send("c", "START"));
  assert.equal(st(await t.send("p", "CANCEL")), "rejected:gate");
  assert.deepEqual((await t.tree())?.active, ["node:c"]);
});

test("legacy node.created and gate-breaking direct appends are anomalies on replay", async () => {
  const t = setup();
  for (const id of ["a", "b"]) await ok(t.born(id));
  await ok(t.send("a", "START"));
  // bypass the write path: a second in_progress task, and a pre-C1 birth name
  await t.store.append(S, [{ type: "node.start", data: { entity: { id: "b" }, payload: {} } }]);
  await t.store.append(S, [{ type: "node.created", data: { entity: { id: "c" }, payload: {} } }]);
  const r = await t.now();
  assert.deepEqual(r.anomalies.map((a) => a.problem.split(":")[0]), ["gate", "unknown-entity"]);
  assert.equal(await t.state("b"), "unstarted");
});
