// tira for agents (src/mcp, `tira mcp`): an MCP server for one project, under one agent's own
// name, whose tools read and write through tira's own rules.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { run } from "../src/cli/cli.ts";
import { agentNameProblem, DISCONNECTED, tiraMcpServer } from "../src/mcp/server.ts";
import { agentTokensFor, tokenHash, freeName, MemoryAgentTokens } from "../src/mcp/tokens.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { freshPgDb, needsPg } from "./test-stores.ts";
import { openStore } from "../src/store/open.ts";
import { APPS, appSetup, databaseCheck, serverName, TIRA_SCRIPT, TOKEN_HERE } from "../src/mcp/connect.ts";
import { tiraServer } from "../src/serve/server.ts";
import { esc } from "../src/render/escape.ts";

const S = "demo";

// A small project: a site with a header, a footer and an api blocked on its key.
async function world() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent_id?: string) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await born("site");
  for (const id of ["header", "footer", "api"]) await born(id, "site");
  await send("api", "START");
  await send("api", "BLOCK", { reason: "waiting on the key" });
  return { store, registry, send };
}

// tira mcp's server for the project, with the official MCP client on the other end of a pipe
async function connected(w: Awaited<ReturnType<typeof world>>, actor = "claude-code", stillConnected?: () => Promise<boolean>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await tiraMcpServer({ store: w.store, registry: w.registry, stream: S, actor, ...(stillConnected ? { stillConnected } : {}) }).connect(serverSide);
  const client = new Client({ name: "tira-tests", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
  };
  return { client, call };
}

test("an agent's name: its own, never a person's nor tira's own writers'; tira mcp starts only with a valid token, and says why on stderr before it opens anything", async () => {
  for (const ok of ["claude-code", "claude", "codex-review", "factory-s3", "research-agent", "triage-bot", "cursor-agent", "vscode-agent", "claude-desktop"]) assert.equal(agentNameProblem(ok), undefined, ok);
  for (const blank of [undefined, "  "]) assert.equal(agentNameProblem(blank), "Give the agent a name of its own, e.g. claude-code.");
  assert.match(agentNameProblem("isha") ?? "", /^"isha" reads as a person's name: an agent acts under an agent's name/);
  for (const reserved of ["tira", "dispatcher", "sync"]) assert.match(agentNameProblem(reserved) ?? "", /is reserved for tira's, the dispatcher's and the sync's own writes/, reserved);
  for (const odd of ["claude code", "claude-code x", "claude/../x"]) assert.match(agentNameProblem(odd) ?? "", /can't be an agent's name: letters, digits/, odd);
  // the command: no token, an unknown or revoked one, another project's; nothing on stdout (the protocol's), no store opened
  const tokens = new MemoryAgentTokens();
  const { token } = await tokens.create("demo", "claude-code", "isha");
  const gone = (await tokens.create("demo", "old-agent", "isha")).token;
  await tokens.revoke((await tokens.find(gone))?.id ?? "");
  const cases: [string[], Record<string, string>, RegExp][] = [
    [["mcp"], {}, /^tira: tira mcp needs its agent's token \(TIRA_AGENT_TOKEN\): connect the agent in Project settings → Connect agents/],
    [["mcp"], { TIRA_AGENT_TOKEN: "tira_nope_x" }, /^tira: that agent token isn't valid: it was revoked, or wasn't made on this tira\./],
    [["mcp"], { TIRA_AGENT_TOKEN: gone }, /^tira: that agent token isn't valid/],
    [["--stream", "other", "mcp"], { TIRA_AGENT_TOKEN: token }, /^tira: this agent's token is for demo, not other$/],
  ];
  for (const [argv, env, why] of cases) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, agentTokens: tokens, openStore: () => { throw new Error("no store should open"); } });
    assert.equal(code, 1, argv.join(" "));
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), why);
  }
});

