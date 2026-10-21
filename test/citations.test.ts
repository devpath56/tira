// Citation-construction slice S1: check events, the typed citation object and its resolution
// states, and era 3 in shadow. Nothing here refuses a claim on its citation: the write path
// still decides under era 2, and the fold only reports what each citation resolves to.
//
// Claim-class inventory (also docs/citation-claim-inventory.md): node COMPLETE cites a
// machine-check.reported; drop VERIFIED cites a done-test.ran. Exceptions, named not hidden:
// tira's own node COMPLETE (machine close of a drained parent: its evidence is the children,
// no check event precedes it), brief VERIFIED_DONE (the dispatcher's relay of drop.verified,
// H3: it cites the drop's VERIFIED by correlation id, not a check), and idea APPROVE_FILE /
// APPROVE_NODE (a person's approval, no machine check exists to precede it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import type { NewEvent, StoredEvent } from "../src/store/types.ts";
import { defaultRegistry, RULES_ERA, SHADOW_ERA } from "../src/tables/registry.ts";
import { canonicalJson, fold } from "../src/fold/fold.ts";
import { CITATION_STATES, resolveOverLog, type BlobAt, type CitationState } from "../src/fold/citations.ts";
import { GATE, citationShapeOk } from "../src/tables/checks.ts";
import { WritePath, type Command } from "../src/write/write-path.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { doneTestCommand, machineCheckCommand, runDoneTest } from "../src/write/checks.ts";
import { loadScenarios, runScenario } from "../src/scenario/run.ts";
import type { EntityRef } from "../src/fold/types.ts";

const S = "cite";
type DistCmd = Command extends infer C ? (C extends unknown ? Omit<C, "stream"> : never) : never; // keep the create/event union
const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);

// ---------- hand-built logs ----------

// One stored event, as the store would hold it: seq is its position in `log`.
function logOf(rows: { id: string; type: string; entity: { id: string; version?: number }; actor?: string; payload?: Record<string, unknown> }[]): StoredEvent[] {
  return rows.map((r, i) => ({
    eventId: r.id, stream: S, seq: i + 1, streamRevision: i, type: r.type,
    data: { entity: r.entity, payload: r.payload ?? {} },
    metadata: { ...(r.actor ? { actor: r.actor } : {}), era: RULES_ERA },
    recordedAt: "2026-10-21T00:00:00.000Z",
  }));
}
const check = (id: string, node: string, component = "ci", actor = component) =>
  ({ id, type: "machine-check.reported", entity: { id: `run-${id}` }, actor, payload: { node, check: "fetch_metrics", result: "PASS", component } });
const complete = (id: string, node: string, citation?: unknown, actor = "isha") =>
  ({ id, type: "node.complete", entity: { id: node }, actor, payload: { evidenceRef: "api.md", ...(citation === undefined ? {} : { citation }) } });
const doneTest = (id: string, brief: string, version: number, blob = BLOB_A, actor = GATE) =>
  ({ id, type: "done-test.ran", entity: { id: `run-${id}` }, actor, payload: { brief, version, result: "PASS", component: GATE, test: { path: "test/done.test.ts", blob }, commit: "c1" } });
const verified = (id: string, brief: string, version: number, citation?: unknown) =>
  ({ id, type: "drop.verified", entity: { id: brief, version }, actor: "orchestrator", payload: { done_test_result: "PASS", ...(citation === undefined ? {} : { citation }) } });

const stateOf = (log: StoredEvent[], opts: { blobAt?: BlobAt; worker?: string } = {}) => {
  const r = resolveOverLog(log, log.at(-1) as StoredEvent, opts);
  assert.equal(r.length, 1);
  return r[0]!;
};

