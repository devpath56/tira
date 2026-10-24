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
import { agentNameProblem, tiraMcpServer } from "../src/mcp/server.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { freshPgDb, needsPg } from "./test-stores.ts";
import { openStore } from "../src/store/open.ts";
import { connectWords, databaseCheck, serverName, TIRA_SCRIPT } from "../src/mcp/connect.ts";
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
async function connected(w: Awaited<ReturnType<typeof world>>, actor = "claude-code") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await tiraMcpServer({ store: w.store, registry: w.registry, stream: S, actor }).connect(serverSide);
  const client = new Client({ name: "tira-tests", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") };
  };
  return { client, call };
}

test("tira mcp acts only under an agent's own name: never a person's, never tira's own writers', and says why before it starts", async () => {
  for (const ok of ["claude-code", "claude", "codex-review", "factory-s3", "research-agent", "triage-bot"]) assert.equal(agentNameProblem(ok), undefined, ok);
  assert.match(agentNameProblem(undefined) ?? "", /^tira mcp needs --actor NAME \(or TIRA_ACTOR\): the agent's own name/);
  assert.match(agentNameProblem("  ") ?? "", /needs --actor NAME/);
  assert.match(agentNameProblem("isha") ?? "", /^"isha" reads as a person's name: an agent acts under an agent's name/);
  for (const reserved of ["tira", "dispatcher", "sync"]) assert.match(agentNameProblem(reserved) ?? "", /is reserved for tira's, the dispatcher's and the sync's own writes/, reserved);
  for (const odd of ["claude code", "claude-code x", "claude/../x"]) assert.match(agentNameProblem(odd) ?? "", /can't be an agent's name: letters, digits/, odd);
  // the command says so on stderr, writes nothing to stdout (the protocol's), and opens no store
  for (const argv of [["mcp", "--actor", "isha"], ["mcp"]]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, openStore: () => { throw new Error("no store should open"); } });
    assert.equal(code, 1, argv.join(" "));
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), /tira: (?:"isha" reads as a person's name|tira mcp needs --actor NAME)/);
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

test("tira mcp end to end, as Claude Code starts it: over stdio, on Postgres, for the project and as the agent named; it says so on stderr only, and stops when its client does", { skip: needsPg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-mcp-"));
  const script = fileURLToPath(new URL("../scripts/tira.ts", import.meta.url));
  const db = freshPgDb();
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TIRA_DATABASE_URL: db, TIRA_HOME: join(dir, "home"), TIRA_FACTORY: "" };
  const tira = (...argv: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--stream", "e2e", ...argv, "--actor", "isha"], { encoding: "utf8", env });
  tira("create", "node", "site");
  tira("create", "node", "header", "--parent", "site");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", script, "--stream", "e2e", "mcp", "--actor", "claude-code"], env, stderr: "pipe" });
  let said = "";
  transport.stderr?.on("data", (d: Buffer) => { said += d.toString(); });
  const client = new Client({ name: "tira-e2e", version: "1.0.0" });
  const text = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as { text: string }[]).map((c) => c.text).join("\n");
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    assert.equal(await text("next_task"), "In progress: nothing.\nNext: header (under site)");
    assert.match(await text("start_task", { id: "header" }), /^Start header: done \(seq 3\)\.$/);
    assert.match(said, /^tira: MCP server for e2e, acting as claude-code \(on stdio; it stops when its client does\)$/m);
    const t = performance.now();
    await client.close();
    assert.ok(performance.now() - t < 5000, "tira mcp stops promptly when its client does");
    // the write is in the project's log, as the agent
    const store = openStore(db);
    try {
      const last = (await store.readStream("e2e")).at(-1);
      assert.deepEqual([last?.type, last?.metadata.actor], ["node.start", "claude-code"]);
    } finally {
      await store.close();
    }
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connecting an agent: the command for Claude Code (all projects or one folder) or Claude Desktop's entry, with this tira's Node and script, quoted for a shell; and how to undo it", () => {
  assert.equal(serverName("factory-ui"), "tira-factory-ui");
  assert.equal(serverName("Isha Portfolio"), "tira-isha-portfolio");
  assert.equal(serverName("***"), "tira-project");
  const words = (project: string, where: "user" | "local" | "desktop", agent = "claude-code") => connectWords("/n/node", "/t/scripts/tira.ts", { project, agent, where });
  assert.deepEqual(words("factory-ui", "user"), {
    add: "claude mcp add --scope user tira-factory-ui -- /n/node --disable-warning=ExperimentalWarning /t/scripts/tira.ts mcp --stream factory-ui --actor claude-code",
    remove: "claude mcp remove tira-factory-ui -s user",
  });
  assert.deepEqual(words("factory-ui", "local", "claude-research"), {
    add: "claude mcp add --scope local tira-factory-ui -- /n/node --disable-warning=ExperimentalWarning /t/scripts/tira.ts mcp --stream factory-ui --actor claude-research",
    remove: "claude mcp remove tira-factory-ui -s local",
  });
  assert.match(words("Isha's site", "user").add, / --stream 'Isha'\\''s site' --actor claude-code$/);
  const desktop = words("factory-ui", "desktop");
  assert.deepEqual(JSON.parse(desktop.add), { mcpServers: { "tira-factory-ui": { command: "/n/node", args: ["--disable-warning=ExperimentalWarning", "/t/scripts/tira.ts", "mcp", "--stream", "factory-ui", "--actor", "claude-code"] } } });
  assert.match(desktop.remove, /^Delete "tira-factory-ui" from mcpServers in Claude Desktop's settings file/);
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

test("Account settings → Agents, right after Account: pick the project, the agent's name and where, copy the command; a person's name is caught there; it says whether agents would reach this tira's database; nothing runs from the page", async () => {
  const w = await world();
  await new WritePath(w.store, w.registry).submit({ stream: "other", kind: "create", entity: { type: "node", id: "x" }, actor: "isha", payload: {} });
  const dir = mkdtempSync(join(tmpdir(), "tira-agents-"));
  const envFile = join(dir, ".env");
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "k", links: { env: { TIRA_HOME: dir }, envFile } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `localhost:${port}` } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
  const section = (page: string) => /<section class="grp" id="agents"[^]*?<\/section>/.exec(page)?.[0] ?? "";
  const command = (project: string, where: string, agent = "claude-code") => esc(connectWords(process.execPath, TIRA_SCRIPT, { project, agent, where: where as "user" }).add);
  try {
    const page = await get("/settings");
    assert.ok(page.indexOf('id="account"') < page.indexOf('id="agents"') && page.indexOf('id="agents"') < page.indexOf('id="setup"'), "right after Account");
    const agents = section(page);
    assert.match(agents, /<p class="grp-desc">Connect an AI agent \(Claude Code, Claude Desktop\) to a project through tira(?:'|&#39;)s MCP server\./);
    assert.match(agents, /<form method="get" action="\/settings#agents" class="grp-list" data-agents-form>/);
    assert.match(agents, /<option value="demo" selected>demo<\/option><option value="other">other<\/option>/); // the project you're in, first picked
    assert.match(agents, /<input type="text" name="agent" value="claude-code"/);
    assert.ok(agents.includes(`<pre class="agent-code" id="agent-add">${command("demo", "user")}</pre>`), "Claude Code, all projects, by default");
    assert.match(agents, /<code class="agent-undo">claude mcp remove tira-demo -s user<\/code>/);
    assert.match(agents, /<button type="button" class="env-btn" data-copy-target="agent-add" title="Copy" aria-label="Copy it">/);
    assert.match(agents, /Nothing runs from this page: you run the command, and remove it the same way\./);
    // the choices, kept on the page
    const local = section(await get("/settings?project=other&agent=claude-research&where=local"));
    assert.ok(local.includes(`id="agent-add">${command("other", "local", "claude-research")}</pre>`));
    assert.match(local, /<option value="other" selected>other<\/option>/);
    assert.match(local, /<input type="text" name="agent" value="claude-research"/);
    assert.match(local, /<option value="local" selected>Claude Code, one folder \(run it there\)<\/option>/);
    assert.ok(section(await get("/settings?where=desktop")).includes(`id="agent-add">${command("demo", "desktop")}</pre>`));
    assert.ok(section(await get("/settings?project=nope")).includes(`id="agent-add">${command("demo", "user")}</pre>`), "an unknown project: the one you're in");
    // a person's name: why not, and no command
    const person = section(await get("/settings?agent=isha"));
    assert.match(person, /<div class="grp-list" data-agent-problem><div class="grp-row"><span class="grp-k no">&#34;isha&#34; reads as a person(?:'|&#39;)s name/);
    assert.doesNotMatch(person, /data-agent-command/);
    // the database: none in tira's .env yet, then this tira's
    assert.match(agents, /<p class="agent-db no" data-agent-database="missing">tira(?:'|&#39;)s .env names no database, so an agent couldn(?:'|&#39;)t reach your board\. Add TIRA_DATABASE_URL/);
    assert.ok(agents.includes(`<code>${esc(envFile)}</code>`), "names the file");
    writeFileSync(envFile, "TIRA_DATABASE_URL=postgres://u@h/db\n");
    assert.match(section(await get("/settings")), /<p class="agent-db" data-agent-database="ready">Agents will work on this tira(?:'|&#39;)s database/);
    // Copy, on the page's own script
    assert.match(readFileSync(new URL("../src/serve/secrets.mjs", import.meta.url), "utf8"), /for \(const b of document\.querySelectorAll\("button\[data-copy-target\]"\)\) \{\n  const target = document\.getElementById\(b\.dataset\.copyTarget \?\? ""\);/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
