// What tira's tools for agents read: the board's own views of one project (its task index, the
// cursor and the task being worked on, each task's ticket, comments, history and proof), in a few
// plain lines an agent can act on.
import { KIND_WORD, kindOf, PROOF_FOR } from "../fold/kinds.ts";
import { fold } from "../fold/fold.ts";
import { flatten, streamView, type TreeRow } from "../render/tree-view.ts";
import { attentionSince, proofsOf, trails } from "../render/html.ts";
import { taskIndex, type TaskEntry } from "../serve/server.ts";
import { commentsOf, commitsOf, firstLine, mentionsIn, shortSha, taskOfKey, ticketKeys, ticketsOf, unanswered, whereFound, type Comment, type Commit, type Ticket } from "../fold/tickets.ts";
import type { AgentContext } from "./server.ts";

// A tool's answer: its text, and whether it did what was asked (false: the tool reports an error).
export interface ToolText { ok: boolean; text: string }

// The board's words for a task's state (its column titles).
const WORD: Record<string, string> = { unstarted: "to do", in_progress: "in progress", blocked: "blocked", done: "done", cancelled: "dropped" };
export const stateWord = (state: string) => WORD[state] ?? state.replaceAll("_", " ");
const where = (path: string) => (path === "" ? "top level" : `under ${path}`);
const CLOSED = new Set(["done", "cancelled"]);

// What list_tasks can show: the open ones (the default), every one, or those in one state.
export const LIST_STATES = ["open", "all", "unstarted", "in_progress", "blocked", "done", "cancelled"] as const;
export type ListState = (typeof LIST_STATES)[number];
const LIST_MAX = 200;

// The project as it stands: its log, folded, its tree's rows and the task index (paths, ◆ next).
async function projectNow(c: AgentContext) {
  const events = await c.store.readStream(c.stream);
  const r = fold(events, c.registry);
  const view = streamView(r, c.stream);
  const index = new Map(taskIndex(r, c.stream).map((t) => [t.key, t]));
  return { events, r, view, rows: flatten(view.roots), index, tickets: ticketsOf(r, c.stream), comments: commentsOf(r, c.stream), commits: commitsOf(r, c.stream) };
}

// the task an agent named: its id, or its key (TIRA_<PROJECT>_<n>, src/fold/tickets.ts)
export async function taskIdOf(c: AgentContext, said: string): Promise<string> {
  if (!/^tira_/i.test(said.trim())) return said;
  return taskOfKey(ticketKeys(fold(await c.store.readStream(c.stream), c.registry), c.stream), said);
}

// comments since the agent's own last one, from someone else: the feedback it hasn't answered
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const line = (t: TaskEntry) => `${t.id} (${where(t.path)})`;

// what's next: the task being worked on, then the next one in order, how many are blocked, the open
// tasks assigned to this agent, and feedback on them it hasn't answered
export async function nextTask(c: AgentContext): Promise<ToolText> {
  const { view, rows, index, tickets, comments } = await projectNow(c);
  if (rows.length === 0) return { ok: true, text: `No tasks in ${c.stream} yet.` };
  const lines: string[] = [];
  for (const row of rows.filter((x) => x.active)) {
    const t = index.get(row.key);
    if (!t) continue;
    lines.push(`In progress: ${line(t)}${row.awaitingClose ? ": its subtasks are all closed, tira closes it when work moves on" : ""}`);
  }
  if (lines.length === 0) lines.push("In progress: nothing.");
  // the next task, unless it's the one in progress (the board's ◆ now)
  const next = view.cursor === null ? undefined : index.get(view.cursor);
  if (!next) lines.push("Next: no open work left.");
  else if (!view.active.includes(next.key)) lines.push(`Next: ${line(next)}`);
  const blocked = rows.filter((x) => x.state === "blocked").length;
  if (blocked > 0) lines.push(`Blocked: ${blocked} (list_tasks with state "blocked" shows them)`);
  const mine = rows.filter((x) => !CLOSED.has(x.state) && tickets.get(x.id)?.assignee === c.actor);
  if (mine.length > 0) lines.push(`Assigned to you: ${mine.map((x) => x.id).join(", ")}`);
  const followed = rows.filter((x) => x.active || mine.includes(x));
  for (const row of followed) {
    const fresh = unanswered(comments.get(row.id) ?? [], c.actor);
    const last = fresh.at(-1);
    if (last) lines.push(`Feedback on ${row.id}: ${fresh.length} new, latest from ${last.by}: "${clip(last.text.replaceAll("\n", " "), 160)}" (get_task shows it; add_comment replies)`);
  }
  lines.push(...mentionLines(rows.filter((x) => !CLOSED.has(x.state) && !followed.includes(x)), tickets, comments, c.actor));
  return { ok: true, text: lines.join("\n") };
}

// where someone named this agent (@name) on an open task it isn't already following: a comment it
// hasn't answered since, or the ticket's own words
function mentionLines(rows: readonly TreeRow[], tickets: ReadonlyMap<string, Ticket>, comments: ReadonlyMap<string, Comment[]>, actor: string): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const asked = unanswered(comments.get(row.id) ?? [], actor).filter((x) => mentionsIn(x.text).includes(actor)).at(-1);
    if (asked) out.push(`Mentioned on ${row.id} by ${asked.by}: "${clip(asked.text.replaceAll("\n", " "), 160)}" (get_task shows it; add_comment replies)`);
  }
  const words = (t: Ticket | undefined) => [t?.description ?? "", ...(t?.steps ?? [])].join("\n");
  const named = rows.filter((row) => mentionsIn(words(tickets.get(row.id))).includes(actor)).map((row) => row.id);
  if (named.length > 0) out.push(`Mentioned in the ticket: ${named.join(", ")} (get_task shows it)`);
  return out;
}

