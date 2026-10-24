// What each task's ticket says, its comments and the commits the sync found for it, read from
// the fold (src/tables/tickets.ts). Read-only: the page, tira's MCP server and the CLI share it.
import type { FoldResult } from "./fold.ts";
import { COMMENT, COMMIT, TICKET } from "../tables/tickets.ts";

export interface Ticket { version: number; title?: string; description?: string; steps: string[]; estimate?: string; assignee?: string; by?: string }
export interface Comment { id: string; text: string; by: string; seq: number; at: string }
export interface Commit { sha: string; message: string; pr: number; repo: string; seq: number }

const str = (b: Record<string, unknown>, k: string) => (typeof b[k] === "string" && (b[k] as string) !== "" ? { [k]: b[k] as string } : {});

// Each task's ticket, by task id: its latest version (each version is the whole ticket).
export function ticketsOf(r: FoldResult, stream: string): Map<string, Ticket> {
  const out = new Map<string, Ticket>();
  for (const e of r.entities) {
    if (e.stream !== stream || e.type !== TICKET) continue;
    const b = e.born ?? {};
    const task = typeof b.task === "string" ? b.task : e.id;
    const version = e.version ?? 1;
    if ((out.get(task)?.version ?? 0) > version) continue;
    const steps = Array.isArray(b.steps) ? b.steps.filter((x): x is string => typeof x === "string") : [];
    out.set(task, { version, ...str(b, "title"), ...str(b, "description"), steps, ...str(b, "estimate"), ...str(b, "assignee"), ...(e.createdBy ? { by: e.createdBy } : {}) });
  }
  return out;
}

// Each task's comments, by task id, oldest first.
export function commentsOf(r: FoldResult, stream: string): Map<string, Comment[]> {
  const out = new Map<string, Comment[]>();
  for (const e of r.entities) {
    if (e.stream !== stream || e.type !== COMMENT) continue;
    const b = e.born ?? {};
    if (typeof b.task !== "string" || typeof b.text !== "string") continue;
    out.set(b.task, [...(out.get(b.task) ?? []), { id: e.id, text: b.text, by: e.createdBy ?? "", seq: e.createdSeq, at: e.lastRecordedAt }]);
  }
  for (const list of out.values()) list.sort((a, b) => a.seq - b.seq);
  return out;
}

// Each task's commits, by task id, newest first: the ones a task can be completed with.
export function commitsOf(r: FoldResult, stream: string): Map<string, Commit[]> {
  const out = new Map<string, Commit[]>();
  for (const e of r.entities) {
    if (e.stream !== stream || e.type !== COMMIT) continue;
    const b = e.born ?? {};
    if (typeof b.task !== "string" || typeof b.sha !== "string") continue;
    out.set(b.task, [...(out.get(b.task) ?? []), { sha: b.sha, message: String(b.message ?? ""), pr: Number(b.pr), repo: String(b.repo ?? ""), seq: e.createdSeq }]);
  }
  for (const list of out.values()) list.sort((a, b) => b.seq - a.seq);
  return out;
}

// A commit as people read it: its short id and the first line of its message.
export const shortSha = (sha: string) => sha.slice(0, 7);
export const firstLine = (message: string) => message.split("\n", 1)[0] ?? "";