test("tira mcp reads the board: what's next, the task list in the board's order, and one task with its history, block and proof", async () => {
  const w = await world();
  const { client, call } = await connected(w);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.slice(0, 3).map((x) => x.name), ["next_task", "list_tasks", "get_task"]);
    for (const tool of tools.slice(0, 3)) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.deepEqual(await call("next_task"), { error: false, text: 'In progress: nothing.\nNext: header (under site)\nBlocked: 1 (list_tasks with state "blocked" shows them)' });
    assert.deepEqual(await call("list_tasks"), { error: false, text: "site · to do · top level\nheader · to do · under site · ◆ next\nfooter · to do · under site\napi · blocked · under site" });
    assert.deepEqual(await call("list_tasks", { state: "blocked" }), { error: false, text: "api · blocked · under site" });
    assert.deepEqual(await call("list_tasks", { state: "done" }), { error: false, text: "No done tasks in demo." });
    assert.equal((await call("list_tasks", { state: "weird" })).error, true); // the schema says no
    const api = await call("get_task", { id: "api" });
    assert.equal(api.error, false);
    assert.match(api.text, /^api · blocked · under site\nBlocked: waiting on the key\nHistory:\n  seq 4 · node.born · isha · under site\n  seq 5 · node.start · isha\n  seq 6 · node.block · isha · reason waiting on the key$/);
    assert.deepEqual(await call("get_task", { id: "nope" }), { error: true, text: "There is no task nope in demo: list_tasks shows them." });
    // the one in progress, not listed again as next; once done, its proof
    await w.send("header", "START");
    assert.match((await call("next_task")).text, /^In progress: header \(under site\)\nBlocked: 1/);
    await w.send("header", "COMPLETE", { evidenceRef: "header.png" });
    assert.deepEqual(await call("list_tasks"), { error: false, text: "site · to do · top level\nfooter · to do · under site · ◆ next\napi · blocked · under site" }); // done: off the open list
    assert.match((await call("get_task", { id: "header" })).text, /^header · done · under site\nProof: header.png \(from isha, seq 8\)\nHistory:/);
    assert.match((await call("get_task", { id: "site" })).text, /^site · to do · top level\nSubtasks: header \(done\), footer \(to do\), api \(blocked\)\n/);
  } finally {
    await client.close();
  }
});