test("every resolution state is reachable, and a resolving citation says yes", () => {
  const seen = new Set<CitationState>();
  const expect = (want: CitationState, log: StoredEvent[], opts: { blobAt?: BlobAt; worker?: string } = {}) => {
    const r = stateOf(log, opts);
    assert.equal(r.state, want, `${want}: got ${r.state} (${r.detail})`);
    seen.add(r.state);
    return r;
  };
  // resolving: a machine check on this node, before the claim, by another component
  const ok = expect("resolving", logOf([check("m1", "fetch_metrics"), complete("c", "fetch_metrics", { event_id: "m1" })]));
  assert.deepEqual(ok.legs, { exists: "ok", type: "ok", entity: "ok", order: "ok", issuer: "ok", blob: "n/a" });
  assert.equal(ok.result, "PASS");
  // legacy: the claim cites nothing
  expect("legacy", logOf([check("m1", "fetch_metrics"), complete("c", "fetch_metrics")]));
  // dangling: an id the log does not hold, and one that is only a rejected command
  expect("dangling", logOf([check("m1", "fetch_metrics"), complete("c", "fetch_metrics", { event_id: "m9" })]));
  expect("dangling", logOf([{ id: "r1", type: "command.rejected", entity: { id: "x" } }, complete("c", "fetch_metrics", { event_id: "r1" })]));
  // wrong-type: a string is not a citation; a node move and tira's own close are not checks
  expect("wrong-type", logOf([check("m1", "fetch_metrics"), complete("c", "fetch_metrics", "m1")]));
  expect("wrong-type", logOf([{ id: "s", type: "node.start", entity: { id: "fetch_metrics" }, actor: "isha" }, complete("c", "fetch_metrics", { event_id: "s" })]));
  expect("wrong-type", logOf([complete("t", "child", undefined, "tira"), complete("c", "fetch_metrics", { event_id: "t" })]));
  // wrong-entity: the check speaks to another node
  expect("wrong-entity", logOf([check("m1", "improve_visual"), complete("c", "fetch_metrics", { event_id: "m1" })]));
  // post-dated: the check comes after the claim (resolved for the claim at seq 1)
  const later = logOf([complete("c", "fetch_metrics", { event_id: "m1" }), check("m1", "fetch_metrics")]);
  const pd = resolveOverLog(later, later[0] as StoredEvent)[0]!;
  assert.equal(pd.state, "post-dated", pd.detail);
  seen.add(pd.state);
  // self-issued: the worker's own component reported the check
  expect("self-issued", logOf([check("m1", "fetch_metrics", "isha"), complete("c", "fetch_metrics", { event_id: "m1" })]));
  // stale-blob: the file cited is a different blob at that commit
  const blobAt: BlobAt = ({ path }) => (path === "api.md" ? BLOB_B : undefined);
  expect("stale-blob", logOf([complete("c", "fetch_metrics", { repo: "tira", commit: "c1", path: "api.md", blob: BLOB_A })]), { blobAt });
  assert.deepEqual([...seen].sort(), [...CITATION_STATES].sort(), "every state in the spec's state space is proven");
});

test("drop VERIFIED cites a done test: entity is the brief version, the filer can't be the checker, the test blob is a leg", () => {
  const two = (dt: ReturnType<typeof doneTest>, cite = { event_id: dt.id }) => logOf([dt, verified("v", "b", 1, cite)]);
  assert.equal(stateOf(two(doneTest("d", "b", 1))).state, "resolving");
  assert.equal(stateOf(two(doneTest("d", "b", 1))).legs.blob, "unverifiable", "no blob resolver: the leg says so instead of passing");
  assert.equal(stateOf(two(doneTest("d", "b", 2))).state, "wrong-entity", "another version of the brief");
  assert.equal(stateOf(two(doneTest("d", "other", 1))).state, "wrong-entity");
  assert.equal(stateOf(two(doneTest("d", "b", 1, BLOB_A, "s1")), { worker: "s1" }).state, "self-issued", "the drop's filer ran it");
  // the done-test binding is checked against the blob at that commit
  const same: BlobAt = ({ path, commit }) => (path === "test/done.test.ts" && commit === "c1" ? BLOB_A : undefined);
  const edited: BlobAt = ({ path }) => (path === "test/done.test.ts" ? BLOB_B : undefined);
  assert.equal(stateOf(two(doneTest("d", "b", 1)), { blobAt: same }).legs.blob, "ok");
  assert.equal(stateOf(two(doneTest("d", "b", 1)), { blobAt: edited }).state, "stale-blob");
  // a machine check is the wrong type for a drop, and a done test for a node
  assert.equal(stateOf(logOf([check("m1", "b"), verified("v", "b", 1, { event_id: "m1" })])).state, "wrong-type");
  assert.equal(stateOf(logOf([doneTest("d", "b", 1), complete("c", "b", { event_id: "d" })])).state, "wrong-type");
  // a file citation resolves when the blob matches, dangles when the path isn't there
  const file = { repo: "tira", commit: "c1", path: "api.md", blob: BLOB_A };
  assert.equal(stateOf(logOf([complete("c", "n", file)]), { blobAt: () => BLOB_A }).state, "resolving");
  assert.equal(stateOf(logOf([complete("c", "n", file)]), { blobAt: () => undefined }).state, "dangling");
  // a list resolves citation by citation
  const log = logOf([check("m1", "n"), complete("c", "n", [{ event_id: "m1" }, { event_id: "nope" }])]);
  assert.deepEqual(resolveOverLog(log, log.at(-1) as StoredEvent).map((r) => r.state), ["resolving", "dangling"]);
});

