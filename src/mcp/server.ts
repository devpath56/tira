// tira for agents: an MCP server that Claude Code or Claude Desktop starts on this computer
// (`tira mcp`), for one project, under one agent's own name. It speaks the 2026-07-28 spec, and
// 2025-era clients too (serveStdio), over stdio to the program that started it: never over the
// network. Every tool reads or writes through tira's own rules, so an agent can do nothing a
// person couldn't, and the history says which agent did it.
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AGENT } from "../render/html.ts";
import { isReservedActor } from "../write/write-path.ts";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { getTask, listTasks, LIST_STATES, nextTask, type ToolText } from "./tasks.ts";

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

// A tool's answer as MCP carries it: its text, marked an error when it didn't do what was asked.
const answer = (t: ToolText) => ({ content: [{ type: "text" as const, text: t.text }], ...(t.ok ? {} : { isError: true }) });
const READS = { readOnlyHint: true, openWorldHint: false };

// The server for one connection (serveStdio builds one per client): the tools, each reading the
// project's log as it is when called.
export function tiraMcpServer(ctx: AgentContext): McpServer {
  const server = new McpServer({ name: "tira", version: "1.0.0", description: `tira tasks for the project ${ctx.stream}, as ${ctx.actor}` }, { capabilities: { tools: {} } });
  server.registerTool("next_task", {
    title: "What's next",
    description: "The task being worked on in this project, the next one to pick up (in tira's order), and how many are blocked. Start here.",
    annotations: READS,
  }, async () => answer(await nextTask(ctx)));
  server.registerTool("list_tasks", {
    title: "List tasks",
    description: "The project's tasks in the board's order: id, state (to do, in progress, blocked, done, dropped) and where each sits in the tree; ◆ marks the next one. Open tasks unless a state is given.",
    inputSchema: z.object({ state: z.enum(LIST_STATES).optional().describe("open (the default), all, or one state: unstarted, in_progress, blocked, done, cancelled") }),
    annotations: READS,
  }, async ({ state }) => answer(await listTasks(ctx, state)));
  server.registerTool("get_task", {
    title: "Show a task",
    description: "One task: its state and place in the tree, its subtasks, why it's blocked and what it waits on, its proof of work, and its full history (who did what, refusals included).",
    inputSchema: z.object({ id: z.string().min(1).describe("the task's id, as list_tasks shows it") }),
    annotations: READS,
  }, async ({ id }) => answer(await getTask(ctx, id)));
  return server;
}