test("tira mcp acts through tira's rules, as the agent: start, complete with proof, block on a task or a new ticket, add a subtask, file an idea; refusals say what to do", async () => {
  const w = await world();
  const { client, call } = await connected(w);
  const logged = async () => (await w.store.readStream(S)).length;
  try {
    // only these: no cancel, reopen, unblock, delete or settings for an agent
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((x) => x.name), ["next_task", "list_tasks", "get_task", "start_task", "complete_task", "block_task", "add_subtask", "file_idea"]);
    for (const tool of tools.slice(3)) assert.deepEqual([tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint], [false, false], tool.name);
    assert.deepEqual(await call("start_task", { id: "header" }), { error: false, text: "Start header: done (seq 7)." });
    assert.match((await call("get_task", { id: "header" })).text, /\n  seq 7 · node.start · claude-code$/); // as the agent
    // one in progress at a time: refused, with the board's hint (the refusal is in the log, as from the CLI)
    assert.deepEqual(await call("start_task", { id: "footer" }), { error: true, text: "Start footer: refused (gate: one active task: node:header is already active). The refusal is in the log (seq 8). What to do: Only one task can be in progress. Complete or block header first, then start footer." });
    // a subtask under work in progress is found while working on it
    assert.deepEqual(await call("add_subtask", { under: "header", name: "header_logo" }), { error: false, text: "Add subtask header_logo under header: done (seq 9)." });
    assert.match((await call("get_task", { id: "header_logo" })).text, /^header_logo · to do · under site › header · ◆ next · found during header\n/);
    assert.match((await call("add_subtask", { under: "footer", name: "footer_links" })).text, /^Add subtask footer_links under footer: done/);
    assert.doesNotMatch((await call("get_task", { id: "footer_links" })).text, /found during/); // footer isn't under way
    // proof of work, and the rules' order
    const unproved = await logged();
    for (const args of [{ id: "header" }, { id: "header", proof: "   " }]) { // no proof, or blank: the schema says no, before the log
      const r = await call("complete_task", args);
      assert.equal(r.error, true);
      assert.match(r.text, /^Input validation error: Invalid arguments for tool complete_task: proof/);
    }
    assert.equal(await logged(), unproved);
    assert.match((await call("complete_task", { id: "header", proof: "pr/1" })).text, /^Complete header: refused \(gate: .*\)\. The refusal is in the log \(seq \d+\)\. What to do: Close its open subtasks first \(complete or cancel them\): header_logo\.$/);
    assert.match((await call("complete_task", { id: "header_logo", proof: "logo.png" })).text, /What to do: Start header_logo first\.$/);
    // blocked, waiting on a new ticket made under it, found while working on it
    assert.match((await call("block_task", { id: "footer", reason: "waiting on copy", new_ticket: "footer_copy" })).text, /^Add subtask footer_copy under footer: done \(seq \d+\)\. Block footer: done \(seq \d+\)\.$/);
    const footer = (await call("get_task", { id: "footer" })).text;
    assert.match(footer, /^footer · blocked · under site\nSubtasks: footer_links \(to do\), footer_copy \(to do\)\nBlocked: waiting on copy\nWaiting on: footer_copy\n/);
    assert.match(footer, /node.block · claude-code · reason waiting on copy · blocked by footer_copy$/);
    assert.match((await call("get_task", { id: "footer_copy" })).text, /found during footer/);
    // or on an open task; never on one that isn't there, nor on two things; nothing written then
    assert.match((await call("block_task", { id: "header", reason: "needs the api", waits_on: "api" })).text, /^Block header: done \(seq \d+\)\.$/);
    assert.match((await call("get_task", { id: "header" })).text, /\nWaiting on: api\n/);
    const before = await logged();
    assert.deepEqual(await call("block_task", { id: "footer_links", reason: "x", waits_on: "nope" }), { error: true, text: "There is no task nope for footer_links to wait on: to wait on a new ticket, name it in new_ticket instead. Nothing was written." });
    assert.deepEqual(await call("block_task", { id: "footer_links", reason: "x", waits_on: "api", new_ticket: "more" }), { error: true, text: "Name what it waits on once: an open task (waits_on) or a new ticket (new_ticket), not both. Nothing was written." });
    assert.match((await call("block_task", { id: "footer_links", reason: "x", waits_on: "site" })).text, /^footer_links can't wait on that: footer_links sits under site: a task can't wait on what it is part of\. Nothing was written\.$/);
    assert.deepEqual(await call("start_task", { id: "nope" }), { error: true, text: "There is no task nope in demo: list_tasks shows them. Nothing was written." });
    assert.equal(await logged(), before);
    // an idea, filed: tira proposes where it goes; a person approves
    const idea = await call("file_idea", { summary: "Add a dark footer", why: "matches the header" });
    assert.equal(idea.error, false);
    assert.match(idea.text, /^File idea \S+: done \(seq \d+\)\.\nidea \S+: "Add a dark footer"\nparent: footer \(.+\)\nnext: a person approves the file/);
  } finally {
    await client.close();
  }
});

