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
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { run } from "../src/cli/cli.ts";
import { agentNameProblem, DISCONNECTED, tiraMcpServer } from "../src/mcp/server.ts";
import { agentTokensFor, tokenHash, freeName, MemoryAgentTokens } from "../src/mcp/tokens.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { freshPgDb, needsPg } from "./test-stores.ts";
import { openStore } from "../src/store/open.ts";
import { APPS, appSetup, databaseCheck, mcpUrl, serverName, TIRA_SCRIPT, TOKEN_HERE } from "../src/mcp/connect.ts";
import { NO_TOKEN, NOT_CONNECTED } from "../src/mcp/http.ts";
import { tiraServer } from "../src/serve/server.ts";
import { esc } from "../src/render/escape.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import pg from "pg";

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
  // a commit the sync kept for a task (complete_task takes one as proof): its sha
  const commit = async (task: string, n = 1, message = "the work") => {
    const sha = n.toString(16).padStart(8, "0") + "d".repeat(32);
    await wp.submitAsSync({ stream: S, kind: "create", entity: { type: "commit", id: `${sha.slice(0, 12)}-${task}` }, payload: { task, repo: "acme/site", sha, pr: 3, message } });
    return sha;
  };
  return { store, registry, send, commit };
}

// tira mcp's server for the project, with the official MCP client on the other end of a pipe
async function connected(w: Awaited<ReturnType<typeof world>>, actor = "claude-code", stillConnected?: () => Promise<boolean>, fetchCommits?: (task: string) => Promise<string | undefined>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await tiraMcpServer({ store: w.store, registry: w.registry, stream: S, actor, ...(stillConnected ? { stillConnected } : {}), ...(fetchCommits ? { fetchCommits } : {}) }).connect(serverSide);
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
    assert.match(api.text, /^api · blocked · under site\nTicket: no description, steps, estimate or assignee yet\.\nBlocked: waiting on the key\nCommits: none yet \(push to a branch named api, or write "tira: api" in a pull request; complete_task looks on GitHub first\)\nComments: none yet \(add_comment writes one\)\.\nHistory:\n  seq 4 · node.born · isha · under site\n  seq 5 · node.start · isha\n  seq 6 · node.block · isha · reason waiting on the key$/);
    assert.deepEqual(await call("get_task", { id: "nope" }), { error: true, text: "There is no task nope in demo: list_tasks shows them." });
    // the one in progress, not listed again as next; once done, its proof
    await w.send("header", "START");
    assert.match((await call("next_task")).text, /^In progress: header \(under site\)\nBlocked: 1/);
    await w.send("header", "COMPLETE", { evidenceRef: "header.png" });
    assert.deepEqual(await call("list_tasks"), { error: false, text: "site · to do · top level\nfooter · to do · under site · ◆ next\napi · blocked · under site" }); // done: off the open list
    assert.match((await call("get_task", { id: "header" })).text, /^header · done · under site\nTicket: no description, steps, estimate or assignee yet\.\nProof: header.png \(from isha, seq 8\)\nComments: none yet/); // done: no commits to pick
    assert.match((await call("get_task", { id: "site" })).text, /^site · to do · top level\nTicket: no description, steps, estimate or assignee yet\.\nSubtasks: header \(done\), footer \(to do\), api \(blocked\)\n/);
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
    assert.deepEqual(tools.map((x) => x.name), ["next_task", "list_tasks", "get_task", "start_task", "complete_task", "block_task", "add_subtask", "file_idea", "add_comment"]);
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
    // the proof is one of the task's commits: none yet, then one that isn't it, then the rules
    assert.deepEqual(await call("complete_task", { id: "header", proof: "pr/1" }), { error: true, text: 'header has no commits yet: push the work to a branch named after it (header), or write "tira: header" in its pull request, then complete it with the commit\'s id. Nothing was written.' });
    const sha = await w.commit("header", 1, "header layout\n\nwith the logo");
    assert.deepEqual(await call("complete_task", { id: "header", proof: "abcdef12" }), { error: true, text: `abcdef12 isn't one of header's commits. Its commits: ${sha.slice(0, 7)} header layout. Nothing was written.` });
    assert.equal(await logged(), unproved + 1); // only the commit the sync kept
    assert.match((await call("complete_task", { id: "header", proof: sha.slice(0, 8) })).text, /^Complete header: refused \(gate: .*\)\. The refusal is in the log \(seq \d+\)\. What to do: Close its open subtasks first \(complete or cancel them\): header_logo\.$/);
    await w.commit("header_logo", 2);
    assert.match((await call("complete_task", { id: "header_logo", proof: "00000002dddd" })).text, /What to do: Start header_logo first\.$/);
    // blocked, waiting on a new ticket made under it, found while working on it
    assert.match((await call("block_task", { id: "footer", reason: "waiting on copy", new_ticket: "footer_copy" })).text, /^Add subtask footer_copy under footer: done \(seq \d+\)\. Block footer: done \(seq \d+\)\.$/);
    const footer = (await call("get_task", { id: "footer" })).text;
    assert.match(footer, /^footer · blocked · under site\nTicket: no description, steps, estimate or assignee yet\.\nSubtasks: footer_links \(to do\), footer_copy \(to do\)\nBlocked: waiting on copy\nWaiting on: footer_copy\n/);
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

test("agents read a ticket: its words, its comments, what's assigned to them and feedback they haven't answered; they reply on it", async () => {
  const w = await world();
  const d = new Dispatcher(w.store, w.registry);
  await d.submit({ stream: S, kind: "create", entity: { type: "ticket", id: "footer", version: 1 }, actor: "isha", payload: { task: "footer", title: "Site footer", description: "Links and the copyright line.\nDark, like the header.", steps: ["Add the links", "Add the copyright"], estimate: "1d", assignee: "claude-code" } });
  await d.submit({ stream: S, kind: "create", entity: { type: "comment", id: "c-1" }, actor: "isha", payload: { task: "footer", text: "Use the brand blue for the links." } });
  const { call } = await connected(w);
  assert.match((await call("next_task")).text, /\nAssigned to you: footer\nFeedback on footer: 1 new, latest from isha: "Use the brand blue for the links\." \(get_task shows it; add_comment replies\)$/);
  assert.match((await call("list_tasks")).text, /\nfooter · to do · under site "Site footer" · assigned to claude-code\n/);
  const footer = (await call("get_task", { id: "footer" })).text;
  assert.match(footer, /^footer · to do · under site\nTitle: Site footer\nDescription:\n  Links and the copyright line\.\n  Dark, like the header\.\nSteps:\n  1\. Add the links\n  2\. Add the copyright\nEstimate: 1d\nAssignee: claude-code\n/);
  assert.match(footer, /\nComments \(1, oldest first\):\n  seq \d+ · isha: Use the brand blue for the links\.\nHistory:/);
  // a reply: on the ticket, as the agent; answered, the feedback leaves what's next
  assert.match((await call("add_comment", { id: "footer", text: "Done: links are brand blue." })).text, /^Commented on footer \(seq \d+\): people see it on the ticket\.$/);
  assert.match((await call("get_task", { id: "footer" })).text, /\n  seq \d+ · claude-code: Done: links are brand blue\.\n/);
  assert.doesNotMatch((await call("next_task")).text, /Feedback on/);
  assert.deepEqual(await call("add_comment", { id: "nope", text: "hi" }), { error: true, text: "There is no task nope in demo: list_tasks shows them. Nothing was written." });
  assert.match((await call("add_comment", { id: "footer", text: "x".repeat(2001) })).text, /^Input validation error/); // the schema says no, before the log
  const page = renderHtml(fold(await w.store.readStream(S), w.registry), S, "h");
  assert.match(page, /<li class="cm" data-comment><div class="cm-h"><b>claude-code<\/b><span class="chip agent-chip">agent<\/span>/); // people see it, marked as an agent's
});

test("complete_task looks on GitHub for the task's commits first when it doesn't know the one given, then takes it; a look that finds none says so", async () => {
  const w = await world();
  let sha = "";
  const synced: string[] = [];
  const { call } = await connected(w, "claude-code", undefined, async (task) => {
    synced.push(task);
    if (synced.length === 1) sha = await w.commit("footer", 5, "footer done");
    return `Found 1 commit for ${task} on GitHub just now (1 new).`;
  });
  await w.send("footer", "START");
  assert.match((await call("complete_task", { id: "footer", proof: "00000005dddddd" })).text, /^Complete footer: done \(seq \d+\)\.$/);
  assert.deepEqual([synced, ((await w.store.readStream(S)).at(-1)?.data.payload as { evidenceRef?: string } | undefined)?.evidenceRef], [["footer"], sha]); // only that task's; a short id, written as the whole sha
  // already there: no sync needed
  await w.send("header", "START");
  await w.commit("header", 6);
  assert.match((await call("complete_task", { id: "header", proof: "00000006dddddd" })).text, /^Complete header: done/);
  assert.equal(synced.length, 1);
  // not there after the sync either: said, with what the sync said
  assert.match((await call("complete_task", { id: "site", proof: "1234567" })).text, /^site has no commits yet \(Found 1 commit for site on GitHub just now \(1 new\)\.\): push the work/);
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
    assert.equal((await client.listTools()).tools.length, 9);
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

test("agents' tokens on Postgres: one per agent and project, kept as a tokenHash; listed with its app, who and when; revoked, it's gone; a table made before agents had their app gets the column", { skip: needsPg }, async () => {
  const url = freshPgDb();
  const u = new URL(url);
  const schema = u.searchParams.get("schema") ?? "";
  u.searchParams.delete("schema");
  const before = new pg.Pool({ connectionString: u.toString(), max: 1 }); // the table as the first version of Connect agents made it
  await before.query(`CREATE SCHEMA ${schema}`);
  await before.query(`CREATE TABLE ${schema}.agent_tokens (id text PRIMARY KEY, hash text NOT NULL UNIQUE, project text NOT NULL, agent text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz)`);
  await before.end();
  const tokens = agentTokensFor({ TIRA_DATABASE_URL: url });
  assert.ok(tokens);
  try {
    const a = await tokens.create("p", "claude-code", "isha", "claude-code");
    await tokens.create("q", "claude-code", "isha"); // another project: its own
    assert.match(a.token, /^tira_[0-9a-f]{8}_[0-9a-f]{48}$/);
    assert.deepEqual((await tokens.find(a.token))?.agent, "claude-code");
    assert.deepEqual((await tokens.list("p")).map((x) => [x.agent, x.app, x.createdBy]), [["claude-code", "claude-code", "isha"]]);
    assert.equal((await tokens.list("q"))[0]?.app, undefined); // made without one
    await assert.rejects(tokens.create("p", "claude-code", "isha")); // the same name, still connected
    assert.equal(await tokens.revoke(a.row.id), true);
    assert.equal(await tokens.find(a.token), undefined);
    assert.deepEqual(await tokens.list("p"), []);
    assert.equal(await tokens.revoke(a.row.id), false);
  } finally {
    await tokens.close();
  }
});

test("connecting an agent: Claude Code, Cursor and VS Code reach tira serve's address with the agent's token in a header (Cursor's and VS Code's install links carry it); Claude Desktop starts tira mcp with this tira's Node and script; quoted for a shell; how to remove it", () => {
  assert.equal(serverName("factory-ui"), "tira-factory-ui");
  assert.equal(serverName("Isha Portfolio"), "tira-isha-portfolio");
  assert.equal(serverName("***"), "tira-project");
  assert.equal(mcpUrl("localhost:4772"), "http://127.0.0.1:4772/mcp"); // tira serve listens on 127.0.0.1, whatever the page was opened as
  assert.equal(mcpUrl("127.0.0.1"), "http://127.0.0.1/mcp");
  const at = { url: "http://127.0.0.1:4772/mcp", launch: { node: "/n/node", script: "/t/scripts/tira.ts" } };
  const headers = { Authorization: "Bearer tira_ab12cd34_x" };
  const code = appSetup("claude-code", "factory-ui", at, "tira_ab12cd34_x");
  assert.equal(code.code, "claude mcp remove tira-factory-ui -s user 2>/dev/null; claude mcp add --scope user --transport http tira-factory-ui http://127.0.0.1:4772/mcp --header 'Authorization: Bearer tira_ab12cd34_x'"); // an earlier entry for the project replaced
  assert.deepEqual(code.steps, ["Run this in a terminal. It replaces any earlier tira entry for this project in Claude Code.", "Open a new Claude Code session (one open before won't have tira) and ask it: what's next in tira?"]);
  assert.equal(code.remove, "claude mcp remove tira-factory-ui -s user");
  assert.equal(code.install, undefined);
  assert.match(appSetup("claude-code", "factory-ui", at, TOKEN_HERE).code, / --header 'Authorization: Bearer <your token>'$/);
  const cursor = appSetup("cursor", "factory-ui", at, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(cursor.code), { mcpServers: { "tira-factory-ui": { url: at.url, headers } } });
  const link = new URL(cursor.install ?? "");
  assert.equal(link.protocol + "//" + link.host + link.pathname, "cursor://anysphere.cursor-deeplink/mcp/install");
  assert.equal(link.searchParams.get("name"), "tira-factory-ui");
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get("config") ?? "", "base64").toString()), { url: at.url, headers });
  const vscode = appSetup("vscode", "factory-ui", at, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(vscode.code), { servers: { "tira-factory-ui": { type: "http", url: at.url, headers } } });
  const vlink = new URL(vscode.install ?? "");
  assert.equal(vlink.origin + vlink.pathname, "https://insiders.vscode.dev/redirect/mcp/install");
  assert.deepEqual(JSON.parse(vlink.searchParams.get("config") ?? ""), { type: "http", url: at.url, headers });
  const desktop = appSetup("claude-desktop", "factory-ui", at, "tira_ab12cd34_x");
  assert.deepEqual(JSON.parse(desktop.code), { mcpServers: { "tira-factory-ui": { command: "/n/node", args: ["--disable-warning=ExperimentalWarning", "/t/scripts/tira.ts", "mcp"], env: { TIRA_AGENT_TOKEN: "tira_ab12cd34_x" } } } });
  assert.equal(desktop.install, undefined);
  assert.deepEqual(desktop.steps, ["In Claude Desktop: Settings → Developer → Edit Config.", "Add this under mcpServers and save.", "Restart Claude Desktop."]);
});

