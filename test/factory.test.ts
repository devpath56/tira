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
import { compareCodeUnits, fold } from "../src/fold/fold.ts";
import type { Command, WriteResult } from "../src/write/write-path.ts";
import type { EntityRef } from "../src/fold/types.ts";
import { PASS, verifies } from "../src/tables/factory.ts";
import { filesMatching, srcCode } from "./src-text.ts";

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

test("the factory tables load, validate (captures included) and register with 0 shared events", () => {
  const r = defaultRegistry();
  assert.deepEqual(r.types().map((x) => `${x.type}:${Object.keys(x.regions).join("+")}`), [
    "node:lifecycle", "idea:lifecycle", "brief:gate+claim+outcome", "session:lifecycle", "refusal:lifecycle", "override:lifecycle", "drop:lifecycle", "label:lifecycle",
    "workspace:lifecycle", "jira-issue:lifecycle", "pr:lifecycle", // workspace links (links.ts)
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
  // a no-op may carry a guard (who may record it); a denied pair may not
  const guarded = (outcome: "noop" | "denied") => () =>
    validateTable({ id: "t", initial: "a", states: ["a"], events: ["GO"], guards: { g: "who" }, pairs: [{ from: "a", event: "GO", outcome, guard: "g" }] });
  assert.doesNotThrow(guarded("noop"));
  assert.throws(guarded("denied"), /a denied pair must not carry a guard/);
  // the session table's rename is that guarded no-op
  const rename = (r.get("session")?.regions.lifecycle as Table).pairs.find((p) => p.from === "live" && p.event === "RENAMED");
  assert.deepEqual([rename?.outcome, rename?.guard], ["noop", "renamedByAllowed"]);
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
  assert.deepEqual(corr("brief.claimable"), { actor: "dispatcher", correlationId: id("brief.dispatched"), causationId: id("brief.dispatched"), era: 3 }); // decided under today's rules era
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
  assert.deepEqual(rules(v).sort(compareCodeUnits), ["H1 brief.claimable", "H3 brief.verified-done"]);
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
  assert.deepEqual(rules(v).sort(compareCodeUnits), ["H1 brief.claimable", "H3 brief.verified-done", "H6 brief.unblocked"]);
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
  assert.deepEqual([...reached].sort(compareCodeUnits), [...TEN].sort(compareCodeUnits));
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
  assert.match(html, /title="brief:ui@1" data-frontier="false">ui@1<span class="needs">needs api<\/span>/);
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

test("only a named session claims a brief or files a drop (ruling 2026-10-18: the hole is closed)", async () => {
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  const ghost = await t.ev(brief("b"), "CLAIMED", "ghost", { session: "ghost" });
  assert.equal(st(ghost), "rejected:unknown-ref");
  assert.match(ghost.result.status === "rejected" ? ghost.result.detail : "", /session ghost doesn't exist: name it first/);
  assert.equal(await t.joint(brief("b")), "gated × unclaimed × open");
  assert.equal(st(await t.make(dropRef("b"), "ghost")), "rejected:unknown-ref");
  // once named, the same session can claim and file
  await t.make({ type: "session", id: "ghost" }, "ghost");
  assert.equal(st(await t.ev(brief("b"), "CLAIMED", "ghost", { session: "ghost" })), "appended");
  assert.equal(st(await t.make(dropRef("b"), "ghost")), "appended");
  assert.deepEqual((await t.now()).handoffs, {});
  // a log that claims for an unnamed session around the write path is flagged on replay, and not applied
  const u = setup();
  await u.make(brief("c"), "orchestrator");
  await u.ev(brief("c"), "DISPATCHED", "orchestrator");
  await u.store.append(S, [{ type: "brief.claimed", data: { entity: { id: "c", version: 1 }, payload: { session: "ghost" } }, metadata: { actor: "ghost" } }]);
  const r = await u.now();
  assert.match(r.anomalies[0]?.problem ?? "", /unknown-ref: session ghost doesn't exist/);
  assert.equal(r.entities.find((e) => e.key === "brief:c@1")?.regions.claim, "unclaimed");
});

test("a session is renamed only by itself, the orchestrator, or Mac evidence (ruling 2026-10-18)", async () => {
  const t = setup();
  for (const s of ["s1", "s2"]) await t.make({ type: "session", id: s }, s);
  const rename = (actor: string, name: string) => t.ev({ type: "session", id: "s1" }, "RENAMED", actor, { session: name });
  assert.equal(st(await rename("s2", "hijacked")), "rejected:guard-failed");
  assert.equal(st(await rename("user", "hijacked")), "rejected:guard-failed");
  assert.deepEqual((await t.at({ type: "session", id: "s1" }))?.context, undefined);
  for (const [actor, name] of [["s1", "Cleanup crew"], ["orchestrator", "Cleanup crew 2"], ["mac", "Cleanup crew 3"]]) {
    const r = (await rename(actor as string, name as string)).result;
    assert.equal(r.status === "appended" ? r.outcome : r.status, "noop", actor); // a logged no-op that records the name
  }
  assert.deepEqual((await t.at({ type: "session", id: "s1" }))?.context, { lifecycle: { name: "Cleanup crew 3" } });
  await clean(t);
});

test("a drop filed while its session ends mid-handoff: the drop wins (the dispatcher hands off the drop before the release)", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  // the drop lands, then the session ends, both before the dispatcher has caught up
  await t.d.writePath.submit({ stream: S, kind: "create", entity: dropRef("b"), actor: "s1" });
  await t.d.writePath.submit({ stream: S, kind: "event", entity: { type: "session", id: "s1" }, event: "ENDED", actor: "s1", payload: { declared_by: "self" } });
  assert.deepEqual((await t.d.catchUp(S)).map((h) => `${h.rule} ${h.event}`), ["H2 brief.evidence", "H2 brief.drop-written"]);
  assert.equal(await t.joint(brief("b")), "gated × claimed-active × dropped-unverified"); // not released
  await clean(t);
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

// ---------- the dependency graph (G7) and the frontier (G9) ----------

test("blocked_by never loops: a birth or revision that would close a loop is rejected, with the loop spelled out", async () => {
  const t = setup();
  await t.make(brief("a"), "orchestrator");
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  await t.make(brief("c"), "orchestrator", { blocked_by: ["b"] });
  const loop = await t.make(brief("a", 2), "orchestrator", { supersedes: 1, blocked_by: ["c"] });
  assert.equal(st(loop), "rejected:cycle");
  assert.match(loop.result.status === "rejected" ? loop.result.detail : "", /blocked_by would loop: a → c → b → a/);
  // forward references are fine until they close a loop
  assert.equal(st(await t.make(brief("x"), "orchestrator", { blocked_by: ["y"] })), "appended");
  assert.equal(st(await t.make(brief("y"), "orchestrator", { blocked_by: ["x"] })), "rejected:cycle");
  // a revision replaces the old version's edges: a@2 may drop a dependency without a false loop
  assert.equal(st(await t.make(brief("c", 2), "orchestrator", { supersedes: 1, blocked_by: [] })), "appended");
  assert.equal(st(await t.make(brief("a", 2), "orchestrator", { supersedes: 1, blocked_by: ["c"] })), "appended");
  await clean(t);
});

test("the frontier: gated, unclaimed, open briefs whose every dependency is verified, in birth order", async () => {
  const t = setup();
  const front = async () => (await t.now()).frontier[S];
  await t.make({ type: "session", id: "s1" }, "s1");
  await t.make(brief("a"), "orchestrator");
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  await t.make(brief("c"), "orchestrator");
  assert.deepEqual(await front(), []); // nothing dispatched yet
  for (const id of ["a", "b", "c"]) await t.ev(brief(id), "DISPATCHED", "orchestrator");
  assert.deepEqual(await front(), ["brief:a@1", "brief:c@1"]); // b waits for a
  assert.deepEqual((await t.now()).derived[S]?.["brief:b@1"]?.waitingOn, ["a"]);
  await t.ev(brief("c"), "CLAIMED", "s1", { session: "s1" });
  assert.deepEqual(await front(), ["brief:a@1"]); // claimed work leaves the frontier
  await t.ev(brief("a"), "CLAIMED", "s1", { session: "s1" });
  await t.make(dropRef("a"), "s1");
  await t.ev(dropRef("a"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  assert.deepEqual(await front(), ["brief:b@1"]);
  assert.deepEqual((await t.now()).derived[S]?.["brief:b@1"]?.waitingOn, []);
  // on the page: the frontier is marked, and so is what a brief still needs
  const { renderHtml } = await import("../src/render/html.ts");
  const log = await t.log();
  const html = renderHtml(fold(log, t.registry), S, "h", log);
  assert.match(html, /title="brief:b@1" data-frontier="true">b@1<span class="ready">claimable now<\/span>/);
  // a superseded version leaves the frontier (its revision starts ungated)
  await t.make(brief("b", 2), "orchestrator", { supersedes: 1, blocked_by: ["a"] });
  assert.deepEqual(await front(), []);
  // a tree stream has no frontier
  assert.equal(fold([], t.registry).frontier["tasktree-x"], undefined);
});

test("a tampered log can't put a brief on the frontier before its dependencies are verified", async () => {
  const t = setup();
  await t.make(brief("a"), "orchestrator");
  await t.make(brief("b"), "orchestrator", { blocked_by: ["a"] });
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  // a forged claimable, straight into the store: replay flags it, and the frontier still holds b back
  await t.store.append(S, [{ type: "brief.claimable", data: { entity: { id: "b", version: 1 }, payload: {} }, metadata: { actor: "dispatcher", correlationId: "forged" } }]);
  const r = await t.now();
  assert.match(r.anomalies[0]?.problem ?? "", /no handoff rule called for it/);
  assert.equal(r.entities.find((e) => e.key === "brief:b@1")?.regions.claim, "unclaimed");
  assert.deepEqual(r.frontier[S], []);
});

// ---------- B2: factory transitions write their events (ruling 2026-10-19) ----------

test("the fx: key rule: fx: + sha256 of the transition's canonical JSON; same transition, same key", async () => {
  const { fxKey } = await import("../src/write/fxkey.ts");
  const { createHash } = await import("node:crypto");
  const t1 = { stream: S, entity: brief("b"), event: "DISPATCHED", actor: "orchestrator", payload: {} };
  const body = '{"actor":"orchestrator","entity":{"id":"b","type":"brief","version":1},"event":"DISPATCHED","payload":{},"stream":"factory"}';
  assert.equal(fxKey(t1), `fx:${createHash("sha256").update(body).digest("hex")}`);
  assert.equal(fxKey({ ...t1 }), fxKey(t1)); // deterministic
  for (const change of [{ actor: "user" }, { payload: { reason: "x" } }, { event: "DENIED" }, { entity: brief("b", 2) }, { stream: "other" }]) {
    assert.notEqual(fxKey({ ...t1, ...change }), fxKey(t1), JSON.stringify(change));
  }
  assert.match(fxKey({ stream: S, entity: { type: "session", id: "s1" }, event: "NAMED" }), /^fx:[0-9a-f]{64}$/); // no actor, no payload
});

test("the README's fx: key test vectors (numbers, UTF-8, UTF-16 key order, REVISED, no actor) match the code", async () => {
  const { fxKey } = await import("../src/write/fxkey.ts");
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = /<!-- fx-vectors -->\n```jsonl\n([\s\S]*?)\n```\n<!-- \/fx-vectors -->/.exec(readme)?.[1];
  assert.ok(block, "README has the fx-vectors block");
  const vectors = block.split("\n").map((l) => JSON.parse(l) as { key: string; transition: Parameters<typeof fxKey>[0] & { actor: string | null } });
  assert.equal(vectors.length, 5);
  for (const v of vectors) {
    const { actor, ...rest } = v.transition;
    assert.equal(fxKey({ ...rest, ...(actor === null ? {} : { actor }) }), v.key, JSON.stringify(v.transition));
  }
  assert.ok(vectors.some((v) => Object.keys(v.transition.payload ?? {}).join() === "ﬁ,😀,Z,a")); // the code-unit case is there
});

test("a crash-retry with the same fx: key is a duplicate, never a second row; a malformed fx: id is refused outright", async () => {
  const { fxKey } = await import("../src/write/fxkey.ts");
  const t = setup();
  await t.make(brief("b"), "orchestrator");
  const key = fxKey({ stream: S, entity: brief("b"), event: "DISPATCHED", actor: "orchestrator" });
  const first = await t.run({ kind: "event", entity: brief("b"), event: "DISPATCHED", actor: "orchestrator", eventId: key });
  const retry = await t.run({ kind: "event", entity: brief("b"), event: "DISPATCHED", actor: "orchestrator", eventId: key });
  assert.equal(first.result.status, "appended");
  assert.equal(retry.result.status, "duplicate");
  assert.equal((await t.log()).filter((e) => e.type === "brief.dispatched").length, 1);
  for (const bad of ["fx:abc", `fx:${"A".repeat(64)}`, `fx:${"a".repeat(63)}`, `fx:${"a".repeat(64)}0`]) {
    await assert.rejects(t.run({ kind: "event", entity: brief("b"), event: "DISPATCHED", actor: "orchestrator", eventId: bad }), /fx: eventId must be fx: \+ 64 lowercase hex/, bad);
  }
});

test("refusals: recorded under the refused transition's fx: key and actor, once; malformed ones are refused", async () => {
  const t = setup();
  const id = `fx:${"c".repeat(64)}`;
  const good = { transition: { type: "brief", id: "b", version: 1, event: "CLAIMED" }, reason: "tira store unreachable", journaled_at: "2026-10-19T09:00:00Z" };
  const rec = (rid: string, actor: string | undefined, payload: Record<string, unknown>) => t.run({ kind: "create", entity: { type: "refusal", id: rid }, ...(actor ? { actor } : {}), payload });
  assert.equal(st(await rec("not-an-fx-key", "s1", good)), "rejected:guard-failed");
  assert.equal(st(await rec(id, undefined, good)), "rejected:guard-failed");
  for (const broken of [{ ...good, reason: "" }, { ...good, journaled_at: "yesterday" }, { ...good, transition: { type: "brief", id: "b" } }, { ...good, transition: "brief b" }]) {
    assert.equal(st(await rec(id, "s1", broken)), "rejected:guard-failed", JSON.stringify(broken));
  }
  assert.equal(st(await rec(id, "s1", good)), "appended");
  assert.equal((await t.log()).at(-1)?.type, "refusal.recorded");
  assert.equal(st(await rec(id, "s1", good)), "rejected:already-exists"); // without a key: refused, so recorded once
  assert.deepEqual((await t.now()).entities.find((e) => e.type === "refusal")?.born, good);
});

test("overrides: operator-invoked, at most 4 hours; expiry recorded by an operator or Mac; overdue and late are flagged", async () => {
  const t = setup();
  const inv = (id: string, actor: string, invoked_at: string, expires_at: string) =>
    t.run({ kind: "create", entity: { type: "override", id }, actor, payload: { incident: "store down", reason: "hotfix", invoked_at, expires_at } });
  assert.equal(st(await inv("o1", "s1", "2026-10-19T09:00:00Z", "2026-10-19T13:00:00Z")), "rejected:guard-failed"); // not an operator
  assert.equal(st(await inv("o1", "user", "2026-10-19T09:00:00Z", "2026-10-19T13:00:01Z")), "rejected:guard-failed"); // over 4 hours
  assert.equal(st(await inv("o1", "user", "2026-10-19T09:00:00Z", "2026-10-19T08:00:00Z")), "rejected:guard-failed"); // ends before it starts
  assert.equal(st(await inv("o1", "user", "2026-10-19T09:00:00Z", "2026-10-19T13:00:00Z")), "appended");
  assert.equal((await t.log()).at(-1)?.type, "override.invoked");
  assert.equal(st(await inv("o2", "orchestrator", "2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z")), "appended");
  // still active past its expiry: overdue (the log records its own violation); not before
  const at = async (now: string) => fold(await t.log(), t.registry, { now }).derived[S] ?? {};
  assert.equal((await at("2026-10-19T12:00:00Z"))["override:o1"]?.overdue, false);
  assert.equal((await at("2026-10-19T13:00:01Z"))["override:o1"]?.overdue, true);
  // expiry: an operator or Mac, with the time it happened
  const exp = (id: string, actor: string, payload: Record<string, unknown>) => t.ev({ type: "override", id }, "EXPIRED", actor, payload);
  assert.equal(st(await exp("o1", "s1", { expired_at: "2026-10-19T13:00:00Z" })), "rejected:guard-failed");
  assert.equal(st(await exp("o1", "mac", {})), "rejected:guard-failed");
  assert.equal(st(await exp("o1", "mac", { expired_at: "2026-10-19T08:59:59Z" })), "rejected:guard-failed"); // before it was invoked
  assert.equal(st(await exp("o1", "mac", { expired_at: "2026-10-19T13:00:00" })), "rejected:guard-failed"); // no zone
  assert.equal(st(await exp("o1", "mac", { expired_at: "2026-10-19T13:00:00Z" })), "appended");
  // once expired, a repeat is a no-op for the same people, and refused for anyone else
  const again = (await exp("o1", "user", { expired_at: "2026-10-19T13:00:00Z" })).result;
  assert.equal(again.status === "appended" ? again.outcome : again.status, "noop");
  assert.equal(st(await exp("o1", "s1", { expired_at: "2026-10-19T13:00:00Z" })), "rejected:guard-failed");
  assert.equal(st(await exp("o1", "mac", { expired_at: "2026-10-19T08:00:00Z" })), "rejected:guard-failed");
  assert.equal(st(await exp("o2", "user", { expired_at: "2026-10-19T11:30:00Z" })), "appended"); // half an hour late
  const d = await at("2026-10-19T14:00:00Z");
  assert.deepEqual([d["override:o1"]?.overdue, d["override:o1"]?.late, d["override:o2"]?.late], [false, false, true]);
  await clean(t);
});

test("fx: ids are checked against their own transition before anything is stored, relayed blocks included", async () => {
  const { fxKey } = await import("../src/write/fxkey.ts");
  const t = setup();
  const wrong = `fx:${"a".repeat(64)}`;
  const born = fxKey({ stream: S, entity: brief("b"), event: "CREATED", actor: "orchestrator" });
  await assert.rejects(t.run({ kind: "create", entity: brief("b"), actor: "orchestrator", eventId: wrong }), new RegExp(`isn't this transition's fx: key \\(it would be ${born};`));
  assert.equal((await t.log()).length, 0);
  assert.equal(st(await t.run({ kind: "create", entity: brief("b"), actor: "orchestrator", eventId: born })), "appended");
  // v2+ births hash the revision's name
  const v2 = { kind: "create", entity: brief("b", 2), actor: "orchestrator", payload: { supersedes: 1 } } as const;
  await assert.rejects(t.run({ ...v2, eventId: fxKey({ stream: S, entity: brief("b", 2), event: "CREATED", actor: "orchestrator", payload: { supersedes: 1 } }) }), /isn't this transition's fx: key/);
  assert.equal(st(await t.run({ ...v2, eventId: fxKey({ stream: S, entity: brief("b", 2), event: "REVISED", actor: "orchestrator", payload: { supersedes: 1 } }) })), "appended");
  // the orchestrator's block request is checked as sent, before the dispatcher rewrites it
  await t.ev(brief("b", 2), "DISPATCHED", "orchestrator");
  await t.make({ type: "session", id: "s1" }, "s1");
  await t.ev(brief("b", 2), "CLAIMED", "s1", { session: "s1" });
  const block = { kind: "event", entity: brief("b", 2), event: "BLOCKED", actor: "orchestrator", payload: { block_reason: "verdict" } } as const;
  await assert.rejects(t.run({ ...block, eventId: wrong }), /isn't this transition's fx: key/);
  const k = fxKey({ stream: S, entity: brief("b", 2), event: "BLOCKED", actor: "orchestrator", payload: { block_reason: "verdict" } });
  assert.equal(st(await t.run({ ...block, eventId: k })), "appended");
  assert.equal(st(await t.run({ ...block, eventId: k })), "duplicate");
  const relayed = (await t.log()).filter((e) => e.type === "brief.blocked");
  assert.deepEqual(relayed.map((e) => [e.eventId, e.metadata.actor, e.metadata.causationId]), [[k, "dispatcher", k]]);
  await clean(t);
});

test("reconciling an outage: the refusal is keyed by its own transition, so the refused claim still lands once tira is back", async () => {
  const { fxKey, transitionOf } = await import("../src/write/fxkey.ts");
  const t = setup();
  await t.make({ type: "session", id: "s1" }, "s1");
  await t.make(brief("b"), "orchestrator");
  await t.ev(brief("b"), "DISPATCHED", "orchestrator");
  const claim = { kind: "event", entity: brief("b"), event: "CLAIMED", actor: "s1", payload: { session: "s1" } } as const;
  const k = fxKey(transitionOf({ stream: S, ...claim }, (ty, v) => t.registry.creationName(ty, v)));
  const record = { kind: "create", entity: { type: "refusal", id: k }, actor: "s1", payload: { transition: { type: "brief", id: "b", version: 1, event: "CLAIMED" }, reason: "tira store unreachable", journaled_at: "2026-10-19T09:00:00Z" } } as const;
  // recorded under the claim's key, the refusal would take the id the claim needs: refused at once
  await assert.rejects(t.run({ ...record, eventId: k }), /isn't this transition's fx: key/);
  const own = fxKey(transitionOf({ stream: S, ...record }, (ty, v) => t.registry.creationName(ty, v)));
  assert.notEqual(own, k);
  assert.equal(st(await t.run({ ...record, eventId: own })), "appended");
  assert.equal(st(await t.run({ ...record, eventId: own })), "duplicate"); // reconciling twice records it once
  assert.equal(st(await t.run({ ...claim, eventId: k })), "appended");
  assert.equal(st(await t.run({ ...claim, eventId: k })), "duplicate");
  const log = await t.log();
  assert.deepEqual(log.filter((e) => e.eventId === k || e.eventId === own).map((e) => e.type), ["refusal.recorded", "brief.claimed"]);
  assert.equal((await t.at(brief("b")))?.regions.claim, "claimed-silent");
  await clean(t);
});

test("times are strict ISO-8601 with a zone, parsed by hand: no time zone, Date.parse leniency or two-digit years", async () => {
  const { isoMs } = await import("../src/time.ts");
  const at = Date.UTC(2026, 9, 19, 9, 30);
  assert.equal(isoMs("2026-10-19T09:30Z"), at);
  assert.equal(isoMs("2026-10-19T09:30:00Z"), at);
  assert.equal(isoMs("2026-10-19T15:00:00+05:30"), at);
  assert.equal(isoMs("2026-10-19T04:30:00-05:00"), at);
  assert.equal(isoMs("2026-10-19T09:30:00.5Z"), at + 500);
  assert.equal(isoMs("2026-10-19T09:30:00.123456789Z"), at + 123);
  assert.equal(isoMs("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29));
  assert.equal(isoMs("0050-01-01T00:00:00Z"), new Date("0050-01-01T00:00:00Z").getTime()); // year 50, not 1950
  for (const bad of [
    "2026-10-19T09:30:00", "2026-10-19", "2026-10-19 09:30:00Z", "2026-10-19t09:30:00z", "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-10-00T00:00:00Z", "2026-10-19T24:00:00Z", "2026-10-19T09:60:00Z",
    "2026-10-19T09:30:60Z", "2026-10-19T09:30:00+5:30", "2026-10-19T09:30:00+0530", "2026-10-19T09:30:00+24:00", "2026-10-19T09:30:00.Z",
    "+002026-10-19T09:30:00Z", " 2026-10-19T09:30:00Z", "2026-10-19T09:30:00Z\n", 1760866200000, null, undefined, {},
  ]) assert.equal(isoMs(bad), undefined, JSON.stringify(bad));
});

test("an override's guards give the same answer in every time zone (replay can't depend on where it runs)", async () => {
  const saved = process.env.TZ;
  try {
    const t = setup();
    process.env.TZ = "UTC";
    const inv = (id: string, invoked_at: string, expires_at: string) =>
      t.run({ kind: "create", entity: { type: "override", id }, actor: "user", payload: { incident: "store down", reason: "hotfix", invoked_at, expires_at } });
    // zone-less times are local time to Date.parse: refused everywhere, so no log can hold one
    assert.equal(st(await inv("o1", "2026-10-19T09:00:00Z", "2026-10-19T13:00:00")), "rejected:guard-failed");
    process.env.TZ = "Asia/Kolkata";
    assert.equal(st(await inv("o1", "2026-10-19T09:00:00Z", "2026-10-19T13:00:00")), "rejected:guard-failed");
    // exactly 4 hours across two offsets, and an expiry in a third
    assert.equal(st(await inv("o1", "2026-10-19T09:00:00Z", "2026-10-19T18:30:00+05:30")), "appended");
    await t.ev({ type: "override", id: "o1" }, "EXPIRED", "mac", { expired_at: "2026-10-19T09:00:00-04:00" });
    const folds = [];
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      const r = fold(await t.log(), t.registry, { now: "2026-10-19T14:00:00Z" });
      assert.deepEqual(r.anomalies, [], tz);
      folds.push(JSON.stringify([r.entities, r.derived, r.rejections]));
    }
    assert.equal(new Set(folds).size, 1);
    assert.equal(fold(await t.log(), t.registry).entities.find((e) => e.key === "override:o1")?.regions.lifecycle, "expired");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("the page marks rows a factory transition wrote (fx: ids) as automatic", async () => {
  const { renderHtml } = await import("../src/render/html.ts");
  const t = setup();
  const { fxKey } = await import("../src/write/fxkey.ts");
  await t.run({ kind: "create", entity: brief("b"), actor: "orchestrator", eventId: fxKey({ stream: S, entity: brief("b"), event: "CREATED", actor: "orchestrator" }) });
  await t.make(brief("c"), "orchestrator");
  const log = await t.log();
  const html = renderHtml(fold(log, t.registry), S, "h", log);
  assert.equal((html.match(/<span class="auto"/g) ?? []).length, 1); // b's birth, in Activity (briefs have no drawer); c's is not marked
});

// ---------- blind round 1: the faults the suite let through (2026-10-20) ----------

test("claimable now is in birth order, not name order: zeta was dispatched first, so it comes first (blind fault 6)", async () => {
  const t = setup();
  for (const id of ["zeta", "alpha", "mid"]) {
    await t.make(brief(id), "orchestrator");
    await t.ev(brief(id), "DISPATCHED", "orchestrator");
  }
  assert.deepEqual((await t.now()).frontier[S], ["brief:zeta@1", "brief:alpha@1", "brief:mid@1"]);
});

test("only the exact word PASS verifies a drop: pass, Pass and padded PASS are refused (blind fault 7, incident 2)", async () => {
  const t = setup();
  await t.claimed("b", "s1");
  await t.make(dropRef("b"), "s1");
  for (const verdict of ["pass", "Pass", " PASS", "PASS ", "PASSED", true]) {
    assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: verdict })), "rejected:guard-failed", JSON.stringify(verdict));
  }
  assert.equal(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "PASS" })), "appended");
});

// ---------- the five representation classes, made structural (2026-10-21) ----------
// One test per class, named by its convention id (conventions/conventions.jsonl): the class is
// defined in one place (structure), and every surface the convention binds is checked.

test("claimable-birth-order: every work queue is in birth order, never name order: claimable now, tree roots, children and the cursor, all through one byBirth", async () => {
  // structure: one birth comparator, and the queues sort by it
  const src = srcCode();
  assert.deepEqual(filesMatching(src, /createdSeq\s*-/), ["src/fold/view.ts"]);
  assert.match(src.get("src/tables/factory.ts") ?? "", /export const frontier[^;]*\.sort\(byBirth\);/);
  assert.match(src.get("src/fold/tree.ts") ?? "", /export function roots[^;]*\.sort\(byBirth\);/);
  // zeta is born first everywhere: a brief, a root, and a child
  const t = setup();
  for (const id of ["zeta", "alpha", "mid"]) {
    await t.make(brief(id), "orchestrator");
    await t.ev(brief(id), "DISPATCHED", "orchestrator");
  }
  for (const id of ["zeta", "alpha"]) await t.make({ type: "node", id }, "isha");
  for (const id of ["zeta_kid", "alpha_kid"]) await t.make({ type: "node", id }, "isha", { parent_id: "zeta" });
  const r = await t.now();
  assert.deepEqual(r.frontier[S], ["brief:zeta@1", "brief:alpha@1", "brief:mid@1"]);
  assert.deepEqual(r.trees[S]?.node?.roots, ["node:zeta", "node:alpha"]);
  assert.deepEqual(r.entities.find((e) => e.key === "node:zeta")?.tree?.children, ["node:zeta_kid", "node:alpha_kid"]);
  assert.equal(r.trees[S]?.node?.cursor, "node:zeta_kid");
});

test("verify-vocabulary-pass: exactly the word PASS verifies a drop or a brief, read in one place: every near-miss is refused, whatever its casing, padding, lookalike or type", async () => {
  // structure: the word is written once in src, and a verdict is read only through verifies
  const src = srcCode();
  assert.deepEqual(filesMatching(src, /["'`]PASS["'`]/), ["src/tables/factory.ts"]);
  assert.equal(src.get("src/tables/factory.ts")?.match(/["'`]PASS["'`]/g)?.length, 1);
  assert.deepEqual(filesMatching(src, /done_test_result\s*[!=]==?|done_test_result\)?\.(?:trim|to\w*Case|normalize)/), []);
  // ... and every move into a verified state reads it: the drop's VERIFIED, and since rules era 3
  // the brief's VERIFIED_DONE (before, the dispatcher's word was enough)
  const r = defaultRegistry();
  const moves = r.types().flatMap((def) => Object.values(def.regions).flatMap((table) =>
    table.pairs.filter((p) => p.outcome === "transition" && /(^|-)verified$/.test(p.to ?? "")).map((p) => `${table.id}: ${p.from}+${p.event} ${p.guard}`)));
  assert.deepEqual(moves, ["brief-outcome: dropped-unverified+VERIFIED_DONE dispatcherWithPass", "drop: filed+VERIFIED orchestratorVerifiesPass"]);
  for (const g of ["dispatcherWithPass", "orchestratorVerifiesPass"]) assert.match(String(r.guards[g]), /verifies\(payload\.done_test_result\)/, g);
  const nearMisses: unknown[] = [
    "pass", "Pass", "pASS", " PASS", "PASS ", "PASS\n", "\tPASS", "​PASS", "PASS​",
    "ＰＡＳＳ", "PАSS", "PASSED", "PAS", "P A S S", "", null, true, 1, ["PASS"], { result: "PASS" },
  ];
  for (const v of nearMisses) assert.equal(verifies(v), false, JSON.stringify(v));
  assert.equal(verifies(PASS), true);
  // the write path: each near-miss is refused, and so is no verdict at all, on the drop and on
  // its brief (the dispatcher's own VERIFIED_DONE); then PASS verifies the drop, and H3 the brief
  const t = setup();
  await t.claimed("b", "s1");
  await t.make(dropRef("b"), "s1");
  const done = async (payload: Record<string, unknown>) => {
    const w = await t.d.writePath.submitAsDispatcher({ stream: S, kind: "event", entity: brief("b"), event: "VERIFIED_DONE", payload });
    return w.status === "rejected" ? `rejected:${w.code}` : w.status;
  };
  for (const v of nearMisses) {
    assert.match(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: v })), /^rejected:/, JSON.stringify(v));
    assert.equal(await done({ done_test_result: v }), "rejected:guard-failed", JSON.stringify(v));
  }
  assert.match(st(await t.ev(dropRef("b"), "VERIFIED", "orchestrator")), /^rejected:/, "no verdict");
  assert.equal(await done({}), "rejected:guard-failed", "no verdict");
  assert.equal((await t.at(brief("b")))?.regions.outcome, "dropped-unverified");
  const v = await t.ev(dropRef("b"), "VERIFIED", "orchestrator", { done_test_result: "PASS" });
  assert.equal(st(v), "appended");
  assert.deepEqual(rules(v), ["H3 brief.verified-done"]);
  assert.equal((await t.at(brief("b")))?.regions.outcome, "done-verified");
  await clean(t);
});
