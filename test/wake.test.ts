// An agent that starts when it's @mentioned (src/serve/wake.ts; Isha, 2026-10-26): its Claude Code
// routine, set up once in Connect agents, starts with what was asked when a person @mentions the
// agent on a task or gives it one; only Anthropic's routine address is ever called; the token isn't
// shown again; the same agent isn't started twice on a task within a few minutes; the session shows
// on the task.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { tiraServer } from "../src/serve/server.ts";
import { MemoryAgentTokens } from "../src/mcp/tokens.ts";
import { wakesOf } from "../src/sync/credentials.ts";
import { AGAIN_AFTER_MS, ANTHROPIC_VERSION, fireRoutine, routineProblem, WakeGate, wakeText } from "../src/serve/wake.ts";

const S = "tasktree-dash";
const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire";
const TOKEN_OK = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

test("a routine is Anthropic's routine address and its token, nothing else", () => {
  assert.equal(routineProblem(URL_OK, TOKEN_OK), undefined);
  for (const url of ["https://example.com/v1/claude_code/routines/trig_01ABCdef/fire", "http://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire", `${URL_OK}?x=1`, "https://api.anthropic.com/v1/messages"]) {
    assert.match(routineProblem(url, TOKEN_OK) ?? "", /isn't a routine's API address/, url);
  }
  for (const token of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-ant-oat01-short", "", "sk-ant-oat01-has space in it xxxxxxxx"]) {
    assert.match(routineProblem(URL_OK, token) ?? "", /isn't a routine's token/, token);
  }
});

test("a run starts with who asked what, on which task, and how to answer through tira", () => {
  const said = wakeText({ agent: "claude", by: "isha", key: "TIRA_TIRA_2", title: "Decide v1 scope", project: "LinkedIn jobs", why: "mentioned", words: "@claude can you draft it?" });
  assert.match(said, /^tira: isha mentioned you \(@claude\) on TIRA_TIRA_2, "Decide v1 scope", in the project "LinkedIn jobs"\./);
  assert.match(said, /What they wrote:\n@claude can you draft it\?/);
  assert.match(said, /get_task TIRA_TIRA_2[^]*add_comment[^]*complete_task with its proof[^]*short bullet points/);
  assert.match(wakeText({ agent: "claude", by: "isha", key: "K_1", title: "t", project: "p", why: "assigned" }), /^tira: isha gave you K_1,/);
});

test("not twice on the same task within a few minutes; another task, or later, starts again", () => {
  let t = 1_000;
  const gate = new WakeGate(() => t);
  assert.equal(gate.open(S, "a", "claude"), true);
  assert.equal(gate.open(S, "a", "claude"), false);
  assert.equal(gate.open(S, "b", "claude"), true);
  assert.equal(gate.open(S, "a", "codex-agent"), true);
  t += AGAIN_AFTER_MS;
  assert.equal(gate.open(S, "a", "claude"), true);
});

test("the call: one POST to the routine, its token and version, what was asked; the session comes back; a refusal says why", async () => {
  const was = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { type: "routine_fire", claude_code_session_id: "session_01", claude_code_session_url: "https://claude.ai/code/session_01" } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  try {
    assert.deepEqual(await fireRoutine(URL_OK, TOKEN_OK, "hello"), { ok: true, session: "https://claude.ai/code/session_01" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, URL_OK);
    assert.deepEqual(calls[0]?.init.headers, { Authorization: `Bearer ${TOKEN_OK}`, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json" });
    assert.equal(calls[0]?.init.body, JSON.stringify({ text: "hello" }));
    answer = { status: 401, body: { type: "error", error: { type: "authentication_error" } } };
    assert.deepEqual(await fireRoutine(URL_OK, TOKEN_OK, "x"), { ok: false, why: "the routine's token was refused: make a new one and save it again" });
    answer = { status: 429, body: {} };
    assert.match((await fireRoutine(URL_OK, TOKEN_OK, "x")).ok ? "" : "too often", /too often/);
    answer = { status: 200, body: { claude_code_session_url: "https://evil.example/s" } }; // only a claude.ai session counts
    assert.equal((await fireRoutine(URL_OK, TOKEN_OK, "x")).ok, false);
    assert.deepEqual(await fireRoutine("https://example.com/fire", TOKEN_OK, "x"), { ok: false, why: "its address isn't a routine's" });
    assert.equal(calls.length, 4); // the last one never left
  } finally {
    globalThis.fetch = was;
  }
});

// tira serve on this computer, a task and an agent connected to it; the routine's call stood in for
async function served() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "decide_scope" }, actor: "isha", payload: {} });
  await wp.submit({ stream: S, kind: "create", entity: { type: "ticket", id: "decide_scope", version: 1 }, actor: "isha", payload: { task: "decide_scope", title: "Decide v1 scope" } });
  const home = mkdtempSync(join(tmpdir(), "tira-wake-"));
  const env = { TIRA_HOME: home };
  const tokens = new MemoryAgentTokens();
  await tokens.create(S, "claude", "isha", "claude-code");
  const fired: { url: string; token: string; text: string }[] = [];
  const fireRoutine = async (url: string, token: string, text: string) => {
    fired.push({ url, token, text });
    return { ok: true as const, session: `https://claude.ai/code/session_${fired.length}` };
  };
  const server = tiraServer({ store, registry, stream: S, actor: "isha", token: "k", links: { env, agentTokens: tokens, fireRoutine } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const http = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }) };
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const post = async (path: string, fields: Record<string, string>) => {
    const r = await http("POST", path, new URLSearchParams({ token: "k", ...fields }).toString());
    const page = r.location ? (await http("GET", r.location)).body : r.body;
    return /data-flash>([^<]*)</.exec(page)?.[1] ?? "";
  };
  return { env, fired, http, post, done: async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(home, { recursive: true, force: true }); } };
}

