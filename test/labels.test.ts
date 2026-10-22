// KAN-8 build piece 0: the outcome-label channel (src/fold/labels.ts), through the CLI on a
// scratch store. The spec's done test names dist/cli.js commands this repo doesn't have; its
// T1 / T2 semantics are run here with the repo's CLI (src/cli/cli.ts `run`):
//   T1 a label from the approval's own approver is refused at the write path: exit 2, nothing appended
//   T2 a label citing evidence the log doesn't hold folds as an anomaly, outside every label count
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/cli.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import type { FoldResult } from "../src/fold/fold.ts";
import type { NewEvent } from "../src/store/types.ts";

const STREAM = "tasktree-main"; // the CLI's default stream
type LabelFixture = { actor: string; id: string; payload: Record<string, unknown> };
const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "tira-labels-"));
  const db = join(dir, "t.db");
  const tira = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["--db", db, ...argv], { out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const ok = async (...argv: string[]) => {
    const r = await tira(...argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.out}${r.err}`);
    return r;
  };
  const label = (l: LabelFixture) => tira("create", "label", l.id, "--actor", l.actor, "--payload", JSON.stringify(l.payload));
  const state = async () => JSON.parse((await ok("state", "--json")).out) as FoldResult;
  const logLength = async () => (JSON.parse((await ok("log", "--json")).out) as unknown[]).length;
  const raw = async (e: NewEvent) => {
    const store = new SqliteEventStore({ path: db });
    try {
      await store.append(STREAM, [e]);
    } finally {
      store.close();
    }
  };
  // brief b1 approved: drop b1@1 verified by the orchestrator (event approval-b1), and a
  // later finding in the same log for an oracle to cite (event evidence-b1).
  const approved = async () => {
    await ok("create", "session", "s1", "--actor", "s1");
    await ok("create", "brief", "b1", "--version", "1", "--actor", "orchestrator", "slice_ref=slice/b1");
    await ok("send", "brief", "b1", "DISPATCHED", "--version", "1", "--actor", "orchestrator");
    await ok("send", "brief", "b1", "CLAIMED", "--version", "1", "--actor", "s1", "session=s1");
    await ok("create", "drop", "b1", "--version", "1", "--actor", "s1");
    await ok("send", "drop", "b1", "VERIFIED", "--version", "1", "--actor", "orchestrator", "done_test_result=PASS", "--event-id", "approval-b1");
    await ok("create", "node", "incident-b1", "--actor", "qa", "--event-id", "evidence-b1");
  };
  return { tira, ok, label, state, logLength, raw, approved, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const regionsOf = (s: FoldResult, key: string) => s.entities.find((e) => e.key === key)?.regions;

test("a valid oracle label lands and appears in the derived view; the approval it judges is untouched", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const before = await s.state();
    assert.equal(before.labels, undefined); // no label events: no labels key, same bytes as before labels existed
    const r = await s.label(fixture<LabelFixture>("label-valid.json"));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^appended {3}seq \d+ {2}label:lbl-qa-1 {2}created/);
    const after = await s.state();
    assert.deepEqual(after.anomalies, []);
    const l = after.labels?.[STREAM];
    assert.deepEqual({ labels: l?.labels, labeled: l?.labeled, foundBad: l?.foundBad, disagreements: l?.disagreements, anomalies: l?.anomalies }, {
      labels: 1, labeled: 1, foundBad: 1, disagreements: 0, anomalies: 0,
    });
    assert.deepEqual(l?.approvals["approval-b1"], { brief: "b1", verdict: "found-bad", labels: [{ key: "label:lbl-qa-1", actor: "oracle:qa", verdict: "found-bad" }] });
    // the terminal states stay terminal: the label moved nothing on the brief or the drop
    assert.deepEqual(regionsOf(after, "brief:b1@1"), regionsOf(before, "brief:b1@1"));
    assert.equal(regionsOf(after, "brief:b1@1")?.outcome, "done-verified");
    assert.equal(regionsOf(after, "drop:b1@1")?.lifecycle, "verified");
    // and the state surface prints it
    assert.match((await s.ok("state")).out, /labels: 1 on 1 approval\(s\) · found bad 1 · oracles disagree on 0 · 0 refused by the fold/);
  } finally {
    s.done();
  }
});

test("T1: a label from the approval's own approver is refused at the write path: exit 2, nothing appended", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const n = await s.logLength();
    const self = fixture<LabelFixture>("label-by-approver.json");
    const r = await s.label(self);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^REFUSED {4}self-label {2}oracle:orchestrator is orchestrator, who approved approval-b1/);
    assert.equal(await s.logLength(), n, "nothing appended, not even a rejection");
    // the same approver under a lookalike spelling is the same approver
    const look = await s.label({ ...self, id: "lbl-self-2", actor: "oracle: Orchestrаtor" }); // Cyrillic а
    assert.equal(look.code, 2, look.out);
    assert.equal(await s.logLength(), n);
    assert.equal((await s.state()).labels, undefined);
  } finally {
    s.done();
  }
});

test("T2: a label citing evidence the log doesn't hold folds as an anomaly, outside every label count", async () => {
  const s = sandbox();
  try {
    await s.approved();
    await s.raw(fixture<{ event: NewEvent }>("label-dangling.json").event);
    const st = await s.state();
    assert.equal(st.anomalies.length, 1);
    assert.equal(st.anomalies[0]?.type, "label.recorded");
    assert.match(st.anomalies[0]?.problem ?? "", /^bad-label: evidence no-such-event does not resolve/);
    assert.equal(st.entities.some((e) => e.type === "label"), false, "the dangling label never becomes an entity");
    assert.deepEqual(st.labels?.[STREAM], { labels: 0, labeled: 0, foundBad: 0, disagreements: 0, anomalies: 1, approvals: {} });
    // a valid label beside it counts; the anomaly still doesn't
    assert.equal((await s.label(fixture<LabelFixture>("label-valid.json"))).code, 0);
    const both = (await s.state()).labels?.[STREAM];
    assert.deepEqual([both?.labels, both?.labeled, both?.foundBad, both?.anomalies], [1, 1, 1, 1]);
    assert.match((await s.ok("state")).out, /ANOMALIES \(1\)/);
  } finally {
    s.done();
  }
});

test("the write path refuses what the log doesn't hold, and logs the refusal", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const valid = fixture<LabelFixture>("label-valid.json");
    const tries: [string, Record<string, unknown>, RegExp][] = [
      ["no-evidence", { ...valid.payload, evidence: "no-such-event" }, /evidence no-such-event does not resolve/],
      ["no-approval", { ...valid.payload, verifying_event_id: "evidence-b1" }, /evidence-b1 is not an applied drop\.verified/],
      ["wrong-brief", { ...valid.payload, brief: "b2" }, /approved the drop for b1, not brief b2/],
    ];
    for (const [id, payload, why] of tries) {
      const r = await s.label({ ...valid, id, payload });
      assert.equal(r.code, 2, id);
      assert.match(r.out, /^REJECTED {3}seq \d+ {2}bad-label/, id);
      assert.match(r.out, why, id);
    }
    // the shape is the guard's: a verdict outside the two, or a label not written by an oracle
    assert.match((await s.label({ ...valid, id: "maybe", payload: { ...valid.payload, verdict: "maybe" } })).out, /guard-failed/);
    assert.match((await s.label({ ...valid, id: "by-qa", actor: "qa" })).out, /guard-failed/);
    assert.equal((await s.state()).rejections.length, 5);
    assert.equal((await s.state()).labels, undefined);
  } finally {
    s.done();
  }
});

test("one approval takes many labels; oracles' disagreements are kept, and any found-bad marks it bad", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const valid = fixture<LabelFixture>("label-valid.json");
    assert.equal((await s.label({ ...valid, id: "good-1", actor: "oracle:prod", payload: { ...valid.payload, verdict: "confirmed-good" } })).code, 0);
    let l = (await s.state()).labels?.[STREAM];
    assert.deepEqual([l?.labeled, l?.foundBad, l?.disagreements, l?.approvals["approval-b1"]?.verdict], [1, 0, 0, "confirmed-good"]);
    assert.equal((await s.label(valid)).code, 0);
    l = (await s.state()).labels?.[STREAM];
    assert.deepEqual([l?.labels, l?.labeled, l?.foundBad, l?.disagreements], [2, 1, 1, 1]);
    assert.deepEqual(l?.approvals["approval-b1"]?.labels.map((x) => `${x.actor} ${x.verdict}`), ["oracle:prod confirmed-good", "oracle:qa found-bad"]);
  } finally {
    s.done();
  }
});

test("an oracle writes labels and nothing else", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const r = await s.tira("send", "node", "incident-b1", "START", "--actor", "oracle:qa");
    assert.equal(r.code, 2);
    assert.match(r.out, /reserved-actor {2}actor "oracle:qa" is an oracle/);
    // and the fold flags one that reached the log another way
    await s.raw({ type: "node.start", data: { entity: { id: "incident-b1" }, payload: {} }, metadata: { actor: "oracle:qa", era: 2 } });
    assert.match((await s.state()).anomalies[0]?.problem ?? "", /oracle:qa is an oracle/);
  } finally {
    s.done();
  }
});

test("a self-issued label that reached the log another way folds as an anomaly too", async () => {
  const s = sandbox();
  try {
    await s.approved();
    const self = fixture<LabelFixture>("label-by-approver.json");
    await s.raw({ type: "label.recorded", data: { entity: { id: self.id }, payload: self.payload }, metadata: { actor: self.actor, era: 2 } });
    const st = await s.state();
    assert.match(st.anomalies[0]?.problem ?? "", /^self-label: /);
    assert.deepEqual([st.labels?.[STREAM]?.labels, st.labels?.[STREAM]?.anomalies], [0, 1]);
  } finally {
    s.done();
  }
});
