// A ticket's words, its comments and its commits (2026-10-24, Isha): three record types beside
// the tasks, like the workspace links (src/tables/links.ts), so the task table is untouched (each
// new table needs Devansh's sign-off):
//
//   ticket   one per task (id = the task's id), versioned: v1 born WRITTEN, each edit a new
//            version REWRITTEN, the whole ticket each time. {task, title?, description?, steps?,
//            estimate?, assignee?, kind?, review?}: what the work is, the steps to it, how long it
//            should take ("2h", "1d"), who does it (a person or one of the project's agents), its
//            work type, and whether Muse reviews it before it's done: its words written by a person
//            on the page or an agent (fill_ticket); who does it, and the review, by a person.
//   comment  any number per task: {task, text, files?}, written by a person (feedback for whoever
//            works on it) or an agent (its reply), as themselves, with up to five files (each
//            named by its id; the bytes are kept apart, src/fold/files.ts). Agents read them.
//   commit   one per (commit, task): {task, repo, sha, pr?, branch?, message}, a commit on a pull
//            request that names the task, or on a branch named after it, as tira found it on GitHub
//            (the sync, or the Complete dialog's own look). A task is completed with one of them as
//            its proof of work.
//
// Tickets and comments are written by people and agents, never the sync; commits only by the sync.
import type { GuardFn, Table } from "./table.ts";
import { fileMetaOk, MAX_FILES } from "../fold/files.ts";
import { isKind, KINDS } from "../fold/kinds.ts";
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
// kind (src/fold/kinds.ts, Isha, 2026-10-26): the kind of work, when someone set one ("" or left
// out: tira guesses it)
export interface TicketWords { title: string; description: string; steps: string[]; estimate: string; kind?: string }
export const ticketWordsProblem = ({ title, description, steps, estimate, kind }: TicketWords): string | undefined => [
  kind !== undefined && kind !== "" && !isKind(kind) ? `A work type is one of ${KINDS.join(", ")}.` : "",
  title !== "" && !TICKET_TITLE.test(title) ? "A title is 1 to 120 characters." : "",
  description.length > MAX_DESCRIPTION || !NO_CONTROL.test(description) ? `A description is up to ${MAX_DESCRIPTION} characters.` : "",
  steps.length > MAX_STEPS || steps.some((x) => x.length > MAX_STEP || /\p{Cc}/u.test(x)) ? `Up to ${MAX_STEPS} steps, each up to ${MAX_STEP} characters.` : "",
  estimate !== "" && !ESTIMATE.test(estimate) ? "A time estimate is a number and a unit: 30m, 2h, 1d or 1w." : "",
].find((x) => x !== "");

// A ticket as it's written, the whole of it each time: its task and each part it says (an empty one
// isn't written); and whether a ticket already says just that (none yet: whether this says nothing).
// review (Isha, 2026-10-26: "human can mark as REVIEW, then only it needs a review"): Muse reviews
// it before it's done; only written when on.
export type TicketPayload = { task: string; title?: string; description?: string; steps?: string[]; estimate?: string; assignee?: string; kind?: string; review?: true };
export function ticketPayload(task: string, words: TicketWords, assignee: string | undefined, review = false): TicketPayload {
  const p: TicketPayload = { task };
  if (words.title) p.title = words.title;
  if (words.description) p.description = words.description;
  if (words.steps.length > 0) p.steps = words.steps;
  if (words.estimate) p.estimate = words.estimate;
  if (assignee) p.assignee = assignee;
  if (words.kind) p.kind = words.kind;
  if (review) p.review = true;
  return p;
}
type Said = { title?: string; description?: string; steps: string[]; estimate?: string; assignee?: string; kind?: string; review?: boolean };
export const saysSame = (before: Said | undefined, p: TicketPayload) =>
  JSON.stringify([before?.title, before?.description, before?.steps ?? [], before?.estimate, before?.assignee, before?.kind, before?.review === true])
  === JSON.stringify([p.title, p.description, p.steps ?? [], p.estimate, p.assignee, p.kind, p.review === true]);

const s = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const optional = (v: unknown, ok: (x: string) => boolean) => v === undefined || (typeof v === "string" && ok(v));
const line = (x: string) => x.trim().length > 0 && x.length <= MAX_STEP && !/\p{Cc}/u.test(x);
const stepsOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= MAX_STEPS && v.every((x) => typeof x === "string" && line(x)));
const byPerson = (actor: string | undefined): actor is string => s(actor) && actor !== SYNC;
// a comment says something: words, or files with or without words
const filesOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length >= 1 && v.length <= MAX_FILES && v.every(fileMetaOk));
const commentSays = (text: unknown, files: unknown) =>
  typeof text === "string" && text.length <= MAX_COMMENT && filesOk(files) && (s(text) || (Array.isArray(files) && files.length > 0));

export const TICKET_GUARDS: Record<string, GuardFn> = {
  ticketWellFormed: ({ actor, payload }) =>
    byPerson(actor) && s(payload.task)
    && optional(payload.title, (x) => TICKET_TITLE.test(x)) && optional(payload.description, (x) => x.length <= MAX_DESCRIPTION)
    && stepsOk(payload.steps) && optional(payload.estimate, (x) => ESTIMATE.test(x)) && optional(payload.assignee, (x) => ASSIGNEE.test(x))
    && optional(payload.kind, isKind) && (payload.review === undefined || payload.review === true),
  commentWellFormed: ({ actor, payload }) => byPerson(actor) && s(payload.task) && commentSays(payload.text, payload.files),
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