test("set up once in Connect agents, then a person's @mention or a task given to it starts the agent's routine, once; its session shows on the task", async () => {
  const s = await served();
  try {
    // in the main flow, under Claude Code: what it does, and Set it up, which plays the five steps,
    // then the prompt, which agent (the connected one picked) and its routine (Isha, 2026-10-26)
    const settings = (await s.http("GET", "/integrations")).body;
    assert.match(settings, /<div class="agent-wake-card" data-agent-wake-card><h3>[^]*?Let it start when you @mention it[^]*?<details class="wake-setup" data-wake-setup><summary class="act">Set it up<\/summary><div class="wake-body"><div class="cplay" data-cplay>[^]*?Open claude\.ai\/code\/routines[^]*?You work tasks in tira, through its connector\.[^]*?<form method="post" action="\/integrations\/agents\/wake" class="wake-form" data-agent-wake-form>[^]*?<option value="claude" selected>claude<\/option>/);
    assert.match(settings, /needs tira at a public address, like your hosted tira/); // the routine reaches tira over the internet
    // nothing but a routine's address and token is kept
    assert.equal(await s.post("/integrations/agents/wake", { agent: "claude", routine_url: "https://example.com/fire", routine_token: TOKEN_OK }), "That isn&#39;t a routine&#39;s API address: it looks like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire.");
    assert.equal(await s.post("/integrations/agents/wake", { agent: "nobody", routine_url: URL_OK, routine_token: TOKEN_OK }), "That agent isn&#39;t connected to this project.");
    assert.equal(await s.post("/integrations/agents/wake", { agent: "claude", routine_url: URL_OK, routine_token: TOKEN_OK }), "claude starts when it&#39;s @mentioned now.");
    assert.deepEqual(wakesOf(S, s.env).map((w) => [w.agent, w.url, w.token, w.by]), [["claude", URL_OK, TOKEN_OK, "isha"]]);
    const after = (await s.http("GET", "/integrations")).body;
    assert.match(after, /<p class="wake-now" data-wake-on><span class="wake-on">●<\/span> claude starts when @mentioned\.<\/p>/);
    assert.match(after, /<div class="agent-row" data-agent="claude">[^]*?starts when it(?:'|&#39;)s @mentioned[^]*?data-agent-wake-off>[^]*?Stop starting on @mention/);
    assert.doesNotMatch(after, new RegExp(TOKEN_OK)); // never shown again
    // a comment that @mentions it: the routine starts with what was asked, and the page says so
    assert.equal(await s.post("/comments", { task: "decide_scope", back: "#t0", text: "@claude can you draft the scope?" }), "Comment added. claude is starting on it.");
    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0]?.url, URL_OK);
    assert.equal(s.fired[0]?.token, TOKEN_OK);
    assert.match(s.fired[0]?.text ?? "", /^tira: isha mentioned you \(@claude\) on TIRA_TASKTREE_DASH_1, "Decide v1 scope", in the project "tasktree-dash"\.[^]*@claude can you draft the scope\?/);
    // its session, on the task
    const board = (await s.http("GET", "/")).body;
    assert.match(board, /<p class="wake-run" data-wake-run="claude">[^]*?<b>claude<\/b> started on this when isha asked · <a href="https:\/\/claude\.ai\/code\/session_1" target="_blank" rel="noopener noreferrer">Watch its session ↗<\/a>/);
    // a second mention moments later: the run already going reads it; no second start
    assert.equal(await s.post("/comments", { task: "decide_scope", back: "#t0", text: "@claude also check remote roles" }), "Comment added.");
    assert.equal(s.fired.length, 1);
    // a comment that names no agent with a routine starts nothing
    assert.equal(await s.post("/comments", { task: "decide_scope", back: "#t0", text: "Note to self: @devansh agrees." }), "Comment added.");
    assert.equal(s.fired.length, 1);
    // turned off: it won't start on its own any more
    assert.equal(await s.post("/integrations/agents/wake", { agent: "claude", do: "off" }), "claude won&#39;t start on its own any more.");
    assert.deepEqual(wakesOf(S, s.env), []);
  } finally {
    await s.done();
  }
});

test("a task given to an agent with a routine starts it; giving it to a person, or saving it again, doesn't", async () => {
  const s = await served();
  try {
    await s.post("/integrations/agents/wake", { agent: "claude", routine_url: URL_OK, routine_token: TOKEN_OK });
    assert.equal(await s.post("/tickets", { task: "decide_scope", back: "#t0", title: "Decide v1 scope", assignee: "claude" }), "Saved. claude is starting on it.");
    assert.equal(s.fired.length, 1);
    assert.match(s.fired[0]?.text ?? "", /^tira: isha gave you TIRA_TASKTREE_DASH_1, "Decide v1 scope"/);
    assert.equal(await s.post("/tickets", { task: "decide_scope", back: "#t0", title: "Decide v1 scope, again", assignee: "claude" }), "Saved."); // still its: nothing new to start
    assert.equal(s.fired.length, 1);
  } finally {
    await s.done();
  }
});
