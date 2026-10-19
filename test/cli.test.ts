// tira CLI: commands, exit codes, payload parsing, persistence across runs, and one
// end-to-end spawn of the real entry script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/cli.ts";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "tira-cli-"));
  const db = join(dir, "t.db");
  const tira = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["--db", db, ...argv], { out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { dir, db, tira, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("create + send: appended exits 0, rejected exits 2 with the reason", async () => {
  const s = sandbox();
  try {
    const c = await s.tira("create", "node", "colors");
    assert.equal(c.code, 0);
    assert.match(c.out, /appended\s+seq 1\s+node:colors\s+created\s+lifecycle=unstarted/);
    assert.equal((await s.tira("send", "node", "colors", "START")).code, 0);
    const bare = await s.tira("send", "node", "colors", "COMPLETE");
    assert.equal(bare.code, 2);
    assert.match(bare.out, /REJECTED\s+seq 3\s+guard-failed\s+node-lifecycle: in_progress \+ COMPLETE needs hasEvidenceRef/);
    const ok = await s.tira("send", "node", "colors", "COMPLETE", "evidenceRef=palette.png");
    assert.equal(ok.code, 0);
    assert.match(ok.out, /lifecycle=done/);
  } finally {
    s.done();
  }
});

test("moving on prints tira's closes; --actor tira is refused", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "p");
    await s.tira("create", "node", "c", "--parent", "p");
    await s.tira("create", "node", "q");
    await s.tira("send", "node", "c", "CANCEL");
    const move = await s.tira("send", "node", "q", "START");
    assert.equal(move.code, 0);
    assert.match(move.out, /appended\s+seq 7\s+node:q/);
    assert.match(move.out, /^ {2}\+ tira closed node:p \(seq 5, 6\): you moved on$/m);
    const claim = await s.tira("send", "node", "q", "BLOCK", "--actor", "tira");
    assert.equal(claim.code, 2);
    assert.match(claim.out, /REJECTED\s+seq 8\s+reserved-actor/);
  } finally {
    s.done();
  }
});

test("factory through the CLI: handoffs print as + dispatcher lines; a revise takes supersedes=1 as typed", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "brief", "b", "--version", "1", "--actor", "orchestrator");
    const d = await s.tira("send", "brief", "b", "DISPATCHED", "--version", "1", "--actor", "orchestrator");
    assert.match(d.out, /^ {2}\+ dispatcher brief\.claimable on brief:b@1 \(H1, seq 3\)$/m);
    const v2 = await s.tira("create", "brief", "b", "--version", "2", "--actor", "orchestrator", "supersedes=1");
    assert.equal(v2.code, 0, v2.out);
    const bad = await s.tira("create", "brief", "b", "--version", "3", "--actor", "orchestrator", "supersedes=1");
    assert.match(bad.out, /bad-version\s+brief:b@3 can only supersede version 2 \(got supersedes=1\)/);
  } finally {
    s.done();
  }
});

test("state persists across runs (file-backed) and shows entities + rejections", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "colors", "--actor", "isha");
    await s.tira("send", "node", "colors", "CANCEL", "--actor", "isha");
    await s.tira("send", "node", "colors", "START"); // rejected: cancelled is terminal
    const st = await s.tira("state");
    assert.equal(st.code, 0);
    assert.match(st.out, /folded to seq 3/);
    assert.match(st.out, /node:colors\s+cancelled\s+1\s+2\s+isha/);
    assert.match(st.out, /rejections \(1\)[\s\S]*START node:colors\s+denied/);
  } finally {
    s.done();
  }
});

test("replay N and state --at N give the historical state", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a");
    await s.tira("send", "node", "a", "START");
    await s.tira("send", "node", "a", "BLOCK");
    const r2 = await s.tira("replay", "2");
    assert.match(r2.out, /replay to 2/);
    assert.match(r2.out, /node:a\s+in_progress/);
    const at1 = await s.tira("state", "--at", "1");
    assert.match(at1.out, /node:a\s+unstarted/);
    const json2 = JSON.parse((await s.tira("replay", "2", "--json")).out);
    const jsonAt2 = JSON.parse((await s.tira("state", "--at", "2", "--json")).out);
    assert.deepEqual(json2, jsonAt2);
    assert.equal(json2.lastSeq, 2);
    assert.match((await s.tira("state")).out, /node:a\s+blocked/);
  } finally {
    s.done();
  }
});

test("log lists every event in seq order, rejections included, with actor and detail", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "idea", "7", "text=Table needs pagination", "--actor", "isha");
    await s.tira("send", "idea", "7", "APPROVE_NODE"); // denied: no skipping
    const l = await s.tira("log");
    const lines = l.out.split("\n");
    assert.match(lines[0] ?? "", /2 event\(s\)/);
    assert.match(l.out, /1\s+0\s+idea\.created\s+idea:7\s+isha\s+\{"text":"Table needs pagination"\}/);
    assert.match(l.out, /2\s+1\s+command\.rejected\s+idea:7\s+APPROVE_NODE -> denied/);
    const json = JSON.parse((await s.tira("log", "--json")).out);
    assert.deepEqual(json.map((e: { seq: number }) => e.seq), [1, 2]);
  } finally {
    s.done();
  }
});