test("tira mcp end to end, as Claude Code starts it: over stdio, on Postgres, with the agent's token (the project and the agent come from it); it says so on stderr only, a revoked agent's next call is refused, and it stops when its client does", { skip: needsPg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-mcp-"));
  const script = fileURLToPath(new URL("../scripts/tira.ts", import.meta.url));
  const db = freshPgDb();
  const base: Record<string, string> = { ...(process.env as Record<string, string>), TIRA_DATABASE_URL: db, TIRA_HOME: join(dir, "home"), TIRA_FACTORY: "" };
  const tira = (...argv: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--stream", "e2e", ...argv, "--actor", "isha"], { encoding: "utf8", env: base });
  tira("create", "node", "site");
  tira("create", "node", "header", "--parent", "site");
  const tokens = agentTokensFor(base);
  assert.ok(tokens);
  const made = await tokens.create("e2e", "claude-code", "isha");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", script, "mcp"], env: { ...base, TIRA_AGENT_TOKEN: made.token }, stderr: "pipe" });
  let said = "";
  transport.stderr?.on("data", (d: Buffer) => { said += d.toString(); });
  const client = new Client({ name: "tira-e2e", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text: string }[]).map((c) => c.text).join("\n") };
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    assert.deepEqual(await call("next_task"), { error: false, text: "In progress: nothing.\nNext: header (under site)" });
    assert.match((await call("start_task", { id: "header" })).text, /^Start header: done \(seq 3\)\.$/);
    assert.match(said, /^tira: MCP server for e2e, acting as claude-code \(on stdio; it stops when its client does\)$/m);
    assert.ok((await tokens.list("e2e"))[0]?.lastUsedAt, "it says when the agent was last used");
    // revoked in Project settings: its next call is refused, and nothing more is written
    assert.equal(await tokens.revoke(made.row.id), true);
    assert.deepEqual(await call("next_task"), { error: true, text: DISCONNECTED });
    const t = performance.now();
    await client.close();
    assert.ok(performance.now() - t < 5000, "tira mcp stops promptly when its client does");
    const store = openStore(db);
    try {
      const last = (await store.readStream("e2e")).at(-1);
      assert.deepEqual([last?.type, last?.metadata.actor], ["node.start", "claude-code"]); // as the agent
    } finally {
      await store.close();
    }
  } finally {
    await client.close().catch(() => undefined);
    await tokens.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents' tokens on Postgres: one per agent and project, kept as a tokenHash; listed with who and when; revoked, it's gone", { skip: needsPg }, async () => {
  const tokens = agentTokensFor({ TIRA_DATABASE_URL: freshPgDb() });
  assert.ok(tokens);
  try {
    const a = await tokens.create("p", "claude-code", "isha");
    await tokens.create("q", "claude-code", "isha"); // another project: its own
    assert.match(a.token, /^tira_[0-9a-f]{8}_[0-9a-f]{48}$/);
    assert.deepEqual((await tokens.find(a.token))?.agent, "claude-code");
    assert.deepEqual((await tokens.list("p")).map((x) => [x.agent, x.createdBy]), [["claude-code", "isha"]]);
    await assert.rejects(tokens.create("p", "claude-code", "isha")); // the same name, still connected
    assert.equal(await tokens.revoke(a.row.id), true);
    assert.equal(await tokens.find(a.token), undefined);
    assert.deepEqual(await tokens.list("p"), []);
    assert.equal(await tokens.revoke(a.row.id), false);
  } finally {
    await tokens.close();
  }
});