const fits = (state: string, wanted: ListState) => {
  if (wanted === "open") return !CLOSED.has(state);
  return wanted === "all" || state === wanted;
};

// the project's tasks, in the board's order: id, state, where it sits, and ◆ on the next one
export async function listTasks(c: AgentContext, wanted: ListState = "open"): Promise<ToolText> {
  const { index, tickets } = await projectNow(c);
  const tasks = [...index.values()].filter((t) => fits(t.state, wanted));
  if (tasks.length === 0) return { ok: true, text: `No ${wanted === "all" ? "" : stateWord(wanted) + " "}tasks in ${c.stream}.` };
  const about = (t: TaskEntry) => {
    const k = tickets.get(t.id);
    return (k?.title ? ` "${k.title}"` : "") + (k?.assignee ? ` · assigned to ${k.assignee}` : "");
  };
  const lines = tasks.slice(0, LIST_MAX).map((t) => `${t.id} · ${t.ticket} · ${stateWord(t.state)} · ${where(t.path)}${t.next ? " · ◆ next" : ""}${about(t)}`);
  if (tasks.length > LIST_MAX) lines.push(`…and ${tasks.length - LIST_MAX} more: narrow it with state.`);
  return { ok: true, text: lines.join("\n") };
}

const kid = (k: TreeRow) => `${k.id} (${stateWord(k.state)})`;
const kidsLine = (row: TreeRow) => (row.children.length === 0 ? [] : [`Subtasks: ${row.children.map(kid).join(", ")}`]);
const bare = (key: string) => key.slice(key.indexOf(":") + 1);

// what a ticket says, in lines: its title, description, steps, estimate and assignee
// its kind of work (its ticket's, or tira's guess) and so what proof of it complete_task takes
function kindLine(id: string, k: Ticket | undefined): string {
  const { kind, guessed } = kindOf(id, k);
  return `Work type: ${KIND_WORD[kind]}${guessed ? " (tira's guess: fill_ticket sets it)" : ""}. Proof for it: ${PROOF_FOR[kind]}.${k?.review ? " A person marked it for review: Muse checks the work when it's completed." : ""}`;
}
function ticketLines(k: Ticket | undefined): string[] {
  if (!k) return ["Ticket: no description, steps, estimate or assignee yet (fill_ticket writes all but the assignee)."];
  return [
    ...(k.title ? [`Title: ${k.title}`] : []),
    ...(k.description ? ["Description:", ...k.description.split("\n").map((x) => `  ${x}`)] : []),
    ...(k.steps.length > 0 ? ["Steps:", ...k.steps.map((x, i) => `  ${i + 1}. ${x}`)] : []),
    ...(k.estimate ? [`Estimate: ${k.estimate}`] : []),
    ...(k.assignee ? [`Assignee: ${k.assignee}`] : []),
  ];
}
const commentLines = (list: readonly Comment[]) =>
  list.length === 0 ? ["Comments: none yet (add_comment writes one)."] : [`Comments (${list.length}, oldest first):`, ...list.map((x) => `  seq ${x.seq} · ${x.by}: ${x.text.replaceAll("\n", "\n    ")}`)];

// the commits complete_task takes as proof (as the last sync found them)
const commitLines = (id: string, list: readonly Commit[]) =>
  list.length === 0
    ? [`Commits: none yet (push to a branch named ${id}, or write "tira: ${id}" in a pull request; complete_task looks on GitHub first)`]
    : ["Commits (complete_task takes one as proof):", ...list.slice(0, 10).map((x) => `  ${shortSha(x.sha)} ${firstLine(x.message)} (${whereFound(x)})`)];

// one task: its state and place, its ticket, its subtasks, why it's blocked and on what, its proof,
// its comments and its history
export async function getTask(c: AgentContext, id: string): Promise<ToolText> {
  const { events, r, rows, index, tickets, comments, commits } = await projectNow(c);
  const row = rows.find((x) => x.id === id);
  const t = row ? index.get(row.key) : undefined;
  if (!row || !t) return { ok: false, text: `There is no task ${id} in ${c.stream}: list_tasks shows them.` };
  const skip = new Set(r.anomalies.map((a) => a.seq));
  const marks = [row.cursor && !row.active ? "◆ next" : "", row.discoveredDuring ? `found during ${bare(row.discoveredDuring)}` : ""].filter(Boolean);
  const lines = [`${row.id} · ${t.ticket} · ${stateWord(row.state)} · ${where(t.path)}${marks.map((m) => " · " + m).join("")}`, ...ticketLines(tickets.get(row.id)), kindLine(row.id, tickets.get(row.id)), ...kidsLine(row)];
  const since = row.state === "blocked" ? attentionSince(events, c.stream, skip).blocked.get(row.key) : undefined;
  if (since?.reason) lines.push(`Blocked: ${since.reason}`);
  if (since?.blocker) lines.push(`Waiting on: ${bare(since.blocker)}`);
  const proof = proofsOf(events, c.stream, skip).get(row.key);
  if (proof) lines.push(`Proof: ${proof.ref} (from ${proof.actor}, seq ${proof.seq})`);
  if (!CLOSED.has(row.state)) lines.push(...commitLines(row.id, commits.get(row.id) ?? []));
  lines.push(...commentLines(comments.get(row.id) ?? []));
  lines.push("History:", ...(trails(events, c.stream).byKey.get(row.key) ?? []).map((e) => `  seq ${e.seq} · ${e.what} · ${e.actor}${e.detail ? " · " + e.detail : ""}`));
  return { ok: true, text: lines.join("\n") };
}