test("payload: key=value values are strings; --payload JSON merges; bad JSON is a usage error", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a");
    await s.tira("send", "node", "a", "START");
    // a number is not evidence: --payload keeps the type, so the guard rejects it
    assert.equal((await s.tira("send", "node", "a", "COMPLETE", "--payload", '{"evidenceRef":123}')).code, 2);
    // key=value is always a string, so "123" is valid evidence
    assert.equal((await s.tira("send", "node", "a", "COMPLETE", "evidenceRef=123")).code, 0);
    const events = JSON.parse((await s.tira("log", "--json")).out);
    assert.deepEqual(events.at(-1).data.payload, { evidenceRef: "123" });
    const merged = await s.tira("send", "node", "a", "REOPEN", "--payload", '{"ticket":7}', "reason=a=b");
    assert.equal(merged.code, 0);
    const last = JSON.parse((await s.tira("log", "--json")).out).at(-1);
    assert.deepEqual(last.data.payload, { ticket: 7, reason: "a=b" }); // only the first "=" splits
    assert.equal((await s.tira("send", "node", "a", "START", "--payload", "{nope")).code, 1);
    assert.equal((await s.tira("send", "node", "a", "START", "--payload", "[1]")).code, 1);
    assert.equal((await s.tira("send", "node", "a", "START", "novalue")).code, 1);
  } finally {
    s.done();
  }
});

test("--event-id makes re-sending safe: second run reports duplicate, nothing new stored", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a");
    assert.equal((await s.tira("send", "node", "a", "START", "--event-id", "cmd-1")).code, 0);
    const again = await s.tira("send", "node", "a", "START", "--event-id", "cmd-1");
    assert.equal(again.code, 0);
    assert.match(again.out, /duplicate\s+seq 2/);
    assert.equal(JSON.parse((await s.tira("log", "--json")).out).length, 2);
  } finally {
    s.done();
  }
});

test("--stream keeps trees apart; --json write output is parseable", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a", "--stream", "tasktree-x");
    const r = JSON.parse((await s.tira("create", "node", "a", "--stream", "tasktree-y", "--json")).out);
    assert.equal(r.status, "appended");
    assert.match((await s.tira("state", "--stream", "tasktree-x")).out, /entities \(1\)/);
    assert.match((await s.tira("state")).out, /entities \(0\)/); // default stream untouched
  } finally {
    s.done();
  }
});

test("usage errors exit 1: unknown command, missing args, bad flags, bad version, bad N", async () => {
  const s = sandbox();
  try {
    const unknown = await s.tira("frobnicate");
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown command "frobnicate"/);
    assert.equal((await s.tira("create", "node")).code, 1);
    assert.equal((await s.tira("send", "node", "a")).code, 1);
    assert.equal((await s.tira("state", "--nope")).code, 1);
    assert.equal((await s.tira("create", "node", "a", "--version", "0")).code, 1);
    assert.equal((await s.tira("replay")).code, 1);
    assert.equal((await s.tira("replay", "-3")).code, 1);
    assert.equal((await s.tira("state", "--at", "two")).code, 1);
    const help = await run(["--help"], { out: () => {}, err: () => {}, env: {} });
    assert.equal(help, 0);
    assert.equal(await run([], { out: () => {}, err: () => {}, env: {} }), 1);
  } finally {
    s.done();
  }
});

test("dump: canonical JSON of the fold; --hash is stable across runs and copies, and moves with the log", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a");
    await s.tira("send", "node", "a", "START");
    await s.tira("send", "node", "a", "COMPLETE"); // rejected
    const json = (await s.tira("dump")).out;
    assert.equal(json, (await s.tira("state", "--json")).out); // dump is the canonical fold
    const parsed = JSON.parse(json);
    assert.equal(parsed.lastSeq, 3);
    assert.equal(parsed.rejections.length, 1);
    const h1 = (await s.tira("dump", "--hash")).out;
    assert.match(h1, /^sha256:[0-9a-f]{64}  stream tasktree-main · seq 3$/);
    assert.equal((await s.tira("dump", "--hash")).out, h1); // re-run: identical (M0)
    const { copyFileSync } = await import("node:fs");
    const copy = join(s.dir, "copy.db");
    copyFileSync(s.db, copy); // a fresh store holding only the raw log
    const out: string[] = [];
    await run(["--db", copy, "dump", "--hash"], { out: (l) => out.push(l), err: () => {}, env: {} });
    assert.equal(out[0], h1);
    // replay-to-N reproduces the hash the log had at N
    await s.tira("send", "node", "a", "COMPLETE", "evidenceRef=e");
    const h2 = (await s.tira("dump", "--hash")).out;
    assert.notEqual(h2.slice(0, 71), h1.slice(0, 71));
    assert.equal((await s.tira("dump", "--hash", "--at", "3")).out.slice(0, 71), h1.slice(0, 71));
    const j = JSON.parse((await s.tira("dump", "--hash", "--json")).out);
    assert.match(j.sha256, /^[0-9a-f]{64}$/);
    assert.equal(j.lastSeq, 4);
  } finally {
    s.done();
  }
});

