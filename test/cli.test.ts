// tira CLI: commands, exit codes, payload parsing, persistence across runs, and one
// end-to-end spawn of the real entry script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/cli.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";

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
    assert.match((await s.tira("state")).out, /^claimable now \(1\): brief:b@1$/m);
    const v2 = await s.tira("create", "brief", "b", "--version", "2", "--actor", "orchestrator", "supersedes=1");
    assert.equal(v2.code, 0, v2.out);
    // the fx: key a factory transition uses, the same as the library computes; a malformed fx: id is a usage error
    const { fxKey } = await import("../src/write/fxkey.ts");
    const k = await s.tira("key", "brief", "b", "DISPATCHED", "--version", "1", "--actor", "orchestrator", "--stream", "tasktree-main");
    assert.equal(k.out, fxKey({ stream: "tasktree-main", entity: { type: "brief", id: "b", version: 1 }, event: "DISPATCHED", actor: "orchestrator", payload: {} }));
    const birth = await s.tira("key", "drop", "b", "--version", "1", "--actor", "s1");
    assert.equal(birth.out, fxKey({ stream: "tasktree-main", entity: { type: "drop", id: "b", version: 1 }, event: "FILED", actor: "s1", payload: {} }));
    const malformed = await s.tira("send", "brief", "b", "DENIED", "--version", "1", "--actor", "orchestrator", "--event-id", "fx:nope", "reason=x");
    assert.equal(malformed.code, 1);
    assert.match(malformed.err, /fx: eventId must be fx: \+ 64 lowercase hex/);
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
    await s.tira("send", "node", "a", "BLOCK", "reason=waiting");
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

test("tira key: checks what send would refuse without a log, never opens the store, and its key is accepted by send", async () => {
  const s = sandbox();
  try {
    const { existsSync } = await import("node:fs");
    for (const [argv, why] of [
      [["key", "brief", "b", "DISPATCHED", "--actor", "orchestrator"], /brief is versioned: pass --version/],
      [["key", "session", "s1", "--version", "1", "--actor", "s1"], /session is not versioned: drop --version/],
      [["key", "brief", "b", "DISPATCHED", "--version", "0"], /entity.version must be an integer >= 1/],
      [["key", "brief", "b", "DISPATCHED", "--version", "x"], /entity.version must be an integer >= 1/],
      [["key", "brief", "b", "NOPE", "--version", "1"], /unknown event: brief.NOPE/],
      [["key", "gizmo", "g"], /unknown entity type: gizmo/],
      [["key", "brief", "b", "DISPATCHED", "--version", "1", "--parent", "p"], /--parent only applies to create/],
      [["key", "brief", "b", "DISPATCHED", "--version", "1", "--event-id", "fx:x"], /tira key prints the event id/],
    ] as [string[], RegExp][]) {
      const r = await s.tira(...argv);
      assert.equal(r.code, 1, argv.join(" "));
      assert.match(r.err, why, argv.join(" "));
    }
    const born = await s.tira("key", "brief", "b", "--version", "1", "--actor", "orchestrator", "slice_ref=slice/b");
    assert.equal(born.code, 0);
    assert.equal(existsSync(s.db), false); // key reads nothing and writes nothing
    // send accepts the key key printed, retries are duplicates, and any other well-formed fx: id is refused
    const send = ["create", "brief", "b", "--version", "1", "--actor", "orchestrator", "slice_ref=slice/b", "--event-id"];
    assert.equal((await s.tira(...send, born.out)).code, 0);
    assert.match((await s.tira(...send, born.out)).out, /duplicate/);
    const wrong = await s.tira("send", "brief", "b", "DISPATCHED", "--version", "1", "--actor", "orchestrator", "--event-id", born.out);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /isn't this transition's fx: key \(it would be fx:[0-9a-f]{64};/);
    // --payload keeps JSON types; key=value gives strings: different payloads, different keys
    const typed = await s.tira("key", "brief", "b", "DISPATCHED", "--version", "1", "--payload", '{"n":1}');
    const text = await s.tira("key", "brief", "b", "DISPATCHED", "--version", "1", "n=1");
    assert.notEqual(typed.out, text.out);
    // state --now takes the same strict times
    const now = await s.tira("state", "--now", "2026-10-19T09:00:00");
    assert.equal(now.code, 1);
    assert.match(now.err, /--now must be an ISO-8601 date-time with a zone/);
    assert.equal((await s.tira("state", "--now", "2026-10-19T09:00:00+05:30")).code, 0);
  } finally {
    s.done();
  }
});

