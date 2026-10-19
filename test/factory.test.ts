// Track B1: the factory tables (brief gate / claim / outcome, session, drop) through
// the real write path and dispatcher. The scripted scenarios include both README
// incidents; the property test checks a brief never leaves Devansh's 10 joint
// configurations (B1 §5) under any sequence of commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { loadTable, validateTable, type Table } from "../src/tables/table.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import type { Command, WriteResult } from "../src/write/write-path.ts";
import type { EntityRef } from "../src/fold/types.ts";

const S = "factory";
type DistCmd = Command extends infer C ? (C extends unknown ? Omit<C, "stream"> : never) : never; // keep the create/event union
const brief = (id: string, version = 1): EntityRef => ({ type: "brief", id, version });
const dropRef = (id: string, version = 1): EntityRef => ({ type: "drop", id, version });

function setup() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const run = (cmd: DistCmd) => d.submit({ stream: S, ...cmd } as Command);
  const ev = (entity: EntityRef, event: string, actor: string, payload: Record<string, unknown> = {}) => run({ kind: "event", entity, event, actor, payload });
  const make = (entity: EntityRef, actor: string, payload: Record<string, unknown> = {}) => run({ kind: "create", entity, actor, payload });
  const log = () => store.readStream(S);
  const now = async () => fold(await log(), registry);
  const at = async (ref: EntityRef) => (await now()).entities.find((e) => e.type === ref.type && e.id === ref.id && e.version === ref.version);
  const joint = async (ref: EntityRef) => {
    const b = await at(ref);
    return b ? `${b.regions.gate} × ${b.regions.claim} × ${b.regions.outcome}` : "none";
  };
  // a brief, dispatched, claimed by session `s`
  const claimed = async (id: string, s: string, deps: string[] = []) => {
    await make({ type: "session", id: s }, s);
    await make(brief(id), "orchestrator", { slice_ref: `slice/${id}`, blocked_by: deps });
    await ev(brief(id), "DISPATCHED", "orchestrator");
    await ev(brief(id), "CLAIMED", s, { session: s });
  };
  return { store, registry, d, run, ev, make, log, now, at, joint, claimed };
}
type T = ReturnType<typeof setup>;
const st = (r: { result: WriteResult }) => (r.result.status === "rejected" ? `rejected:${r.result.code}` : r.result.status);
const rules = (r: { handoffs: { rule: string; event: string }[] }) => r.handoffs.map((h) => `${h.rule} ${h.event}`);
const clean = async (t: T) => assert.deepEqual((await t.now()).anomalies, []);

// ---------- the tables ----------

test("the 5 signed-off tables load, validate (captures included) and register with 0 shared events", () => {
  const r = defaultRegistry();
  assert.deepEqual(r.types().map((x) => `${x.type}:${Object.keys(x.regions).join("+")}`), [
    "node:lifecycle", "idea:lifecycle", "brief:gate+claim+outcome", "session:lifecycle", "drop:lifecycle",
  ]);
  assert.equal(r.creationName("brief", 1), "CREATED");
  assert.equal(r.creationName("brief", 2), "REVISED");
  assert.equal(r.creationName("session"), "NAMED");
  assert.equal(r.creationName("drop", 3), "FILED"); // drop versions are independent, never "revised"
  const claim = r.get("brief")?.regions.claim as Table;
  assert.deepEqual(claim.pairs.find((p) => p.from === "unclaimed" && p.event === "CLAIMED")?.capture, { claimant: "payload.session" });
  // captures are checked like everything else in a table
  const bad = (capture: Record<string, string | null>, outcome: "transition" | "denied" = "transition") => () =>
    validateTable({ id: "t", initial: "a", states: ["a", "b"], events: ["GO"], guards: {}, pairs: [
      { from: "a", event: "GO", outcome, ...(outcome === "transition" ? { to: "b" } : {}), capture },
      { from: "b", event: "GO", outcome: "noop" },
    ] });
  assert.throws(bad({ x: "actor" }), /capture x must be null or payload/);
  assert.throws(bad({ X: "payload.x" }), /bad capture field X/);
  assert.throws(bad({ x: "payload.x" }, "denied"), /a denied pair must not capture/);
  assert.ok(loadTable(new URL("../charts/brief-outcome.json", import.meta.url)));
});

// ---------- the happy path ----------