// ---------- the fold and the write path ----------

const node = (id: string): EntityRef => ({ type: "node", id });
function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const send = (cmd: DistCmd) => wp.submit({ stream: S, ...cmd } as Command);
  return { store, registry, wp, send, now: async () => fold(await store.readStream(S), registry) };
}

test("the fold reports each cited claim's resolution, in shadow: a dangling citation is still admitted under era 2", async () => {
  const t = setup();
  await t.send({ kind: "create", entity: node("fetch_metrics"), actor: "isha" });
  await t.send({ kind: "event", entity: node("fetch_metrics"), event: "START", actor: "isha" });
  const m = await t.wp.submit(machineCheckCommand({ stream: S, node: "fetch_metrics", check: "contract", result: "PASS", component: "ci", runId: "r1" }));
  assert.equal(m.status, "appended");
  const mId = (await t.store.readStream(S)).find((e) => e.type === "machine-check.reported")?.eventId as string;
  const done = await t.send({ kind: "event", entity: node("fetch_metrics"), event: "COMPLETE", actor: "isha", payload: { evidenceRef: "api.md", citation: { event_id: mId } } });
  assert.equal(done.status, "appended");
  // shadow: a claim citing nothing real is admitted exactly as today
  await t.send({ kind: "create", entity: node("improve_visual"), actor: "isha" });
  await t.send({ kind: "event", entity: node("improve_visual"), event: "START", actor: "isha" });
  const bad = await t.send({ kind: "event", entity: node("improve_visual"), event: "COMPLETE", actor: "isha", payload: { evidenceRef: "x", citation: "see the PR" } });
  assert.equal(bad.status, "appended", "no refusal rule lands in S1");
  const r = await t.now();
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.citations?.[S]?.map((c) => [c.claim, c.era, c.resolutions.map((x) => x.state)]), [
    ["node:fetch_metrics", RULES_ERA, ["resolving"]],
    ["node:improve_visual", RULES_ERA, ["wrong-type"]],
  ]);
  // check events are only well-formed from a named, non-machine component
  for (const bad of [
    { ...machineCheckCommand({ stream: S, node: "n", check: "c", result: "PASS", component: "tira" }), actor: "ci" }, // the write path's own name as the component
    machineCheckCommand({ stream: S, node: "", check: "c", result: "PASS", component: "ci" }),
    { ...machineCheckCommand({ stream: S, node: "n", check: "c", result: "PASS", component: "ci" }), payload: { node: "n", check: "c", result: "ok", component: "ci" } },
  ]) {
    const w = await t.wp.submit(bad);
    assert.ok(w.status === "rejected" && w.code === "guard-failed", JSON.stringify(bad.payload));
  }
});