test("tira serve answers MCP at /mcp, as Claude Code, Cursor and VS Code reach it: the agent's token names the project and the agent; no token, a revoked one, a web page elsewhere or another Host is refused; 2025-era clients too", async () => {
  const w = await world();
  const tokens = new MemoryAgentTokens();
  const { token, row } = await tokens.create(S, "cursor-agent", "isha", "cursor");
  const elsewhere = await tokens.create("elsewhere", "claude-code", "isha", "claude-code");
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "k", links: { env: {}, agentTokens: tokens } });
  const bare = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "k", links: { env: {} } }); // no Postgres: no tokens
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const post = (body: unknown, headers: Record<string, string> = {}, to: URL = url) => fetch(to, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const refused = async (headers: Record<string, string>, to: URL = url) => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, headers, to);
    return [r.status, r.headers.get("www-authenticate"), ((await r.json()) as { error: { message: string } }).error.message];
  };
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "older-app", version: "1" } } };
  try {
    const client = new Client({ name: "tira-tests", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.deepEqual((await client.listTools()).tools.map((x) => x.name), ["next_task", "list_tasks", "get_task", "start_task", "complete_task", "block_task", "add_subtask", "file_idea", "add_comment"]);
    const said = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
    assert.match(await said("next_task"), /^In progress: nothing\.\nNext: header \(under site\)/);
    assert.match(await said("start_task", { id: "header" }), /^Start header: done/);
    const started = (await w.store.readStream(S)).at(-1);
    assert.deepEqual([started?.metadata.actor, started?.stream], ["cursor-agent", S]); // as the token's agent, in its project
    assert.ok((await tokens.list(S))[0]?.lastUsedAt, "last used");
    await client.close();
    // a 2025-era client: initialize, then a call, each its own request
    const old = await post(initialize, { authorization: `Bearer ${token}` });
    assert.equal(old.status, 200);
    assert.match(await old.text(), /"protocolVersion":"2025-06-18"[^]*"description":"tira tasks for the project demo, as cursor-agent"/);
    assert.match(await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "next_task", arguments: {} } }, { authorization: `Bearer ${token}` })).text(), /In progress: header/);
    // another project's token: that project, that agent
    assert.match(await (await post(initialize, { authorization: `Bearer ${elsewhere.token}` })).text(), /"description":"tira tasks for the project elsewhere, as claude-code"/);
    // refused, before any tool runs
    assert.deepEqual(await refused({}), [401, 'Bearer realm="tira"', NO_TOKEN]);
    assert.deepEqual(await refused({ authorization: `Bearer tira_00000000_${"0".repeat(48)}` }), [401, 'Bearer realm="tira"', NOT_CONNECTED]);
    assert.deepEqual(await refused({ authorization: `Bearer ${token}`, origin: "https://example.com" }), [403, null, "tira answers MCP only to apps on this computer, not to a web page."]);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: `Bearer ${token}`, origin: `http://localhost:${port}` })).status, 200); // a page on this computer may
    assert.deepEqual(await refused({ authorization: `Bearer ${token}` }, new URL(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/mcp`)), [503, null, "Connecting agents needs tira's Postgres database."]);
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { host: "tira.example.com", authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(rebound, 403); // the page's own Host rule, before anything else
    await tokens.revoke(row.id);
    assert.deepEqual(await refused({ authorization: `Bearer ${token}` }), [401, 'Bearer realm="tira"', NOT_CONNECTED]); // its next request
    assert.equal((await w.store.readStream(S)).filter((e) => e.metadata.actor === "cursor-agent").length, 1); // the one start, nothing since
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bare.close(() => r()));
  }
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

test("Project settings → Connect agents, in three steps: choose your app, name your agent (its token made then), finish in that app with one action and Test connection; connected agents below; the rest under More", async () => {
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
  const unesc = (s: string) => s.replaceAll(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
  const setupIn = (agents: string) => unesc(/<pre class="agent-code" id="agent-setup">([^<]+)<\/pre>/.exec(agents)?.[1] ?? "");
  const at = { url: `http://127.0.0.1:${port}/mcp`, launch: { node: process.execPath, script: TIRA_SCRIPT } };
  try {
    const page = (await http("GET", "/integrations")).body;
    assert.match(page, /<a class="set-link" href="#sync">Sync<\/a><a class="set-link" href="#agents">Connect agents<\/a><a class="set-link" href="#delete">Delete<\/a>/);
    assert.doesNotMatch((await http("GET", "/settings")).body, /id="agents"|data-agent/); // not in Account settings
    let agents = section(page);
    assert.match(agents, /<h2 class="grp-h">Connect agents<\/h2><p class="grp-desc">Connect your AI agents \(Claude Code, Cursor, VS Code, Claude Desktop\) to this project/);
    // step 1: the four apps, each its own address; steps 2 and 3 wait their turn
    assert.deepEqual([...agents.matchAll(/<a class="agent-tile" href="([^"]+)" data-agent-tile="([a-z-]+)">/g)].map((m) => [m[2], unesc(m[1] ?? "")]), APPS.map((app) => [app, `/integrations?app=${app}&from=agents#agents`]));
    assert.match(agents, /<div class="agent-step now" data-agent-step="1"><h3><span class="agent-n">1<\/span>Choose your app<\/h3>/);
    assert.match(agents, /<div class="agent-step later" data-agent-step="2">[^]*<div class="agent-step later" data-agent-step="3"><h3><span class="agent-n">3<\/span>Finish in your app<\/h3>/);
    assert.match(agents, /<h3 class="agent-list-h">Connected agents<\/h3><div class="agent-list" data-agents><p class="agent-none">No agents connected yet\.<\/p>/);
    assert.doesNotMatch(agents, /data-agent-install|id="agent-setup"|data-agent-test/); // no token yet
    // More: the address, each app by hand with the token's place, what agents can do, Claude Desktop's database
    const more = /<details class="agent-more" data-agent-more><summary>More<\/summary>[^]*?<\/details>/.exec(agents)?.[0] ?? "";
    assert.ok(more.includes(`<pre class="agent-code" id="agent-url">http://127.0.0.1:${port}/mcp</pre>`), "the address, as 127.0.0.1");
    assert.ok(more.includes(esc(appSetup("claude-code", S, at, TOKEN_HERE).code)), "Claude Code's command, its token's place marked");
    assert.equal((more.match(/data-agent-app="/g) ?? []).length, 4);
    assert.match(more, /<li><code>complete_task<\/code> done, with one of its commits as proof of work<\/li><li><code>block_task<\/code>/);
    assert.match(more, /<li><code>add_comment<\/code> a reply on a task(?:'|&#39;)s comments<\/li><\/ul>/);
    assert.match(more, /Cancelling, reopening and unblocking stay with people\./);
    assert.match(more, /<p class="agent-db no" data-agent-database="missing">/);
    assert.match(more, /<h4>Claude(?:'|&#39;)s Connectors<\/h4><p data-agent-connectors>Claude(?:'|&#39;)s own Connectors settings \(Add custom connector\) can(?:'|&#39;)t add tira yet: [^<]*public https address[^<]*That comes once tira is hosted\./);
    // step 2: Cursor chosen; its agent's name suggested
    agents = await settings("/integrations?app=cursor&from=agents");
    assert.match(agents, /<div class="agent-step done" data-agent-step="1"><h3><span class="agent-n">✓<\/span>Choose your app<\/h3><p class="agent-done"><b>Cursor<\/b> <a href="\/integrations\?from=agents#agents">Change<\/a>/);
    assert.match(agents, /<div class="agent-step now" data-agent-step="2">[^]*?<input type="hidden" name="app" value="cursor"><input type="text" name="name" value="cursor-agent"[^>]*><button class="act primary" type="submit">Connect<\/button>/);
    assert.match(agents, /<div class="agent-step later" data-agent-step="3"><h3><span class="agent-n">3<\/span>Finish in Cursor<\/h3>/);
    // a person's name is caught, said in step 2; an app must be chosen
    const person = await http("POST", "/integrations/agents/connect", "token=k&app=cursor&name=isha");
    assert.match(person.location ?? "", /^\/integrations\?app=cursor&r=\d+&from=agents#agents$/);
    const caught = await settings(person.location ?? "");
    assert.match(caught, /data-agent-step="2">[^]*?&#34;isha&#34; reads as a person(?:'|&#39;)s name[^]*?data-agent-step="3"/);
    assert.equal(caught.match(/data-flash/g)?.length, 1, "said in step 2 only");
    assert.match(await settings((await http("POST", "/integrations/agents/connect", "token=k&name=x-agent")).location ?? ""), /<div class="flash no" role="status" data-flash>Choose your app first\.<\/div><div class="agent-step now" data-agent-step="1">/);
    // Connect: the agent's token, for Cursor; step 3: Add to Cursor (the token in its link), the setup by hand folded under it
    const made = await http("POST", "/integrations/agents/connect", "token=k&app=cursor&name=cursor-agent");
    const key = /^\/integrations\?made=([0-9a-f]{24})&from=agents#agents$/.exec(made.location ?? "")?.[1] ?? "";
    assert.ok(key, made.location);
    const [cursorAgent] = await tokens.list(S);
    assert.deepEqual([cursorAgent?.agent, cursorAgent?.app, cursorAgent?.createdBy], ["cursor-agent", "cursor", "isha"]);
    agents = await settings(`/integrations?made=${key}&from=agents`);
    const token = (JSON.parse(setupIn(agents)) as { mcpServers: Record<string, { headers: { Authorization: string } }> }).mcpServers["tira-demo"]?.headers.Authorization.replace("Bearer ", "") ?? "";
    assert.equal((await tokens.find(token))?.agent, "cursor-agent");
    assert.equal(agents.split(token).length, 2, "the token, once, in the setup"); // (and in the install link, base64)
    assert.match(agents, /<p class="agent-done"><b>Cursor<\/b><\/p>[^]*?<p class="agent-done"><b>cursor-agent<\/b> is connected to this project, with a token of its own\.<\/p>/);
    assert.ok(agents.includes(`<p class="agent-go"><a class="act primary" href="${esc(appSetup("cursor", S, at, token).install ?? "")}" data-agent-install>Add to Cursor</a></p><details class="agent-hand"><summary>Doesn't open? Add it by hand</summary>`), "Add to Cursor, the setup by hand under it");
    assert.match(agents, /<a href="\/integrations\?from=agents#agents">Connect another agent<\/a>/);
    assert.ok((await settings(`/integrations?made=${key}&from=agents`)).includes(token), "still shown on a reload, for 10 minutes");
    // Test connection: not yet (the plain post comes back to step 3, the answer in it); after the app's first call, connected
    const notYet = await http("POST", "/integrations/agents/test", `token=k&id=${cursorAgent?.id ?? ""}&made=${key}`);
    assert.match(notYet.location ?? "", new RegExp(`^/integrations\\?made=${key}&r=\\d+&from=agents#agents$`));
    assert.match(await settings(notYet.location ?? ""), /<div class="agent-tested" data-agent-tested><div class="flash wait" role="status" data-flash>Waiting for Cursor(?:'|&#39;)s first call\. Once tira is added, Cursor calls it when tira is turned on in its settings, under MCP\. Then test again\.<\/div><\/div>/); // a wait, said calmly: not an error
    assert.match(page, /\.flash\.wait\{border-color:color-mix\(in srgb,var\(--accent\) 30%,transparent\);background:var\(--accent-bg\)\}/);
    const setup = JSON.parse(setupIn(agents)) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    const cursor = setup.mcpServers["tira-demo"];
    assert.equal((await fetch(cursor?.url ?? "", { method: "POST", headers: { ...cursor?.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status, 200); // Cursor, with what the page gave it
    const tested = await http("POST", "/integrations/agents/test", `token=k&id=${cursorAgent?.id ?? ""}&made=${key}&fragment=1`);
    assert.match(tested.body, /^<div class="flash ok" role="status" data-flash>Cursor is connected: tira heard from cursor-agent just now\. Ask it &#34;what(?:'|&#39;)s next in tira\?&#34;<\/div>$/);
    // connected agents: its app, last used
    assert.match(await settings(), /<div class="agent-row" data-agent="cursor-agent"><span class="agent-who"><b>cursor-agent<\/b><small>Cursor · tira_[0-9a-f]{8}… · connected by isha on \d{4}-\d{2}-\d{2} · last used \d{4}-\d{2}-\d{2}<\/small><\/span><form method="post" action="\/integrations\/agents\/revoke">/);
    // the name taken: the next one suggested; the same again is refused
    assert.match(await settings("/integrations?app=cursor&from=agents"), /name="name" value="cursor-agent-2"/);
    assert.match(await settings((await http("POST", "/integrations/agents/connect", "token=k&app=cursor&name=cursor-agent")).location ?? ""), /cursor-agent is already connected to this project: revoke it first/);
    // Claude Code: its one command; Claude Desktop: its entry, and the database it needs
    const code = await settings((await http("POST", "/integrations/agents/connect", "token=k&app=claude-code&name=claude-code")).location ?? "");
    const codeToken = /Bearer (tira_[0-9a-f_]+)/.exec(setupIn(code))?.[1] ?? "";
    assert.equal(setupIn(code), appSetup("claude-code", S, at, codeToken).code);
    assert.match(code, /<h3><span class="agent-n">3<\/span>Finish in Claude Code<\/h3><ol class="agent-steps"><li>Run this in a terminal/);
    assert.doesNotMatch(code, /data-agent-install|agent-hand/);
    const codeAgent = (await tokens.list(S)).find((x) => x.agent === "claude-code");
    assert.match((await http("POST", "/integrations/agents/test", `token=k&id=${codeAgent?.id ?? ""}&fragment=1`)).body, /^<div class="flash wait" role="status" data-flash>Waiting for Claude Code(?:'|&#39;)s first call\. If you(?:'|&#39;)ve run the command, Claude Code is set up and just hasn(?:'|&#39;)t called tira yet\. Quickest check: run claude mcp list in a terminal \(or ask a new Claude Code session &#34;what(?:'|&#39;)s next in tira\?&#34;\), then test again\.<\/div>$/);
    const desktop = await settings((await http("POST", "/integrations/agents/connect", "token=k&app=claude-desktop&name=claude-desktop")).location ?? "");
    assert.equal(JSON.parse(setupIn(desktop)).mcpServers["tira-demo"].args[2], "mcp");
    assert.match(desktop, /data-agent-step="3">(?:(?!data-agent-test)[^])*<p class="agent-db no" data-agent-database="missing">tira(?:'|&#39;)s \.env names no database, so Claude Desktop(?:'|&#39;)s agent couldn(?:'|&#39;)t reach this board/); // in step 3, before Test connection
    // revoke: gone from the list; its step 3 no longer shows its token
    const revoked = await http("POST", "/integrations/agents/revoke", `token=k&id=${encodeURIComponent(cursorAgent?.id ?? "")}`);
    assert.match(await settings(revoked.location ?? ""), /Revoked cursor-agent: its next call is refused\./);
    assert.equal(await tokens.find(token), undefined);
    const gone = await settings(`/integrations?made=${key}&from=agents`);
    assert.ok(!gone.includes(token));
    assert.match(gone, /That setup isn(?:'|&#39;)t shown any more/);
    assert.deepEqual([...(await settings()).matchAll(/<div class="agent-row" data-agent="([^"]+)">/g)].map((m) => m[1]), ["claude-code", "claude-desktop"]);
    // the database: ready once tira's .env names this tira's
    writeFileSync(envFile, "TIRA_DATABASE_URL=postgres://u@h/db\n");
    assert.match(await settings(), /<p class="agent-db" data-agent-database="ready">Claude Desktop(?:'|&#39;)s agent will work on this tira(?:'|&#39;)s database/);
    // the page's script: Test connection asks from the page and shows the answer in place
    const script = readFileSync(new URL("../src/serve/agents.mjs", import.meta.url), "utf8");
    assert.match(script, /for \(const form of document\.querySelectorAll\("form\[data-agent-test\]"\)\)/);
    assert.match(script, /body\.set\("fragment", "1"\);/);
    assert.match(script, /if \(!said \|\| !slot\) return form\.submit\(\);\n      slot\.replaceChildren\(said\);/);
    assert.match(page, /<script type="module" src="\/agents\.mjs"><\/script>/);
    // Copy, on the settings pages' own script (Setup's): any button with data-copy-target
    assert.match(readFileSync(new URL("../src/serve/secrets.mjs", import.meta.url), "utf8"), /for \(const b of document\.querySelectorAll\("button\[data-copy-target\]"\)\) \{\n  const target = document\.getElementById\(b\.dataset\.copyTarget \?\? ""\);/);
    assert.equal((await http("GET", "/agents.mjs")).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
