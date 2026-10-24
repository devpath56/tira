// tira for agents: an MCP server that Claude Code or Claude Desktop starts on this computer
// (`tira mcp`), for one project, under one agent's own name. It speaks the 2026-07-28 spec, and
// 2025-era clients too (serveStdio), over stdio to the program that started it: never over the
// network. Every tool reads or writes through tira's own rules, so an agent can do nothing a
// person couldn't, and the history says which agent did it.
import { McpServer } from "@modelcontextprotocol/server";
import { AGENT } from "../render/html.ts";
import { isReservedActor } from "../write/write-path.ts";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";

// What every tool works in: the project's stream, and the agent it acts as.
export interface AgentContext { store: EventStore; registry: Registry; stream: string; actor: string }

const NAME = /^[\w.:-]{1,64}$/;

// Why tira mcp won't act under this name, or undefined: an agent's own name (claude-code,
// codex-review, factory-s3, research-agent, triage-bot), never a person's, and never the names
// tira, the dispatcher and the sync write under.
export function agentNameProblem(name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === "") return "tira mcp needs --actor NAME (or TIRA_ACTOR): the agent's own name, e.g. claude-code";
  if (!NAME.test(name)) return `"${name}" can't be an agent's name: letters, digits, dots, dashes, underscores or colons, up to 64`;
  if (isReservedActor(name)) return `"${name}" is reserved for tira's, the dispatcher's and the sync's own writes: give the agent a name of its own, e.g. claude-code`;
  if (!AGENT.test(name)) return `"${name}" reads as a person's name: an agent acts under an agent's name (claude-…, codex-…, …-agent, …-bot), so its history shows an agent did it`;
  return undefined;
}

// The server for one connection (serveStdio builds one per client).
export function tiraMcpServer(ctx: AgentContext): McpServer {
  return new McpServer({ name: "tira", version: "1.0.0", description: `tira tasks for the project ${ctx.stream}, as ${ctx.actor}` }, { capabilities: { tools: {} } });
}
