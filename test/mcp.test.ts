// tira for agents (src/mcp, `tira mcp`): an MCP server for one project, under one agent's own
// name, whose tools read and write through tira's own rules.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/cli.ts";
import { agentNameProblem } from "../src/mcp/server.ts";

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
