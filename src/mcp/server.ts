// tira for agents: an MCP server for one project, under one agent's own name, on this computer
// only: at tira serve's /mcp (src/mcp/http.ts) for Claude Code, Cursor and VS Code, or over stdio
// to the program that started it (`tira mcp`, for Claude Desktop). It speaks the 2026-07-28 spec,
// and 2025-era clients too. Every tool reads or writes through tira's own rules, so an agent can
// do nothing a person couldn't, and the history says which agent did it.
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { getTask, listTasks, LIST_STATES, nextTask, type ToolText } from "./tasks.ts";
import { addComment, addSubtask, blockTask, completeTask, fileIdea, fillTicket, startTask } from "./actions.ts";
import { MAX_DESCRIPTION, MAX_STEP, MAX_STEPS } from "../tables/tickets.ts";

// What every tool works in: the project's stream, the agent it acts as, (from tira mcp) whether
// that agent is still connected: revoked in Project settings, its next call is refused; and how to
// look on GitHub for a task's newest commits (to complete it with one), and check any commit or pull
// request of the project's repo named as proof (keeping it for the task), when it can.
export interface AgentContext {
  store: EventStore; registry: Registry; stream: string; actor: string
  stillConnected?: () => Promise<boolean>
  fetchCommits?: (task: string) => Promise<string | undefined>
  proveWith?: (task: string, ref: string) => Promise<{ ref: string } | { why: string }>
}

export { agentNameProblem } from "./names.ts";

// A tool's answer as MCP carries it: its text, marked an error when it didn't do what was asked.
const answer = (t: ToolText) => ({ content: [{ type: "text" as const, text: t.text }], ...(t.ok ? {} : { isError: true }) });
export const DISCONNECTED = "This agent was disconnected in Project settings → Connect agents: a person can connect it again there.";
const READS = { readOnlyHint: true, openWorldHint: false };
// writes change a task's state the board shows; none deletes anything (dropping a task is a person's)
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const taskId = z.string().trim().min(1).describe("the task's id, as list_tasks shows it");
const words = (what: string) => z.string().trim().min(1).max(500).describe(what);

// The server for one connection (serveStdio builds one per client): the tools, each reading the
// project's log as it is when called.
// a tool's work, unless the agent was disconnected since it started
async function guarded(ctx: AgentContext, work: () => Promise<ToolText>): Promise<ToolText> {
  if (ctx.stillConnected && !(await ctx.stillConnected())) return { ok: false, text: DISCONNECTED };
  return work();
}