test("connecting an agent: each app's setup with the agent's token and this tira's Node and script; Cursor's and VS Code's install links; quoted for a shell; how to remove it", () => {
  assert.equal(serverName("factory-ui"), "tira-factory-ui");
  assert.equal(serverName("Isha Portfolio"), "tira-isha-portfolio");
  assert.equal(serverName("***"), "tira-project");
  const l = { node: "/n/node", script: "/t/scripts/tira.ts" };
  const server = { command: "/n/node", args: ["--disable-warning=ExperimentalWarning", "/t/scripts/tira.ts", "mcp"], env: { TIRA_AGENT_TOKEN: "tira_ab12cd34_x" } };
  const code = appSetup("claude-code", "factory-ui", l, "tira_ab12cd34_x");
  assert.equal(code.code, "claude mcp add --scope user --env TIRA_AGENT_TOKEN=tira_ab12cd34_x --transport stdio tira-factory-ui -- /n/node --disable-warning=ExperimentalWarning /t/scripts/tira.ts mcp");
  assert.equal(code.remove, "claude mcp remove tira-factory-ui -s user");
  assert.equal(code.install, undefined);
  assert.match(appSetup("claude-code", "factory-ui", l, TOKEN_HERE).code, /--env TIRA_AGENT_TOKEN='<your token>' --transport stdio/);
  const cursor = appSetup("cursor", "factory-ui", l, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(cursor.code), { mcpServers: { "tira-factory-ui": server } });
  const link = new URL(cursor.install ?? "");
  assert.equal(link.protocol + "//" + link.host + link.pathname, "cursor://anysphere.cursor-deeplink/mcp/install");
  assert.equal(link.searchParams.get("name"), "tira-factory-ui");
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get("config") ?? "", "base64").toString()), server);
  const vscode = appSetup("vscode", "factory-ui", l, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(vscode.code), { servers: { "tira-factory-ui": { type: "stdio", ...server } } });
  const vlink = new URL(vscode.install ?? "");
  assert.equal(vlink.origin + vlink.pathname, "https://insiders.vscode.dev/redirect/mcp/install");
  assert.deepEqual(JSON.parse(vlink.searchParams.get("config") ?? ""), { type: "stdio", ...server });
  const desktop = appSetup("claude-desktop", "factory-ui", l, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(desktop.code), { mcpServers: { "tira-factory-ui": server } });
  assert.equal(desktop.install, undefined);
  assert.deepEqual(desktop.steps, ["In Claude Desktop: Settings → Developer → Edit Config.", "Add the entry below under mcpServers and save.", "Restart Claude Desktop."]);
});

test("agents' tokens: random, kept as a tokenHash, found until revoked; a new agent's name is free in its project", async () => {
  const tokens = new MemoryAgentTokens();
  const a = await tokens.create("demo", "claude-code", "isha");
  assert.match(a.token, /^tira_[0-9a-f]{8}_[0-9a-f]{48}$/);
  assert.notEqual(tokenHash(a.token), a.token);
  assert.equal((await tokens.find(a.token))?.agent, "claude-code");
  await tokens.used(a.row.id);
  assert.ok((await tokens.list("demo"))[0]?.lastUsedAt);
  assert.equal(await tokens.revoke(a.row.id), true);
  assert.equal(await tokens.find(a.token), undefined);
  assert.equal(freeName("claude-code", []), "claude-code");
  assert.equal(freeName("claude-code", ["claude-code", "claude-code-2"]), "claude-code-3");
});

test("a revoked agent's next call is refused, whatever the tool", async () => {
  const w = await world();
  let connectedNow = true;
  const { client, call } = await connected(w, "claude-code", () => Promise.resolve(connectedNow));
  try {
    assert.equal((await call("next_task")).error, false);
    connectedNow = false;
    for (const [name, args] of [["next_task", {}], ["start_task", { id: "footer" }]] as const) assert.deepEqual(await call(name, args), { error: true, text: DISCONNECTED });
    assert.equal((await w.store.readStream(S)).filter((e) => e.metadata.actor === "claude-code").length, 0); // nothing written
  } finally {
    await client.close();
  }
});