test("a drop's VERIFIED citing the gate's done test resolves in the fold; the filer is the worker", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const run = (cmd: DistCmd | Command) => d.submit({ stream: S, ...cmd } as Command);
  await run({ kind: "create", entity: { type: "session", id: "s1" }, actor: "s1" });
  await run({ kind: "create", entity: { type: "brief", id: "b", version: 1 }, actor: "orchestrator", payload: { slice_ref: "slice/b", blocked_by: [] } });
  await run({ kind: "event", entity: { type: "brief", id: "b", version: 1 }, event: "DISPATCHED", actor: "orchestrator" });
  await run({ kind: "event", entity: { type: "brief", id: "b", version: 1 }, event: "CLAIMED", actor: "s1", payload: { session: "s1" } });
  await run({ kind: "create", entity: { type: "drop", id: "b", version: 1 }, actor: "s1" });
  await run(doneTestCommand({ stream: S, brief: "b", version: 1, testPath: "test/done.test.ts", result: "PASS", blob: BLOB_A, runId: "g1" }));
  await run(doneTestCommand({ stream: S, brief: "b", version: 1, testPath: "test/done.test.ts", result: "PASS", blob: BLOB_A, runId: "g2" }));
  // the filing session running a done test under its own name: the worker grading itself
  const own = doneTestCommand({ stream: S, brief: "b", version: 1, testPath: "test/done.test.ts", result: "PASS", blob: BLOB_A, runId: "s1-own" });
  await run({ ...own, actor: "s1", payload: { ...own.payload, component: "s1" } });
  const log = await store.readStream(S);
  const [g1, g2, mine] = log.filter((e) => e.type === "done-test.ran").map((e) => e.eventId);
  assert.ok(mine, "the filer's own done test is recorded: it is a fact, only not a check that counts");
  await run({ kind: "event", entity: { type: "drop", id: "b", version: 1 }, event: "VERIFIED", actor: "orchestrator", payload: { done_test_result: "PASS", citation: [{ event_id: g1 }, { event_id: g2 }, { event_id: mine }] } });
  const r = fold(await store.readStream(S), registry);
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.citations?.[S]?.map((c) => [c.claim, c.resolutions.map((x) => x.state)]), [["drop:b@1", ["resolving", "resolving", "self-issued"]]]);
});

test("era 3 is known to replay but never stamped: era-3 rows fold like era 2 for pre-citation streams, every scenario", async () => {
  const registry = defaultRegistry();
  assert.equal(registry.era, RULES_ERA, "new writes are still decided under era 2");
  assert.equal(registry.shadowEra, SHADOW_ERA);
  const all = loadScenarios();
  let scenarios = 0;
  let restamped = 0;
  for (const s of all.values()) {
    if (s.status === "pending" || s.status === "seed") continue;
    const { log } = await runScenario(s, all);
    assert.ok(log.every((e) => e.metadata.era === undefined || e.metadata.era === RULES_ERA), `${s.id}: the write path stamped only era ${RULES_ERA}`);
    const as3 = log.map((e) => (e.metadata.era === RULES_ERA ? (restamped++, { ...e, metadata: { ...e.metadata, era: SHADOW_ERA } }) : e));
    const before = fold(log, registry);
    assert.equal(before.citations, undefined, `${s.id}: a pre-citation stream reports no citations`);
    assert.equal(canonicalJson(fold(as3, registry)), canonicalJson(before), `${s.id}: era 3 folds it the same`);
    scenarios++;
  }
  assert.ok(scenarios >= 20 && restamped > 300, `${scenarios} scenarios, ${restamped} rows restamped`);
});

test("era 3's COMPLETE and VERIFIED accept the citation object by shape only; era 2 ignores it", async () => {
  // shape: absent, one object, or a non-empty list of them; never a string or an empty list
  assert.ok(citationShapeOk({}));
  assert.ok(citationShapeOk({ citation: { event_id: "e" } }));
  assert.ok(citationShapeOk({ citation: [{ event_id: "e" }, { repo: "r", commit: "c", path: "p", blob: BLOB_A }] }));
  for (const bad of ["e", [], [{ event_id: "e" }, "x"], { event_id: "" }, { event_id: "e", extra: 1 }, { repo: "r", commit: "c", path: "p", blob: "HEAD" }]) {
    assert.ok(!citationShapeOk({ citation: bad }), JSON.stringify(bad));
  }
  // the same rows, stamped era 2 and era 3: only era 3 reads the citation's shape
  const rows = (era: number, citation: unknown): NewEvent[] => [
    { eventId: `b${era}`, type: "node.born", data: { entity: { id: "n" }, payload: {} }, metadata: { actor: "isha", era } },
    { eventId: `s${era}`, type: "node.start", data: { entity: { id: "n" }, payload: {} }, metadata: { actor: "isha", era } },
    { eventId: `c${era}`, type: "node.complete", data: { entity: { id: "n" }, payload: { evidenceRef: "x", citation } }, metadata: { actor: "isha", era } },
  ];
  const folded = async (era: number, citation: unknown) => {
    const store = new SqliteEventStore();
    await store.append(S, rows(era, citation));
    return fold(await store.readStream(S), defaultRegistry());
  };
  assert.deepEqual((await folded(RULES_ERA, "a string")).anomalies, []);
  const shadow = await folded(SHADOW_ERA, "a string");
  assert.equal(shadow.anomalies.length, 1);
  assert.match(shadow.anomalies[0]?.problem ?? "", /hasEvidenceRefCitationShape/);
  assert.deepEqual((await folded(SHADOW_ERA, { event_id: "s3" })).anomalies, [], "a typed citation is accepted (resolution is not enforced)");
  // and the drop's VERIFIED, through the registry's era-3 table
  const reg = defaultRegistry();
  assert.equal(reg.resolve("drop", "VERIFIED", SHADOW_ERA)?.table.pairs.find((p) => p.event === "VERIFIED" && p.from === "filed")?.guard, "orchestratorVerifiesPassCitationShape");
  assert.equal(reg.resolve("drop", "VERIFIED")?.table.pairs.find((p) => p.event === "VERIFIED" && p.from === "filed")?.guard, "orchestratorVerifiesPass");
  const g = reg.guards.orchestratorVerifiesPassCitationShape!;
  const ctx = (citation: unknown) => ({ actor: "orchestrator", payload: { done_test_result: "PASS", citation }, entity: { createdBy: "s1" } as never, view: {} as never });
  assert.ok(g(ctx({ event_id: "d" })));
  assert.ok(!g(ctx("d")));
});

