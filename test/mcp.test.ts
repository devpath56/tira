// tira for agents (src/mcp, `tira mcp`): an MCP server for one project, under one agent's own
// name, whose tools read and write through tira's own rules.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { run } from "../src/cli/cli.ts";
import { agentNameProblem, tiraMcpServer } from "../src/mcp/server.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";

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
    assert.deepEqual(tools.map((x) => x.name), ["next_task", "list_tasks", "get_task"]);
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
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
