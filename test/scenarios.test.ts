// The scenario suite as event scripts (scenarios/*.json; build order C2). One test per
// script; scripts waiting on an unbuilt phase show as TODO with the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScenarios, runScenario } from "../src/scenario/run.ts";

const all = loadScenarios();

for (const s of all.values()) {
  if (s.status === "seed") continue;
  const name = `${s.id}: ${s.title}`;
  if (s.status === "pending") {
    test(name, { todo: s.pending ?? "pending" }, () => {});
    continue;
  }
  test(name, async () => {
    const { failures, log } = await runScenario(s, all);
    assert.deepEqual(failures, [], `${s.id} (${log.length} events)`);
  });
  for (const part of s.pendingParts ?? []) test(`${s.id}, still to come: ${part}`, { todo: "pending" }, () => {});
}

test("every plan scenario is scripted (S1–S9, T1–T8, R2, R3), and every 'after' points at a script", () => {
  const plan = [...["S", "T"].flatMap((p) => Array.from({ length: p === "S" ? 9 : 8 }, (_, i) => `${p}${i + 1}`)), "R2", "R3"];
  for (const id of plan) assert.ok(all.has(id), `${id} has no script`);
  for (const s of all.values()) for (const a of s.after ?? []) assert.ok(all.has(a), `${s.id}: after ${a}`);
});

test("the runner fails a script whose expectations are wrong (so a green suite means something)", async () => {
  const wrong = {
    id: "wrong", title: "deliberately wrong", after: ["seed-dashboard"],
    steps: [
      { do: "send" as const, type: "node", id: "table", event: "START", expect: "rejected:denied" },
      { do: "send" as const, type: "node", id: "table", event: "COMPLETE", handoffs: ["H1 brief.claimable"], label: "x" },
    ],
    expect: { states: { "node:table": "done" }, cursor: "node:filters", rejections: 0, pending: [["F1", "node:x"]] as [string, string][], trail: { "node:table": ["node.born"] } },
    replayAt: [{ after: "x", active: ["node:filters"] }],
  };
  const { failures } = await runScenario(wrong, all);
  const said = failures.join("\n");
  for (const bit of [
    "step 12: send node:table START was appended, expected rejected:denied",
    "was rejected:guard-failed, expected appended",
    "the dispatcher wrote [], expected [\"H1 brief.claimable\"]",
    "end: node:table's state is \"in_progress\", expected \"done\"",
    "end: the cursor is \"node:colors\", expected \"node:filters\"",
    "end: rejections is 1, expected 0",
    "end: pending handoffs is [], expected [[\"F1\",\"node:x\"]]",
    "end: node:table's trail is",
    "replay to x",
  ]) assert.ok(said.includes(bit), `missing: ${bit}\n--- got:\n${said}`);
});

test("the runner also reports every other kind of wrong expectation, and refuses malformed scripts", async () => {
  const tree = {
    id: "wrong-tree", title: "deliberately wrong", after: ["S1", "S2", "S7"], steps: [],
    expect: {
      absent: ["node:table"], drained: ["node:table"], notDrained: ["node:improve_visual"], awaitingClose: ["node:table"],
      closedByTira: ["node:table"], anomalies: 1, frontier: ["brief:x@1"],
      provenance: { "node:design_tokens": { parent: "node:metrics_card", kind: "planned" } },
      paired: [{ from: "idea.approve-node idea:none", to: "node.born node:none" }],
      sweep: { broken: 1, found: { regrown: ["node:x"], orphan: [] } },
    },
  };
  const said = (await runScenario(tree, all)).failures.join("\n");
  for (const bit of [
    "node:table exists, expected none", "node:table isn't drained", "node:improve_visual is drained",
    "waiting for tira is [\"node:improve_visual\"], expected [\"node:table\"]", "closed by tira is [], expected [\"node:table\"]",
    "0 anomalies", "the frontier is [], expected [\"brief:x@1\"]", "node:design_tokens's provenance", "no pair idea.approve-node idea:none",
    "the health sweep found 0 broken (), expected 1", "the sweep's regrown findings is [], expected [\"node:x\"]", "the sweep has no check \"orphan\"",
  ]) assert.ok(said.includes(bit), `missing: ${bit}\n--- got:\n${said}`);
  // a factory brief has three regions: a one-word state is refused, region states are compared
  const brief = { id: "wrong-brief", title: "wrong", after: ["I2-unchecked-landing"], steps: [], expect: { states: { "brief:b@1": "gated", "drop:b@1": "filed" } } };
  const said2 = (await runScenario(brief, all)).failures.join("\n");
  assert.match(said2, /brief:b@1 has 3 regions: name them/);
  assert.match(said2, /drop:b@1's state is "verified", expected "filed"/);
  // malformed scripts are refused outright
  await assert.rejects(runScenario({ id: "me", title: "", after: ["me"] }, all), /can't run after itself/);
  await assert.rejects(runScenario({ id: "twice", title: "", steps: [{ do: "check", label: "x" }, { do: "check", label: "x" }] }, all), /label x is used twice/);
});