// ---------- the done-test event, for real ----------

test("the gate's done-test event binds the test definition it ran by { path, blob } — git's blob of the file as run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-done-test-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(dir, "done.test.mjs"), "process.exit(0)\n");
    const t = setup();
    const pass = await runDoneTest((c) => t.wp.submit(c), { stream: S, brief: "b", version: 1, testPath: "done.test.mjs", command: "node done.test.mjs", cwd: dir, runId: "run-pass" });
    assert.equal(pass.result, "PASS");
    assert.equal(pass.write.status, "appended");
    writeFileSync(join(dir, "done.test.mjs"), "process.exit(3)\n");
    const fail = await runDoneTest((c) => t.wp.submit(c), { stream: S, brief: "b", version: 1, testPath: "done.test.mjs", command: "node done.test.mjs", cwd: dir, runId: "run-fail" });
    assert.deepEqual([fail.result, fail.exitCode], ["FAIL", 3]);
    const ran = (await t.store.readStream(S)).filter((e) => e.type === "done-test.ran");
    const p = (i: number) => (ran[i]?.data as { payload: Record<string, unknown> }).payload;
    assert.equal(ran.length, 2);
    assert.deepEqual(ran.map((e) => e.metadata.actor), [GATE, GATE], "emitted by the gate component");
    assert.deepEqual(p(0).test, { path: "done.test.mjs", blob: execFileSync("git", ["hash-object", "--stdin"], { input: "process.exit(0)\n", encoding: "utf8" }).trim() });
    assert.notEqual((p(1).test as { blob: string }).blob, (p(0).test as { blob: string }).blob, "the second run bound the edited definition");
    assert.deepEqual([p(0).brief, p(0).version, p(0).result, p(1).result], ["b", 1, "PASS", "FAIL"]);
    assert.equal(p(0).commit, git("rev-parse", "HEAD"));
    // the binding is required and checked: no blob, or not a blob id, is refused
    for (const test of [undefined, { path: "done.test.mjs" }, { path: "done.test.mjs", blob: "HEAD" }, { path: "", blob: BLOB_A }]) {
      const cmd = doneTestCommand({ stream: S, brief: "b", version: 1, testPath: "x", result: "PASS", blob: BLOB_A });
      const w = await t.wp.submit({ ...cmd, payload: { ...cmd.payload, test } });
      assert.ok(w.status === "rejected" && w.code === "guard-failed", JSON.stringify(test));
    }
    // resolved with a git blob resolver: the bound definition at that commit
    const verify = { id: "v", type: "drop.verified", entity: { id: "b", version: 1 }, actor: "orchestrator", payload: { done_test_result: "PASS", citation: { event_id: ran[0]!.eventId } } };
    const log = [...ran, ...logOf([verify]).map((e) => ({ ...e, seq: 99 }))];
    const blobAt: BlobAt = ({ path }) => execFileSync("git", ["hash-object", join(dir, path)], { encoding: "utf8" }).trim();
    assert.equal(resolveOverLog(log, log.at(-1) as StoredEvent, { blobAt })[0]?.state, "stale-blob", "the file now on disk is not the definition that ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