test("tira sweep: exits 0 with things to look at, 3 when something is broken; --json and --at", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "app", "definition=the app", "done_criteria=it ships");
    await s.tira("create", "node", "a", "--parent", "app");
    const ok = await s.tira("sweep");
    assert.equal(ok.code, 0);
    assert.match(ok.out, /^health sweep · stream tasktree-main · as of seq 2$/m);
    assert.match(ok.out, /^ok {4}no closed parent has open work$/m);
    assert.match(ok.out, /^look {2}every task says what it is and when it's done \(1\)\n {6}node:a {2}no definition or done_criteria$/m);
    assert.match(ok.out, /^nothing broken; 1 to look at$/m);
    const json = JSON.parse((await s.tira("sweep", "--json")).out) as { broken: number; attention: number; atSeq: number };
    assert.deepEqual([json.broken, json.attention, json.atSeq], [0, 1, 2]);
    // an event appended past the write path
    const { SqliteEventStore } = await import("../src/store/sqlite-store.ts");
    const raw = new SqliteEventStore({ path: s.db });
    await raw.append("tasktree-main", [{ type: "node.complete", data: { entity: { id: "a" }, payload: {} } }]);
    raw.close();
    const bad = await s.tira("sweep");
    assert.equal(bad.code, 3);
    assert.match(bad.out, /^FAIL {2}the log follows the rules \(1\)\n {6}seq 3 {2}node\.complete: denied/m);
    assert.match(bad.out, /^1 broken; 1 to look at$/m);
    const before = await s.tira("sweep", "--at", "2");
    assert.equal(before.code, 0);
    assert.match(before.out, /as of seq 2$/m);
    assert.equal((await s.tira("sweep", "--at", "x")).code, 1);
  } finally {
    s.done();
  }
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

// --- the divergence panel's callers (B3 watchdog, the wiring slice) --------------------------
// render and serve compute the report in-process, at render time, from the factory file and the
// stream the page shows. The run log (docs/divergence-run-log.jsonl, or $TIRA_DIVERGENCE_LOG) is
// a record the divergence command appends; no page reads it back.

const B3 = fileURLToPath(new URL("../fixtures/b3/", import.meta.url));
const B3_FACTORY = join(B3, "factory-state.jsonl");
const B3_TIRA = join(B3, "tira-log.jsonl");
const B3_COUNTS = { OK: 39, MISSING: 2, PHANTOM: 2, "WRONG-ENTITY": 2, DUPLICATE: 1, ORPHAN: 1 };

async function b3Db(dir: string): Promise<string> {
  const db = join(dir, "b3.db");
  const store = new SqliteEventStore({ path: db });
  try {
    for (const l of readFileSync(B3_TIRA, "utf8").trim().split("\n")) {
      const e = JSON.parse(l) as { stream: string; eventId: string; type: string; data: Record<string, unknown>; metadata: Record<string, string> };
      await store.append(e.stream, [{ eventId: e.eventId, type: e.type, data: e.data, metadata: e.metadata }]);
    }
  } finally {
    store.close();
  }
  return db;
}

const panelCounts = (html: string) => {
  const sec = html.match(/<section class="divergence[^"]*"[\s\S]*?<\/section>/)?.[0] ?? "";
  return { sec, state: sec.match(/data-divergence-state="([^"]+)"/)?.[1], counts: Object.fromEntries([...sec.matchAll(/data-verdict="([A-Z-]+)" data-count="(\d+)"/g)].map(([, v, c]) => [v, Number(c)])) };
};