test("a brief end to end: dispatch → claimable (H1), claim, drop → evidence + drop-written (H2), verify PASS → done (H3)", async () => {
  const t = setup();
  await t.make({ type: "session", id: "s1" }, "s1");
  await t.make(brief("b"), "orchestrator", { slice_ref: "slice/b", blocked_by: [] });
  const dispatched = await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  assert.deepEqual(rules(dispatched), ["H1 brief.claimable"]);
  assert.equal(await t.joint(brief("b")), "gated × unclaimed × open");
  await t.ev(brief("b"), "CLAIMED", "s1", { session: "s1" });
  assert.equal(await t.joint(brief("b")), "gated × claimed-silent × open");
  assert.deepEqual((await t.at(brief("b")))?.context, { claim: { claimant: "s1" } });
  const filed = await t.make(dropRef("b"), "s1");
  assert.deepEqual(rules(filed), ["H2 brief.evidence", "H2 brief.drop-written"]);
  const v = await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  assert.deepEqual(rules(v), ["H3 brief.verified-done"]);
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × done-verified");
  // every receiver is the dispatcher's, paired to its first event by correlation id
  const log = await t.log();
  const id = (type: string) => log.find((e) => e.type === type)?.eventId;
  const corr = (type: string) => log.find((e) => e.type === type)?.metadata;
  assert.deepEqual(corr("brief.claimable"), { actor: "dispatcher", correlationId: id("brief.dispatched"), causationId: id("brief.dispatched") });
  assert.equal(corr("brief.evidence")?.correlationId, id("drop.filed"));
  assert.equal(corr("brief.drop-written")?.correlationId, id("drop.filed"));
  assert.equal(corr("brief.verified-done")?.correlationId, id("drop.verified"));
  assert.deepEqual((log.find((e) => e.type === "brief.verified-done")?.data as { payload: unknown }).payload, { done_test_result: "PASS" });
  assert.deepEqual((await t.now()).handoffs, {});
  await clean(t);
});

// ---------- README incident 1: the silent session ----------

test("incident 1: silent ≠ active; only the claimant makes it active; no timeout or VM ends a session; ending releases its briefs (H5)", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make({ type: "session", id: "s2" }, "s2");
  assert.equal(await t.joint(brief("b")), "gated × claimed-silent × open"); // claimed, nothing heard yet
  assert.equal(st(await t.ev(brief("b"), "EVIDENCE", "s2")), "rejected:guard-failed"); // not the claimant
  assert.equal(st(await t.ev(brief("b"), "EVIDENCE", "s1")), "appended");
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × open");
  // a timeout, a VM's guess, or someone else's say-so can't end s1
  assert.equal(st(await t.ev({ type: "session", id: "s1" }, "ENDED", "dispatcher-timer", { declared_by: "timeout" })), "rejected:guard-failed");
  assert.equal(st(await t.ev({ type: "session", id: "s1" }, "ENDED", "vm", { declared_by: "mac-evidence" })), "rejected:guard-failed");
  assert.equal(st(await t.ev({ type: "session", id: "s1" }, "ENDED", "s2", { declared_by: "self" })), "rejected:guard-failed");
  assert.equal((await t.at({ type: "session", id: "s1" }))?.regions.lifecycle, "live");
  // Mac process evidence can: the brief s1 held goes back to unclaimed
  const ended = await t.ev({ type: "session", id: "s1" }, "ENDED", "mac", { declared_by: "mac-evidence" });
  assert.deepEqual(rules(ended), ["H5 brief.released"]);
  assert.equal(await t.joint(brief("b")), "gated × unclaimed × open");
  assert.equal((await t.at(brief("b")))?.context, undefined); // claimant cleared
  // a session that ends after its drop landed doesn't release that brief (only open ones)
  await t.claimed("c", "s3");
  await t.make(dropRef("c"), "s3");
  assert.deepEqual(rules(await t.ev({ type: "session", id: "s3" }, "ENDED", "s3", { declared_by: "self" })), []);
  assert.equal(await t.joint(brief("c")), "gated × claimed-active × dropped-unverified");
  // and another session can now claim it
  assert.equal(st(await t.ev(brief("b"), "CLAIMED", "s2", { session: "s2" })), "appended");
  await clean(t);
});

test("one claim at a time: a second session's claim on a held brief is rejected; nobody claims for someone else", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make({ type: "session", id: "s2" }, "s2");
  assert.equal(st(await t.ev(brief("b"), "CLAIMED", "s2", { session: "s2" })), "rejected:denied");
  const t2 = setup();
  await t2.make({ type: "session", id: "s1" }, "s1");
  await t2.make(brief("c"), "orchestrator");
  await t2.ev(brief("c"), "DISPATCHED", "orchestrator");
  assert.equal(st(await t2.ev(brief("c"), "CLAIMED", "orchestrator", { session: "s1" })), "rejected:guard-failed");
  assert.equal(st(await t2.ev(brief("c"), "CLAIMED", "s1", { session: "s1" })), "appended");
});