test("connecting an agent: whether it would reach this tira's database, from tira's own .env, its values compared and never shown", () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-envfile-"));
  const file = join(dir, ".env");
  try {
    assert.equal(databaseCheck(file, {}), "missing"); // no .env
    writeFileSync(file, "TIRA_HOME=/x\n");
    assert.equal(databaseCheck(file, {}), "missing"); // no database in it
    writeFileSync(file, "TIRA_DATABASE_URL=postgres://u@h/db\nTIRA_SCHEMA=board\n");
    assert.equal(databaseCheck(file, {}), "ready"); // started with --db: nothing to compare
    assert.equal(databaseCheck(file, { TIRA_DATABASE_URL: "postgres://u@h/db", TIRA_SCHEMA: "board" }), "ready");
    assert.equal(databaseCheck(file, { TIRA_DATABASE_URL: "postgres://u@h/db" }), "different"); // another schema
    assert.equal(databaseCheck(file, { TIRA_DATABASE_URL: "postgres://u@h/other", TIRA_SCHEMA: "board" }), "different");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Project settings → Connect agents, after Forge's Connect IDE: one click makes the agent its token and installs it; or by hand, name it and copy the app's setup; connected agents listed with Revoke; the tools; the database check", async () => {
  const w = await world();
  const dir = mkdtempSync(join(tmpdir(), "tira-agents-"));
  const envFile = join(dir, ".env");
  const tokens = new MemoryAgentTokens();
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "k", links: { env: { TIRA_HOME: dir }, envFile, agentTokens: tokens } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const http = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const section = (page: string) => /<section class="grp" id="agents"[^]*?<\/section>/.exec(page)?.[0] ?? "";
  const settings = async (path = "/integrations") => section((await http("GET", path)).body);
  try {
    const page = (await http("GET", "/integrations")).body;
    assert.match(page, /<a class="set-link" href="#sync">Sync<\/a><a class="set-link" href="#agents">Connect agents<\/a><a class="set-link" href="#delete">Delete<\/a>/);
    assert.doesNotMatch((await http("GET", "/settings")).body, /id="agents"|data-agent/); // not in Account settings any more
    let agents = section(page);
    assert.match(agents, /<h2 class="grp-h">Connect agents<\/h2><p class="grp-desc">Connect your AI agents \(Claude Code, Cursor, VS Code, Claude Desktop\) to this project/);
    // quick setup: one Connect, four apps
    assert.match(agents, /<div class="agent-quick" data-agent-quick>[^]*?<details class="agent-menu"><summary class="act primary">Connect<\/summary>/);
    assert.deepEqual([...agents.matchAll(/<input type="hidden" name="app" value="([a-z-]+)">/g)].map((m) => m[1]), [...APPS]);
    // by hand: name it, the apps' setups with the token's place, the check, the tools
    assert.match(agents, /<p class="agent-or">or set up manually<\/p>/);
    assert.match(agents, /<form method="post" action="\/integrations\/agents\/connect" class="agent-name-form" data-agent-name>/);
    assert.match(agents, /<p class="agent-none">No agents connected yet\.<\/p>/);
    assert.ok(agents.includes(esc(appSetup("claude-code", S, { node: process.execPath, script: TIRA_SCRIPT }, TOKEN_HERE).code)), "Claude Code's command, its token's place marked");
    assert.equal((agents.match(/data-agent-app="/g) ?? []).length, 4); // each app's setup, once: no agent just made
    assert.doesNotMatch(agents, /data-agent-install/); // no install link without a real token in it
    assert.match(agents, /<p class="agent-db no" data-agent-database="missing">/);
    assert.match(agents, /<li><code>complete_task<\/code> done, with proof of work<\/li>/);
    assert.match(agents, /Cancelling, reopening and unblocking stay with people\./);
    // one click, Cursor: the agent's token made, and the app's install link to open (here, and for the script)
    const quick = await http("POST", "/integrations/agents/connect", "token=k&app=cursor&fragment=1");
    const go = /data-go="([^"]+)"/.exec(quick.body)?.[1]?.replaceAll("&#38;", "&") ?? "";
    const open = /data-open="([^"]+)"/.exec(quick.body)?.[1]?.replaceAll("&#38;", "&") ?? "";
    assert.match(go, /^\/integrations\?made=[0-9a-f]{24}&from=agents#agents$/);
    assert.match(open, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=tira-demo&config=/);
    const [cursorAgent] = await tokens.list(S);
    assert.deepEqual([cursorAgent?.agent, cursorAgent?.createdBy], ["cursor-agent", "isha"]);
    const made = await settings(go.replace("#agents", ""));
    const shownToken = /<pre class="agent-code" id="agent-token">(tira_[0-9a-f_]+)<\/pre>/.exec(made)?.[1] ?? "";
    assert.equal((await tokens.find(shownToken))?.agent, "cursor-agent", "the token, shown once");
    assert.match(made, /<div class="agent-ready" data-agent-ready><p><b>cursor-agent<\/b> is connected to this project\./);
    assert.match(made, /<a class="act primary" href="cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=tira-demo&#38;config=[^"]+" data-agent-install>Add to Cursor<\/a>/);
    assert.doesNotMatch(await settings(go.replace("#agents", "")), /data-agent-ready/); // once
    // by hand: a person's name is caught; an agent's makes its token, with every app's setup filled in
    const person = await http("POST", "/integrations/agents/connect", "token=k&name=isha");
    assert.match(await settings(person.location ?? ""), /&#34;isha&#34; reads as a person(?:'|&#39;)s name/);
    const named = await http("POST", "/integrations/agents/connect", "token=k&name=research-agent");
    const filled = await settings(named.location ?? "");
    const token2 = /id="agent-token">(tira_[0-9a-f_]+)</.exec(filled)?.[1] ?? "";
    assert.equal((await tokens.find(token2))?.agent, "research-agent");
    assert.ok(filled.includes(esc(appSetup("vscode", S, { node: process.execPath, script: TIRA_SCRIPT }, token2).code)), "VS Code's config, its token in it");
    assert.match((await settings((await http("POST", "/integrations/agents/connect", "token=k&name=research-agent")).location ?? "")), /research-agent is already connected to this project: revoke it first/);
    // a second one-click Claude Code: numbered if taken
    await http("POST", "/integrations/agents/connect", "token=k&app=claude-code");
    await http("POST", "/integrations/agents/connect", "token=k&app=claude-code");
    agents = await settings();
    assert.deepEqual([...agents.matchAll(/<div class="agent-row" data-agent="([^"]+)">/g)].map((m) => m[1]), ["cursor-agent", "research-agent", "claude-code", "claude-code-2"]);
    assert.match(agents, /<small>tira_[0-9a-f]{8}… · connected by isha on \d{4}-\d{2}-\d{2} · not used yet<\/small>/);
    // revoke: gone from the list, its token no longer found
    const revoked = await http("POST", "/integrations/agents/revoke", `token=k&id=${encodeURIComponent(cursorAgent?.id ?? "")}`);
    assert.match(await settings(revoked.location ?? ""), /Revoked cursor-agent: its next call is refused\./);
    assert.equal(await tokens.find(shownToken), undefined);
    assert.doesNotMatch(await settings(), /data-agent="cursor-agent"/);
    // the database: ready once tira's .env names this tira's
    writeFileSync(envFile, "TIRA_DATABASE_URL=postgres://u@h/db\n");
    assert.match(await settings(), /<p class="agent-db" data-agent-database="ready">Agents will work on this tira(?:'|&#39;)s database/);
    // the page's script: Connect makes the token from the page, then opens the app's link while the click still counts
    const script = readFileSync(new URL("../src/serve/agents.mjs", import.meta.url), "utf8");
    assert.match(script, /for \(const form of document\.querySelectorAll\("form\[data-agent-connect\]"\)\)/);
    assert.match(script, /if \(open\?\.startsWith\("https:\/\/"\)\) window\.open\(open, "_blank", "noopener"\);/);
    assert.match(script, /else if \(open\) \{\n        const a = document\.createElement\("a"\);/); // an app's own link: opened by a click on it
    assert.match(page, /<script type="module" src="\/agents\.mjs"><\/script>/);
    // Copy, on the settings pages' own script (Setup's): any button with data-copy-target
    assert.match(readFileSync(new URL("../src/serve/secrets.mjs", import.meta.url), "utf8"), /for \(const b of document\.querySelectorAll\("button\[data-copy-target\]"\)\) \{\n  const target = document\.getElementById\(b\.dataset\.copyTarget \?\? ""\);/);
    assert.equal((await http("GET", "/agents.mjs")).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