async function cliRun(argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("divergence wiring: the CLI report and the rendered page agree on the B3 pair; tira divergence also takes $TIRA_FACTORY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-cli-wired-"));
  try {
    const db = await b3Db(dir);
    const env = { TIRA_DIVERGENCE_LOG: join(dir, "run-log.jsonl") };
    const flag = await cliRun(["--db", db, "divergence", "--factory", B3_FACTORY, "--stream", "factory-b3", "--json"], env);
    const viaEnv = await cliRun(["--db", db, "divergence", "--stream", "factory-b3", "--json"], { ...env, TIRA_FACTORY: B3_FACTORY });
    assert.equal(flag.code, 0, flag.err);
    assert.equal(viaEnv.code, 0, viaEnv.err);
    const report = JSON.parse(flag.out) as { counts: Record<string, number> };
    assert.deepEqual(report.counts, B3_COUNTS);
    assert.deepEqual((JSON.parse(viaEnv.out) as { counts: Record<string, number> }).counts, B3_COUNTS);
    const out = join(dir, "page.html");
    assert.equal((await cliRun(["--db", db, "--stream", "factory-b3", "render", "--factory", B3_FACTORY, "--out", out], env)).code, 0);
    assert.deepEqual(panelCounts(readFileSync(out, "utf8")).counts, report.counts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("divergence wiring: tira serve recomputes the section on every page load, UNEVALUABLE without a factory file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-serve-wired-"));
  const script = fileURLToPath(new URL("../scripts/tira.ts", import.meta.url));
  const serveOnce = async (flags: string[], before?: (port: number) => Promise<void>) => {
    const db = join(dir, "b3.db");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--db", db, "--stream", "factory-b3", "serve", "--actor", "isha", "--port", "0", ...flags], { env: { ...process.env, TIRA_FACTORY: "", TIRA_DIVERGENCE_LOG: join(dir, "run-log.jsonl") } });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buf = "";
        child.stdout.on("data", (d: Buffer) => { buf += d.toString(); const m = buf.match(/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
        child.once("exit", (c) => reject(new Error(`serve exited ${c} before listening`)));
      });
      await before?.(port);
      return await (await fetch(`http://127.0.0.1:${port}/`)).text();
    } finally {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
  };
  try {
    await b3Db(dir);
    const live = panelCounts(await serveOnce(["--factory", B3_FACTORY]));
    assert.equal(live.state, "divergent");
    assert.deepEqual(live.counts, B3_COUNTS);
    // a changed factory file shows on the next load of the same server: nothing was kept
    const fac = join(dir, "factory.jsonl");
    const first = readFileSync(B3_FACTORY, "utf8").split("\n")[0] as string;
    writeFileSync(fac, `${first}\n`);
    let firstLoad = "";
    const reload = panelCounts(await serveOnce(["--factory", fac], async (port) => {
      firstLoad = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      writeFileSync(fac, readFileSync(B3_FACTORY));
    }));
    assert.equal(panelCounts(firstLoad).counts.OK, 1);
    assert.deepEqual(reload.counts, B3_COUNTS);
    const none = panelCounts(await serveOnce([]));
    assert.equal(none.state, "unevaluable");
    assert.match(none.sec, /no factory file/);
    assert.doesNotMatch(none.sec, /data-count=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("divergence wiring: no page reads a stored report — a poisoned run log changes nothing, and only the divergence command touches it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-cli-stored-"));
  try {
    const db = await b3Db(dir);
    // a run-log row that disagrees with every live count
    const log = join(dir, "run-log.jsonl");
    const poison = { ts: "2026-10-20T00:00:00.000Z", factorySnapshot: "0".repeat(64), stream: "factory-b3", atSeq: 65, population: { factoryRecords: 46, tiraFxEvents: 45, ids: 47 }, counts: { OK: 47, MISSING: 0, PHANTOM: 0, "WRONG-ENTITY": 0, DUPLICATE: 0, ORPHAN: 0 }, severityPolicy: "v1" };
    appendFileSync(log, `${JSON.stringify(poison)}\n`);
    const before = readFileSync(log, "utf8");
    const env = { TIRA_DIVERGENCE_LOG: log };
    const out = join(dir, "page.html");
    assert.equal((await cliRun(["--db", db, "--stream", "factory-b3", "render", "--factory", B3_FACTORY, "--out", out], env)).code, 0);
    const p = panelCounts(readFileSync(out, "utf8"));
    assert.deepEqual(p.counts, B3_COUNTS);
    assert.doesNotMatch(p.sec, new RegExp("0".repeat(64)));
    // no factory file: the stored row is right there, and the page still claims nothing
    assert.equal((await cliRun(["--db", db, "--stream", "factory-b3", "render", "--out", out], env)).code, 0);
    assert.equal(panelCounts(readFileSync(out, "utf8")).state, "unevaluable");
    // rendering is not a run: it appends nothing to the log
    assert.equal(readFileSync(log, "utf8"), before);
    // structurally: the page path never names the log, and cli.ts only appends to it
    const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
    for (const f of ["render/html.ts", "serve/server.ts", "divergence/divergence.ts"]) {
      assert.doesNotMatch(src(f), /divergence-run-log|TIRA_DIVERGENCE_LOG|RUN_LOG/, f);
    }
    const uses = src("cli/cli.ts").split("\n").filter((l) => /\bRUN_LOG\b|TIRA_DIVERGENCE_LOG/.test(l) && !l.trimStart().startsWith("//"));
    assert.deepEqual(uses.map((l) => l.trim()), [
      `const RUN_LOG = fileURLToPath(new URL("../../docs/divergence-run-log.jsonl", import.meta.url));`,
      "appendFileSync(io.env.TIRA_DIVERGENCE_LOG ?? RUN_LOG, `${JSON.stringify(row)}\\n`);",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