// ---------- README incident 2: landed without checks ----------

test("incident 2: dropped ≠ verified; no verify without a PASS; only the orchestrator verifies; a session can't verify its own drop", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make(dropRef("b"), "s1");
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × dropped-unverified"); // landed is not done
  assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "s1", { done_test_result: "PASS" })), "rejected:guard-failed"); // the filer
  assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "FAIL" })), "rejected:guard-failed");
  assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", {})), "rejected:guard-failed");
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × dropped-unverified");
  assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "PASS" })), "appended");
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × done-verified");
  // one drop per version, by identity (A12); roles can't file drops
  assert.equal(st(await t.make(dropRef("b"), "s1")), "rejected:already-exists");
  assert.equal(st(await t.make(dropRef("x"), "orchestrator")), "rejected:guard-failed");
  await clean(t);
});

test("a drop the claimant didn't file is not handed off: it waits for the orchestrator (pending), and the brief stays open", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make({ type: "session", id: "s2" }, "s2");
  const filed = await t.make(dropRef("b"), "s2");
  assert.deepEqual(rules(filed), []);
  assert.equal(await t.joint(brief("b")), "gated × claimed-silent × open");
  assert.deepEqual((await t.now()).handoffs[S]?.map((p) => [p.rule, p.key, p.waitingOn]), [["H2", "brief:b@1", "the orchestrator: s2 doesn't hold brief:b@1"]]);
  // the orchestrator rejects it; nothing to hand off (the brief never had a drop written)
  assert.deepEqual(rules(await t.ev(dropRef("b"), "REJECTED", "orchestrator", { reason: "not the claimant" })), []);
  assert.equal(await t.joint(brief("b")), "gated × claimed-silent × open");
  assert.deepEqual((await t.now()).handoffs, {});
});

// ---------- dependencies, blocks, revisions ----------

