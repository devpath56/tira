// A ticket's words, its comments and its commits (2026-10-24, Isha): three record types beside
// the tasks, like the workspace links (src/tables/links.ts), so the task table is untouched (each
// new table needs Devansh's sign-off):
//
//   ticket   one per task (id = the task's id), versioned: v1 born WRITTEN, each edit a new
//            version REWRITTEN, the whole ticket each time. {task, title?, description?, steps?,
//            estimate?, assignee?}: what the work is, the steps to it, how long it should take
//            ("2h", "1d"), and who does it (a person or one of the project's agents): its words
//            written by a person on the page or an agent (fill_ticket), who does it by a person.
//   comment  any number per task: {task, text}, written by a person (feedback for whoever works
//            on it) or an agent (its reply), as themselves. Agents read them (tira's MCP server).
//   commit   one per (commit, task): {task, repo, sha, pr?, branch?, message}, a commit on a pull
//            request that names the task, or on a branch named after it, as tira found it on GitHub
//            (the sync, or the Complete dialog's own look). A task is completed with one of them as
//            its proof of work.
//
// Tickets and comments are written by people and agents, never the sync; commits only by the sync.
import type { GuardFn, Table } from "./table.ts";
import type { EntityTypeDef } from "./registry.ts";
import { REPO, SYNC } from "./links.ts";

export const TICKET = "ticket";
export const COMMENT = "comment";
export const COMMIT = "commit";

// what a ticket may say: a title, words, up to 30 steps, an estimate like 2h or 1d, an assignee
export const TICKET_TITLE = /^(?! )[^\u0000-\u001f\u007f]{1,120}(?<! )$/;
export const ESTIMATE = /^\d{1,3}(?:\.\d{1,2})?\s?[mhdw]$/i;
export const ASSIGNEE = /^[\w.:@-]{1,64}$/;
export const SHA = /^[0-9a-f]{40}$/;
export const MAX_DESCRIPTION = 4000;
export const MAX_STEPS = 30;
export const MAX_STEP = 300;
export const MAX_COMMENT = 2000;
export const NO_CONTROL = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/; // words may have line breaks, nothing else unseen

// What a ticket's words can't say, if anything, in plain words: the page's Edit form and an
// agent's fill_ticket ask the same (each trims them first; who it's assigned to is the page's own).
export interface TicketWords { title: string; description: string; steps: string[]; estimate: string }
export const ticketWordsProblem = ({ title, description, steps, estimate }: TicketWords): string | undefined => [
  title !== "" && !TICKET_TITLE.test(title) ? "A title is 1 to 120 characters." : "",
  description.length > MAX_DESCRIPTION || !NO_CONTROL.test(description) ? `A description is up to ${MAX_DESCRIPTION} characters.` : "",
  steps.length > MAX_STEPS || steps.some((x) => x.length > MAX_STEP || /\p{Cc}/u.test(x)) ? `Up to ${MAX_STEPS} steps, each up to ${MAX_STEP} characters.` : "",
  estimate !== "" && !ESTIMATE.test(estimate) ? "A time estimate is a number and a unit: 30m, 2h, 1d or 1w." : "",
].find((x) => x !== "");

const s = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const optional = (v: unknown, ok: (x: string) => boolean) => v === undefined || (typeof v === "string" && ok(v));
const line = (x: string) => x.trim().length > 0 && x.length <= MAX_STEP && !/\p{Cc}/u.test(x);
const stepsOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= MAX_STEPS && v.every((x) => typeof x === "string" && line(x)));
const byPerson = (actor: string | undefined): actor is string => s(actor) && actor !== SYNC;

export const TICKET_GUARDS: Record<string, GuardFn> = {
  ticketWellFormed: ({ actor, payload }) =>
    byPerson(actor) && s(payload.task)
    && optional(payload.title, (x) => TICKET_TITLE.test(x)) && optional(payload.description, (x) => x.length <= MAX_DESCRIPTION)
    && stepsOk(payload.steps) && optional(payload.estimate, (x) => ESTIMATE.test(x)) && optional(payload.assignee, (x) => ASSIGNEE.test(x)),
  commentWellFormed: ({ actor, payload }) => byPerson(actor) && s(payload.task) && s(payload.text) && (payload.text as string).length <= MAX_COMMENT,
  commitSynced: ({ actor, payload }) =>
    actor === SYNC && s(payload.task) && typeof payload.sha === "string" && SHA.test(payload.sha)
    && typeof payload.repo === "string" && REPO.test(payload.repo) && (payload.pr === undefined || Number.isInteger(payload.pr))
    && (payload.branch === undefined || typeof payload.branch === "string") && typeof payload.message === "string",
};

export function ticketTypes(chart: (name: string) => Table): EntityTypeDef[] {
  const onTask = [{ on: "birth", type: "node", from: "payload.task" as const }];
  return [
    { type: TICKET, versioned: true, createdAs: "WRITTEN", revisedAs: "REWRITTEN", createGuard: "ticketWellFormed", keepBirth: true, mustExist: onTask, regions: { lifecycle: chart("ticket.json") } },
    { type: COMMENT, createdAs: "WRITTEN", createGuard: "commentWellFormed", keepBirth: true, mustExist: onTask, regions: { lifecycle: chart("comment.json") } },
    { type: COMMIT, createdAs: "SYNCED", createGuard: "commitSynced", keepBirth: true, mustExist: onTask, regions: { lifecycle: chart("commit.json") } },
  ];
}
