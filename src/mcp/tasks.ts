// What tira's tools for agents read: the board's own views of one project (its task index, the
// cursor and the task being worked on, each task's history and proof), in a few plain lines an
// agent can act on.
import { fold } from "../fold/fold.ts";
import { flatten, streamView, type TreeRow } from "../render/tree-view.ts";
import { attentionSince, proofsOf, trails } from "../render/html.ts";
import { taskIndex, type TaskEntry } from "../serve/server.ts";
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
  return { events, r, view, rows: flatten(view.roots), index };
}

const line = (t: TaskEntry) => `${t.id} (${where(t.path)})`;

// what's next: the task being worked on, then the next one in order, and how many are blocked
export async function nextTask(c: AgentContext): Promise<ToolText> {
  const { view, rows, index } = await projectNow(c);
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
  return { ok: true, text: lines.join("\n") };
}

const fits = (state: string, wanted: ListState) => {
  if (wanted === "open") return !CLOSED.has(state);
  return wanted === "all" || state === wanted;
};

// the project's tasks, in the board's order: id, state, where it sits, and ◆ on the next one
export async function listTasks(c: AgentContext, wanted: ListState = "open"): Promise<ToolText> {
  const { index } = await projectNow(c);
  const tasks = [...index.values()].filter((t) => fits(t.state, wanted));
  if (tasks.length === 0) return { ok: true, text: `No ${wanted === "all" ? "" : stateWord(wanted) + " "}tasks in ${c.stream}.` };
  const lines = tasks.slice(0, LIST_MAX).map((t) => `${t.id} · ${stateWord(t.state)} · ${where(t.path)}${t.next ? " · ◆ next" : ""}`);
  if (tasks.length > LIST_MAX) lines.push(`…and ${tasks.length - LIST_MAX} more: narrow it with state.`);
  return { ok: true, text: lines.join("\n") };
}

const kid = (k: TreeRow) => `${k.id} (${stateWord(k.state)})`;
const kidsLine = (row: TreeRow) => (row.children.length === 0 ? [] : [`Subtasks: ${row.children.map(kid).join(", ")}`]);
const bare = (key: string) => key.slice(key.indexOf(":") + 1);

// one task: its state and place, its subtasks, why it's blocked and on what, its proof, its history
export async function getTask(c: AgentContext, id: string): Promise<ToolText> {
  const { events, r, rows, index } = await projectNow(c);
  const row = rows.find((x) => x.id === id);
  const t = row ? index.get(row.key) : undefined;
  if (!row || !t) return { ok: false, text: `There is no task ${id} in ${c.stream}: list_tasks shows them.` };
  const skip = new Set(r.anomalies.map((a) => a.seq));
  const marks = [row.cursor && !row.active ? "◆ next" : "", row.discoveredDuring ? `found during ${bare(row.discoveredDuring)}` : ""].filter(Boolean);
  const lines = [`${row.id} · ${stateWord(row.state)} · ${where(t.path)}${marks.map((m) => " · " + m).join("")}`, ...kidsLine(row)];
  const since = row.state === "blocked" ? attentionSince(events, c.stream, skip).blocked.get(row.key) : undefined;
  if (since?.reason) lines.push(`Blocked: ${since.reason}`);
  if (since?.blocker) lines.push(`Waiting on: ${bare(since.blocker)}`);
  const proof = proofsOf(events, c.stream, skip).get(row.key);
  if (proof) lines.push(`Proof: ${proof.ref} (from ${proof.actor}, seq ${proof.seq})`);
  lines.push("History:", ...(trails(events, c.stream).byKey.get(row.key) ?? []).map((e) => `  seq ${e.seq} · ${e.what} · ${e.actor}${e.detail ? " · " + e.detail : ""}`));
  return { ok: true, text: lines.join("\n") };
}