export function tiraMcpServer(ctx: AgentContext): McpServer {
  const server = new McpServer({ name: "tira", version: "1.0.0", description: `tira tasks for the project ${ctx.stream}, as ${ctx.actor}` }, { capabilities: { tools: {} } });
  server.registerTool("next_task", {
    title: "What's next",
    description: "The task being worked on in this project, the next one to pick up (in tira's order), and how many are blocked. Start here.",
    annotations: READS,
  }, async () => answer(await guarded(ctx, () => nextTask(ctx))));
  server.registerTool("list_tasks", {
    title: "List tasks",
    description: "The project's tasks in the board's order: id, state (to do, in progress, blocked, done, dropped) and where each sits in the tree; ◆ marks the next one. Open tasks unless a state is given.",
    inputSchema: z.object({ state: z.enum(LIST_STATES).optional().describe("open (the default), all, or one state: unstarted, in_progress, blocked, done, cancelled") }),
    annotations: READS,
  }, async ({ state }) => answer(await guarded(ctx, () => listTasks(ctx, state))));
  server.registerTool("get_task", {
    title: "Show a task",
    description: "One task: its state and place in the tree, its subtasks, why it's blocked and what it waits on, its proof of work, and its full history (who did what, refusals included).",
    inputSchema: z.object({ id: z.string().min(1).describe("the task's id, as list_tasks shows it") }),
    annotations: READS,
  }, async ({ id }) => answer(await guarded(ctx, () => getTask(ctx, id))));
  server.registerTool("start_task", {
    title: "Start a task",
    description: "Move a task to In progress, as you. One task can be in progress at a time: tira refuses a second and says which to finish or block first.",
    inputSchema: z.object({ id: taskId }),
    annotations: { ...WRITES, idempotentHint: true },
  }, async ({ id }) => answer(await guarded(ctx, () => startTask(ctx, id))));
  server.registerTool("complete_task", {
    title: "Complete a task",
    description: "Mark a task Done. The proof of work is a commit or a pull request of the project's GitHub repo: the task's own (get_task lists them; tira looks on GitHub for its newest first) or any other, which tira checks on GitHub. tira refuses anything else, before the task is started, or while its subtasks are open.",
    inputSchema: z.object({ id: taskId, proof: words("a commit (its id, or its first 7 or more characters) or a pull request (#12, or its link) of the project's repo"), note: words("optional: a note for the task's history").optional() }),
    annotations: { ...WRITES, idempotentHint: true },
  }, async ({ id, proof, note }) => answer(await guarded(ctx, () => completeTask(ctx, id, proof, note))));
  server.registerTool("block_task", {
    title: "Block a task",
    description: "Mark a task Blocked, with the reason. Say what it waits on: an open task (waits_on), or a new ticket tira creates under it (new_ticket), not both. A person unblocks it.",
    inputSchema: z.object({
      id: taskId,
      reason: words("why it's blocked"),
      waits_on: z.string().trim().min(1).optional().describe("optional: the id of an open task it waits on"),
      new_ticket: z.string().trim().min(1).optional().describe("optional: a name for a new ticket, created under this task, that it waits on"),
    }),
    annotations: { ...WRITES, idempotentHint: true },
  }, async ({ id, reason, waits_on, new_ticket }) => answer(await guarded(ctx, () => blockTask(ctx, id, reason, waits_on, new_ticket))));
  server.registerTool("add_subtask", {
    title: "Add a subtask",
    description: "Add a new task under one (marked as found while working on it when that task is under way).",
    inputSchema: z.object({ under: taskId, name: z.string().trim().min(1).max(80).describe("the new task's id: a short name, e.g. login_copy") }),
    annotations: { ...WRITES, idempotentHint: false },
  }, async ({ under, name }) => answer(await guarded(ctx, () => addSubtask(ctx, under, name))));
  server.registerTool("file_idea", {
    title: "File an idea",
    description: "File an idea for later, not a task yet: one sentence and why it's worth doing. tira drafts its file and proposes where it goes; a person approves both before it becomes a task.",
    inputSchema: z.object({ summary: words("the idea, in a sentence"), why: words("why it's worth doing"), under: z.string().trim().min(1).optional().describe("optional: the task it belongs under, if you know") }),
    annotations: { ...WRITES, idempotentHint: false },
  }, async ({ summary, why, under }) => answer(await guarded(ctx, () => fileIdea(ctx, summary, why, under))));
  server.registerTool("add_comment", {
    title: "Comment on a task",
    description: "Reply on a task's comments (get_task shows them): an answer to a person's feedback, a question, or a note on the work. People see it on the ticket, under your name.",
    inputSchema: z.object({ id: taskId, text: z.string().trim().min(1).max(2000).describe("your comment") }),
    annotations: { ...WRITES, idempotentHint: false },
  }, async ({ id, text }) => answer(await guarded(ctx, () => addComment(ctx, id, text))));
  server.registerTool("fill_ticket", {
    title: "Fill in a ticket",
    description: "Write what a task's ticket says: its title, description, steps and estimate (get_task shows them). Only what you give changes, and an empty one clears it. Who it's assigned to is a person's to say: it stays as it is. People see it on the ticket, and the history says you wrote it.",
    inputSchema: z.object({
      id: taskId,
      title: z.string().max(120).optional().describe("optional: a short title, up to 120 characters"),
      description: z.string().max(MAX_DESCRIPTION).optional().describe("optional: what the work is and why, in a few sentences"),
      steps: z.array(z.string().max(MAX_STEP)).max(MAX_STEPS).optional().describe(`optional: the steps to do it, in order, up to ${MAX_STEPS} (these replace the ticket's steps)`),
      estimate: z.string().max(12).optional().describe("optional: how long it should take: a number and a unit, e.g. 30m, 2h, 1d (8 hours) or 1w"),
    }),
    annotations: { ...WRITES, idempotentHint: true },
  }, async ({ id, ...fill }) => answer(await guarded(ctx, () => fillTicket(ctx, id, fill))));
  return server;
}