test("send accepts the stored event form too: start, add-child", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "a");
    assert.match((await s.tira("send", "node", "a", "start")).out, /transition\s+lifecycle=in_progress/);
    assert.match((await s.tira("send", "node", "a", "add-child")).out, /noop/);
    const types = JSON.parse((await s.tira("log", "--json")).out).map((e: { type: string }) => e.type);
    assert.deepEqual(types, ["node.born", "node.start", "node.add-child"]);
  } finally {
    s.done();
  }
});

test("C1: --parent builds the tree; tree and render show it; render's hash = dump --hash", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "root");
    assert.match((await s.tira("create", "node", "a", "--parent", "root")).out, /node:a\s+created/);
    await s.tira("create", "node", "b", "--parent", "root", "kind=discovered", "discovered_during=a", "--actor", "isha");
    assert.equal((await s.tira("create", "node", "x", "--parent", "ghost")).code, 2); // unknown-parent
    assert.equal((await s.tira("send", "node", "a", "START", "--parent", "root")).code, 1); // usage
    const tree = (await s.tira("tree")).out;
    assert.match(tree, /cursor node:a · active —/);
    assert.match(tree, /^├─ a\s+unstarted\s+◆ cursor$/m);
    assert.match(tree, /^└─ b\s+unstarted\s+found during a$/m);
    const out = join(s.dir, "page.html");
    const rendered = await s.tira("render", "--out", out);
    assert.equal(rendered.code, 0);
    const hash = (await s.tira("dump", "--hash")).out.slice("sha256:".length, "sha256:".length + 64);
    assert.match(rendered.out, new RegExp(`3 node\\(s\\) · seq \\d+ · sha256:${hash}$`));
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(out, "utf8");
    assert.match(html, new RegExp(`data-dump-hash="${hash}"`));
    assert.equal((html.match(/data-key="node:/g) ?? []).length, 3);
    const types = JSON.parse((await s.tira("log", "--json")).out).map((e: { type: string }) => e.type);
    assert.deepEqual(types.slice(0, 3), ["node.born", "node.born", "node.born"]);
  } finally {
    s.done();
  }
});

test("types lists entity types with their states and events", async () => {
  const out: string[] = [];
  assert.equal(await run(["types"], { out: (l) => out.push(l), err: () => {}, env: {} }), 0);
  assert.match(out.join("\n"), /node\n\s+lifecycle: states unstarted, in_progress, blocked, done, cancelled \(starts unstarted\)/);
  assert.match(out.join("\n"), /events DRAFT_FILE, APPROVE_FILE/);
});

test("environment defaults: TIRA_DB, TIRA_STREAM, TIRA_ACTOR", async () => {
  const s = sandbox();
  try {
    const env = { TIRA_DB: s.db, TIRA_STREAM: "tasktree-env", TIRA_ACTOR: "env-actor" };
    const io = (out: string[]) => ({ out: (l: string) => out.push(l), err: () => {}, env });
    assert.equal(await run(["create", "node", "a"], io([])), 0);
    const out: string[] = [];
    await run(["log"], io(out));
    assert.match(out.join("\n"), /stream tasktree-env · 1 event/);
    assert.match(out.join("\n"), /node:a\s+env-actor/);
  } finally {
    s.done();
  }
});

test("end to end: the real entry script, exit codes included", () => {
  const s = sandbox();
  try {
    const script = fileURLToPath(new URL("../scripts/tira.ts", import.meta.url));
    const tira = (...argv: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--db", s.db, ...argv], { encoding: "utf8" });
    assert.equal(tira("create", "node", "a").status, 0);
    const rejected = tira("send", "node", "a", "REOPEN");
    assert.equal(rejected.status, 2);
    assert.match(rejected.stdout, /REJECTED/);
    const bad = tira("nope");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown command/);
    assert.match(tira("state").stdout, /node:a\s+unstarted/);
  } finally {
    s.done();
  }
});

test("end to end: plain `node scripts/tira.ts` (no flags) prints no SQLite warning", () => {
  const s = sandbox();
  try {
    const script = fileURLToPath(new URL("../scripts/tira.ts", import.meta.url));
    const r = spawnSync(process.execPath, [script, "--db", s.db, "create", "node", "a"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning|SQLite/);
    assert.equal(r.stderr, "");
  } finally {
    s.done();
  }
});