test("blocked_by: a dispatched brief waits (pending) until every dependency is verified, then H1 makes it claimable", async () => {
  const t = setup();
  await t.claimed("a", "s1"); // a is the dependency
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  assert.deepEqual(rules(await t.ev(brief("b"), "DISPATCHED", "orchestrator")), []);
  assert.equal(await t.joint(brief("b")), "gated × waiting × open");
  assert.deepEqual((await t.now()).handoffs[S]?.map((p) => [p.rule, p.key, p.waitingOn]), [["H1", "brief:b@1", "verified drops for a"]]);
  await t.make(dropRef("a"), "s1");
  const v = await t.ev(dropRef("a"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  assert.deepEqual(rules(v).sort(), ["H1 brief.claimable", "H3 brief.verified-done"]);
  const log = await t.log();
  const claimable = log.find((e) => e.type === "brief.claimable" && (e.data as { entity: { id: string } }).entity.id === "b");
  assert.equal(claimable?.metadata.correlationId, log.find((e) => e.type === "brief.dispatched" && (e.data as { entity: { id: string } }).entity.id === "b")?.eventId);
  assert.equal(claimable?.metadata.causationId, log.find((e) => e.type === "drop.verified")?.eventId); // what made it due
  await clean(t);
});

test("the orchestrator's block requests: relayed by the dispatcher under the B1 conditions, refused (and logged) otherwise; dependency blocks lift (H6)", async () => {
  const t = setup();
  await t.claimed("a", "s1");
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  const ask = (reason: string, actor = "orchestrator", id = "b") => t.ev(brief(id), "BLOCKED", actor, { block_reason: reason });
  assert.equal(st(await ask("dependency")), "rejected:handoff-refused"); // not dispatched: deny it instead
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  assert.equal(st(await ask("verdict")), "rejected:handoff-refused"); // verdicts need a claim
  assert.equal(st(await ask("defective")), "rejected:handoff-refused"); // only a rejected drop makes it defective
  assert.equal(st(await ask("dependency", "s1")), "rejected:handoff-refused"); // only the orchestrator asks
  const refusal = (await t.now()).rejections.at(-1);
  assert.equal(refusal?.intent.actor, "s1");
  assert.match(refusal?.detail ?? "", /only the orchestrator can ask to block a brief/);
  assert.equal(st(await ask("dependency")), "appended");
  const blocked = (await t.log()).at(-1);
  assert.equal(blocked?.type, "brief.blocked");
  assert.deepEqual({ actor: blocked?.metadata.actor, payload: (blocked?.data as { payload: unknown }).payload }, { actor: "dispatcher", payload: { block_reason: "dependency", requested_by: "orchestrator" } });
  assert.equal(await t.joint(brief("b")), "gated × waiting × blocked");
  // the dependency verifies: H6 lifts the block, H1 makes it claimable
  await t.make(dropRef("a"), "s1");
  const v = await t.ev(dropRef("a"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  assert.deepEqual(rules(v).sort(), ["H1 brief.claimable", "H3 brief.verified-done", "H6 brief.unblocked"]);
  assert.equal(await t.joint(brief("b")), "gated × unclaimed × open");
  await clean(t);
});

test("a rejected drop blocks the brief as defective (H4, A7); a revise supersedes it (C5) and the old version takes no more events", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make(dropRef("b"), "s1");
  assert.deepEqual(rules(await t.ev(dropRef("b"), "REJECTED", "orchestrator", { reason: "tests fail" })), ["H4 brief.blocked"]);
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × blocked");
  assert.deepEqual((await t.at(brief("b")))?.context?.outcome, { block_reason: "defective" });
  assert.equal(st(await t.ev(brief("b"), "UNBLOCKED", "orchestrator")), "rejected:guard-failed"); // not a dependency block
  assert.deepEqual((await t.now()).handoffs, {}); // and nothing waits to lift it: only a revise moves on
  // revise: v2 needs v1, says it supersedes v1, and v1 is closed to events from then on
  assert.equal(st(await t.make(brief("b", 3), "orchestrator")), "rejected:bad-version");
  assert.equal(st(await t.make(brief("b", 2), "orchestrator", { supersedes: 5 })), "rejected:bad-version");
  assert.equal(st(await t.make(brief("b", 2), "orchestrator", { supersedes: 1 })), "appended");
  assert.equal((await t.log()).at(-1)?.type, "brief.revised");
  assert.equal(st(await t.ev(brief("b", 1), "DISPATCHED", "orchestrator")), "rejected:superseded");
  assert.equal(await t.joint(brief("b", 2)), "ungated × waiting × open");
  await t.ev(brief("b", 2), "DISPATCHED", "orchestrator");
  await t.ev(brief("b", 2), "CLAIMED", "s1", { session: "s1" });
  assert.deepEqual(rules(await t.make(dropRef("b", 2), "s1")), ["H2 brief.evidence", "H2 brief.drop-written"]);
  await clean(t);
});

test("births are guarded (C2): the orchestrator creates briefs with a well-formed blocked_by; a session names itself", async () => {
  const t = setup();
  assert.equal(st(await t.make(brief("b"), "s1")), "rejected:guard-failed");
  assert.equal(st(await t.make(brief("b"), "orchestrator", { blocked_by: "a" })), "rejected:guard-failed");
  assert.equal(st(await t.make(brief("b"), "orchestrator", { blocked_by: ["a", "a"] })), "rejected:guard-failed");
  assert.equal(st(await t.make(brief("b"), "orchestrator", { blocked_by: ["b"] })), "rejected:guard-failed");
  assert.equal(st(await t.make({ type: "session", id: "s1" }, "s2")), "rejected:guard-failed");
  assert.equal(st(await t.make({ type: "session", id: "s1" }, "s1")), "appended");
  assert.equal((await t.log()).at(-1)?.type, "session.named");
  // a rename is a logged no-op that records the current name (A11)
  assert.equal(st(await t.ev({ type: "session", id: "s1" }, "RENAMED", "s1", { session: "Cleanup crew" })), "appended");
  assert.deepEqual((await t.at({ type: "session", id: "s1" }))?.context, { lifecycle: { name: "Cleanup crew" } });
});

// ---------- the dispatcher's name and writes ----------

test("only the dispatcher writes receivers: its name is reserved, a forged receiver is rejected, and replay flags an uncalled one", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  for (const actor of ["dispatcher", "Dispatcher", " DISPATCHER"]) {
    assert.equal(st(await t.ev(brief("b"), "CLAIMABLE", actor)), "rejected:reserved-actor", actor);
  }
  assert.equal(st(await t.ev(brief("b"), "CLAIMABLE", "orchestrator")), "rejected:guard-failed");
  assert.equal(await t.joint(brief("b")), "ungated × waiting × open");
  // straight into the store, around the write path: legal by the table, but no rule called for it
  await t.store.append(S, [{ type: "brief.claimable", data: { entity: { id: "b", version: 1 }, payload: {} }, metadata: { actor: "dispatcher", correlationId: "made-up" } }]);
  assert.deepEqual((await t.now()).anomalies.map((a) => a.problem), ["the dispatcher wrote brief.claimable on brief:b@1, but no handoff rule called for it"]);
  // due, but paired to the wrong first event: still flagged (the correlation id is part of the pair)
  const u = setup();
  await u.make(brief("c"), "orchestrator");
  await u.d.writePath.submit({ stream: S, kind: "event", entity: brief("c"), event: "DISPATCHED", actor: "orchestrator" });
  await u.store.append(S, [{ type: "brief.claimable", data: { entity: { id: "c", version: 1 }, payload: {} }, metadata: { actor: "dispatcher", correlationId: "not-the-dispatch" } }]);
  assert.deepEqual((await u.now()).anomalies.map((a) => a.problem), ["the dispatcher wrote brief.claimable on brief:c@1, but no handoff rule called for it"]);
});

test("a crash between the two halves of a pair leaves it due; catchUp finishes it, once", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  // the trigger lands through the bare write path (as if the dispatcher crashed right after)
  await t.d.writePath.submit({ stream: S, kind: "event", entity: brief("b"), event: "DISPATCHED", actor: "orchestrator" });
  assert.deepEqual((await t.now()).handoffs[S]?.map((p) => [p.rule, p.waitingOn]), [["H1", "the dispatcher"]]);
  assert.deepEqual((await t.d.catchUp(S)).map((h) => h.event), ["brief.claimable"]);
  assert.deepEqual(await t.d.catchUp(S), []);
  assert.deepEqual((await t.now()).handoffs, {});
  await clean(t);
});

// ---------- F1: idea -> node (regions proposal done tests 3 and 4) ----------

test("F1: a materialized idea is born as a node with the same id (paired by correlation id); a birth that can't happen yet is pending", async () => {
  const t = setup();
  const idea = { type: "idea", id: "metrics_card" };
  await t.make(idea, "isha");
  for (const event of ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"]) await t.ev(idea, event, "isha");
  const approved = await t.ev(idea, "APPROVE_NODE", "devansh");
  assert.deepEqual(rules(approved), ["F1 node.born"]);
  const r = await t.now();
  assert.equal(r.entities.find((e) => e.key === "idea:metrics_card")?.regions.lifecycle, "materialized");
  assert.equal(r.entities.find((e) => e.key === "node:metrics_card")?.regions.lifecycle, "unstarted");
  const log = await t.log();
  const born = log.find((e) => e.type === "node.born");
  assert.deepEqual((born?.data as { payload: unknown }).payload, { idea_id: "metrics_card" });
  assert.equal(born?.metadata.correlationId, log.find((e) => e.type === "idea.approve-node")?.eventId);
  await clean(t);
  // dangling: approved under a parent that doesn't exist yet -> pending, not an error
  const idea2 = { type: "idea", id: "table" };
  await t.make(idea2, "isha");
  for (const event of ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"]) await t.ev(idea2, event, "isha");
  assert.deepEqual(rules(await t.ev(idea2, "APPROVE_NODE", "devansh", { parent_id: "dashboard" })), []);
  const p = (await t.now()).handoffs[S]?.[0];
  assert.deepEqual([p?.rule, p?.key], ["F1", "node:table"]);
  assert.deepEqual((await t.now()).rejections, []); // the dispatcher doesn't try (and fail) what the rules would refuse
  assert.match(p?.waitingOn ?? "", /a fix: node:dashboard is not in this stream/);
  await clean(t);
  // the parent arrives: the next command catches the pair up
  const parent = await t.make({ type: "node", id: "dashboard" }, "isha");
  assert.deepEqual(rules(parent), ["F1 node.born"]);
  assert.equal((await t.now()).entities.find((e) => e.key === "node:table")?.tree?.parent, "node:dashboard");
});

// ---------- the 10 joint configurations (B1 §5) ----------

// Devansh's 10, as declared with the composition (charts/compositions.json).
import { readFileSync } from "node:fs";
const COMPOSITION = JSON.parse(readFileSync(new URL("../charts/compositions.json", import.meta.url), "utf8")).brief as { regions: string[]; allowed: string[] };
const TEN = new Set(COMPOSITION.allowed);
const projected = (b: { regions: Record<string, string> }) => `${b.regions.gate} × ${b.regions.claim === "waiting" ? "unclaimed" : b.regions.claim} × ${b.regions.outcome}`;

test("the composition declares the brief's regions and exactly 10 allowed configurations, and every one is reachable", async () => {
  assert.deepEqual(COMPOSITION.regions, Object.keys(defaultRegistry().get("brief")?.regions ?? {}));
  assert.equal(TEN.size, 10);
  const t = setup();
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) await t.make({ type: "session", id: s }, s);
  const mk = (id: string, deps: string[] = []) => t.make(brief(id), "orchestrator", { blocked_by: deps });
  const go = (id: string) => t.ev(brief(id), "DISPATCHED", "orchestrator");
  const claim = (id: string, s: string) => t.ev(brief(id), "CLAIMED", s, { session: s });
  const ask = (id: string, block_reason: string) => t.ev(brief(id), "BLOCKED", "orchestrator", { block_reason });
  await mk("ungated");
  await mk("denied"); await t.ev(brief("denied"), "DENIED", "orchestrator", { reason: "not now" });
  await mk("gated"); await go("gated");
  await mk("silent"); await go("silent"); await claim("silent", "s1");
  await mk("active"); await go("active"); await claim("active", "s2"); await t.ev(brief("active"), "EVIDENCE", "s2");
  await mk("landed"); await go("landed"); await claim("landed", "s3"); await t.make(dropRef("landed"), "s3");
  await mk("done"); await go("done"); await claim("done", "s4"); await t.make(dropRef("done"), "s4");
  await t.ev(dropRef("done"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  await mk("waits", ["ungated"]); await go("waits"); await ask("waits", "dependency");
  await mk("silentblock"); await go("silentblock"); await claim("silentblock", "s5"); await ask("silentblock", "verdict");
  await mk("defective"); await go("defective"); await claim("defective", "s6"); await t.make(dropRef("defective"), "s6");
  await t.ev(dropRef("defective"), "REJECTED", "orchestrator", { reason: "tests fail" });
  const reached = new Set((await t.now()).entities.filter((e) => e.type === "brief").map(projected));
  assert.deepEqual([...reached].sort(), [...TEN].sort());
  await clean(t);
});

test("property: under random commands from every actor, a brief never leaves the 10 joint configurations, and replay agrees", async () => {
  let seed = 7; // mulberry32: an LCG's low bits cycle too fast for "% n"
  const rand = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  const pick = <X>(xs: readonly X[]) => xs[rand(xs.length)] as X;
  const seen = new Set<string>();
  for (let run = 0; run < 6; run++) {
    const t = setup();
    const ids = ["a", "b", "c"];
    for (const s of ["s1", "s2"]) await t.make({ type: "session", id: s }, s);
    await t.make(brief("a"), "orchestrator");
    await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
    await t.make(brief("c"), "orchestrator", { blocked_by: ["a", "b"] });
    const actors = ["orchestrator", "s1", "s2", "mac", "user"];
    // mostly the plausible actor (so the walk gets deep), sometimes anyone (so the guards get tested)
    const as = (plausible: string) => (rand(10) < 7 ? plausible : pick(actors));
    for (let i = 0; i < 120; i++) {
      const id = pick(ids);
      const latest = (await t.now()).entities.filter((e) => e.type === "brief" && e.id === id).sort((x, y) => (y.version ?? 0) - (x.version ?? 0))[0];
      const v = latest?.version ?? 1;
      const s = pick(["s1", "s2"]);
      const r = rand(12);
      if (r === 0) await t.ev(brief(id, v), "DISPATCHED", as("orchestrator"));
      else if (r === 1) await t.ev(brief(id, v), "DENIED", as("orchestrator"), { reason: "no" });
      else if (r === 2) await t.ev(brief(id, v), "CLAIMED", as(s), { session: s });
      else if (r === 3) await t.ev(brief(id, v), "EVIDENCE", as(s));
      else if (r === 4) await t.make(dropRef(id, v), as(s));
      else if (r === 5) await t.ev(dropRef(id, v), "VERIFIED", as("orchestrator"), { done_test_result: pick(["PASS", "PASS", "FAIL"]) });
      else if (r === 6) await t.ev(dropRef(id, v), "REJECTED", as("orchestrator"), { reason: "nope" });
      else if (r === 7) await t.ev(brief(id, v), "BLOCKED", as("orchestrator"), { block_reason: pick(["dependency", "verdict", "retries-exhausted", "defective"]) });
      else if (r === 8) await t.ev({ type: "session", id: s }, "ENDED", as(pick([s, "mac", "user"])), { declared_by: pick(["self", "mac-evidence", "user", "timeout"]) });
      else if (r === 9) await t.make(brief(id, v + 1), "orchestrator", { supersedes: v });
      else if (r === 10) await t.ev(brief(id, v), pick(["CLAIMABLE", "RELEASED", "DROP_WRITTEN", "VERIFIED_DONE", "UNBLOCKED"]), pick(actors), { reason: "r" });
      else await t.ev(brief(id, v), "UNBLOCKED", pick(actors));
      for (const b of (await t.now()).entities.filter((e) => e.type === "brief")) {
        const j = projected(b);
        assert.ok(TEN.has(j), `${b.key} reached ${j}`);
        seen.add(j);
      }
    }
    await clean(t);
  }
  assert.ok(seen.size >= 7, `only ${seen.size} configurations visited: ${[...seen].join(" | ")}`); // the walk isn't vacuous
});

// ---------- D2: the page's Lanes view ----------

test("D2 page: a factory stream opens on Lanes — one lane per region, captured data, handoff pairs by correlation id, what's waiting", async () => {
  const { renderHtml } = await import("../src/render/html.ts");
  const t = setup();
  await t.claimed("api", "s1");
  await t.make(brief("ui"), "orchestrator", { blocked_by: ["api"] });
  await t.ev(brief("ui"), "DISPATCHED", "orchestrator");
  await t.make(dropRef("api"), "s1");
  const log = await t.log();
  const r = fold(log, t.registry);
  const html = renderHtml(r, S, "h", log);
  assert.match(html, /<input class="view-radio" type="radio" name="view" id="v-lanes" checked/);
  // every region of every brief, with the fold's state
  for (const b of r.entities.filter((e) => e.type === "brief")) {
    for (const [region, state] of Object.entries(b.regions)) {
      assert.match(html, new RegExp(`data-lane="${b.key}" data-region="${region}" data-state="${state}"`), `${b.key} ${region}`);
    }
  }
  assert.match(html, /data-region="claim" data-state="claimed-active"><span class="pill work">claimed-active<\/span><span class="cap" title="claimed by s1">/);
  // the pair: drop.filed -> evidence + drop-written, same correlation id on both sides
  const filed = log.find((e) => e.type === "drop.filed");
  assert.match(html, new RegExp(`<li data-correlation="${filed?.eventId}"><code>drop.filed</code> drop:api@1 [^]*?brief.evidence[^]*?brief.drop-written`));
  assert.match(html, /<li class="waiting"><code>H1<\/code> brief:ui@1 [^]*?verified drops for api<\/li>/);
  // the header counts verified briefs and handoffs, not tree nodes
  assert.match(html, /<div class="big" title="verified briefs, of those current">0<small>\/2<\/small><\/div>/);
  assert.match(html, /<b>2<\/b> handoffs<\/li><li title="handoffs still waiting"><b>1<\/b> waiting<\/li>/);
  // a tree stream still opens on the tree, with an empty Lanes view
  const tree = renderHtml(fold([], t.registry), "tasktree-x", "h", []);
  assert.match(tree, /id="v-log" checked/); // nothing at all: activity
});

// ---------- found by the adversarial review ----------

test("concurrent commands on one stream: each receiver is written exactly once, and replay finds nothing to flag", async () => {
  const t = setup();
  const ids = ["a", "b", "c", "d", "e"];
  await t.make({ type: "session", id: "s1" }, "s1");
  for (const id of ids) await t.make(brief(id), "orchestrator");
  const other = new Dispatcher(t.store, t.registry); // a second dispatcher on the same store
  await Promise.all(ids.flatMap((id, n) => [
    (n % 2 ? other : t.d).submit({ stream: S, kind: "event", entity: brief(id), event: "DISPATCHED", actor: "orchestrator" }),
    t.d.submit({ stream: S, kind: "event", entity: { type: "session", id: "s1" }, event: "RENAMED", actor: "s1", payload: { session: `n${n}` } }),
  ]));
  const claimables = (await t.log()).filter((e) => e.type === "brief.claimable");
  assert.equal(claimables.length, ids.length);
  await clean(t);
});

test("a drop for a superseded brief version is refused, so it can't satisfy a dependent", async () => {
  const t = setup();
  await t.claimed("a", "s1");
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  await t.make(brief("a", 2), "orchestrator", { supersedes: 1 });
  assert.equal(st(await t.make(dropRef("a", 1), "s1")), "rejected:superseded");
  assert.equal(await t.joint(brief("b")), "gated × waiting × open");
});

test("a claim by a session that was never named is listed: nothing can end that session to release the brief", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  await t.ev(brief("b"), "CLAIMED", "ghost", { session: "ghost" });
  assert.deepEqual((await t.now()).handoffs[S]?.map((p) => [p.rule, p.key]), [["H5", "brief:b@1"]]);
  assert.match((await t.now()).handoffs[S]?.[0]?.waitingOn ?? "", /ghost: it claimed this brief but was never named/);
});

test("a retried command (same event id) after a crash catches the pair up", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  const cmd = { stream: S, kind: "event" as const, entity: brief("b"), event: "DISPATCHED", actor: "orchestrator", eventId: "dispatch-b" };
  await t.d.writePath.submit(cmd); // the trigger landed; the dispatcher died before H1
  const retry = await t.d.submit(cmd);
  assert.equal(retry.result.status, "duplicate");
  assert.deepEqual(rules(retry), ["H1 brief.claimable"]);
  await clean(t);
});

test("pending also lists: a verified drop on a brief blocked meanwhile, and an idea whose node id is taken", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make(dropRef("b"), "s1");
  await t.ev(brief("b"), "BLOCKED", "orchestrator", { block_reason: "verdict" });
  await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  const idea = { type: "idea", id: "taken" };
  await t.make({ type: "node", id: "taken" }, "isha");
  await t.make(idea, "isha");
  for (const event of ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE", "APPROVE_NODE"]) await t.ev(idea, event, "isha");
  assert.deepEqual((await t.now()).handoffs[S]?.map((p) => [p.rule, p.key, p.waitingOn.replace(/:.*/, "")]), [
    ["H3", "brief:b@1", "a fix"],
    ["F1", "node:taken", "a fix"],
  ]);
});

test("guards read no other region and no other entity: their source never touches the view or another region's states", () => {
  const r = defaultRegistry();
  for (const type of ["brief", "session", "drop"]) {
    const def = r.get(type);
    for (const [region, table] of Object.entries(def?.regions ?? {})) {
      const others = Object.entries(def?.regions ?? {}).filter(([n]) => n !== region).flatMap(([, t]) => t.states);
      for (const g of Object.keys(table.guards)) {
        const src = String(r.guards[g]);
        assert.doesNotMatch(src, /\bview\b/, `${g} reads the view`);
        for (const st of others) assert.ok(!src.includes(`"${st}"`), `${g} names ${st}, a state of another region`);
      }
    }
  }
});

test("the reserved names also catch Cyrillic lookalikes and control characters", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  for (const actor of ["disраtсhеr", "dispatcher\u0000", "tira\u0000", "tіrа"]) {
    assert.equal(st(await t.ev(brief("b"), "DISPATCHED", actor)), "rejected:reserved-actor", JSON.stringify(actor));
  }
});

test("a race that makes a due receiver unacceptable skips it: the dispatcher never logs a rejection under its own name", async () => {
  for (let n = 0; n < 6; n++) {
    const t = setup();
    // p is finished but open; idea x was approved under p, and the dispatcher died before F1
    await t.make({ type: "node", id: "p" }, "isha");
    await t.make({ type: "node", id: "c" }, "isha", { parent_id: "p" });
    await t.make({ type: "node", id: "q" }, "isha");
    await t.ev({ type: "node", id: "c" }, "CANCEL", "isha");
    const idea = { type: "idea", id: "x" };
    await t.d.writePath.submit({ stream: S, kind: "create", entity: idea, actor: "isha" });
    for (const event of ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"]) await t.d.writePath.submit({ stream: S, kind: "event", entity: idea, event, actor: "isha" });
    await t.d.writePath.submit({ stream: S, kind: "event", entity: idea, event: "APPROVE_NODE", actor: "isha", payload: { parent_id: "p" } });
    // catching up races a move that makes tira close p (a done parent takes no child)
    await Promise.all([t.d.catchUp(S), t.d.submit({ stream: S, kind: "event", entity: { type: "node", id: "q" }, event: "START", actor: "isha" })]);
    const r = await t.now();
    assert.deepEqual(r.rejections.filter((x) => x.intent.actor === "dispatcher"), [], `run ${n}`);
    assert.deepEqual(r.anomalies, []);
  }
});
