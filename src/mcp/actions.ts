// What tira's tools for agents do: start a task, complete it with proof, block it (with a reason,
// and what it waits on), add a subtask, file an idea, comment, fill in a ticket. Each is written through the dispatcher under
// the agent's own name, as the CLI's and the page's writes are, so the rules, the gates and the
// proof of work are tira's own; a refusal comes back with the page's plain-words hint. A task that
// doesn't exist, or a block that can't wait on what it names, is answered before anything is
// written; a refusal by the rules is in the log, as from the CLI.
import { kindOf } from "../fold/kinds.ts";
import { fold } from "../fold/fold.ts";
import { IDEA, ideaId, placement, whatNext } from "../fold/ideas.ts";
import { makeView } from "../fold/view.ts";
import { flatten, streamView, type TreeRow } from "../render/tree-view.ts";
import { subtaskName } from "../serve/command.ts";
import { blockerProblem, flashFor, hintFor, inOrder } from "../serve/server.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import type { Command } from "../write/write-path.ts";
import type { AgentContext } from "./server.ts";
import type { ToolText } from "./tasks.ts";
import { randomBytes } from "node:crypto";
import { COMMENT, MAX_COMMENT, saysSame, TICKET, ticketPayload, ticketWordsProblem, type TicketWords } from "../tables/tickets.ts";
import { commitsOf, firstLine, shortSha, ticketsOf, type Commit, type Ticket } from "../fold/tickets.ts";

const NODE = "node";
const LINK = /^https:\/\/[^\s]{4,2000}$/;
const IDEA_TEXT_MAX = 500;

// The project's tree as it stands, and one task in it (undefined: no such task).
async function treeNow(c: AgentContext) {
  const r = fold(await c.store.readStream(c.stream), c.registry);
  return { r, rows: flatten(streamView(r, c.stream).roots) };
}
const missing = (c: AgentContext, id: string): ToolText => ({ ok: false, text: `There is no task ${id} in ${c.stream}: list_tasks shows them. Nothing was written.` });

// Writes one command as the agent, and says what happened in the page's words, with the page's
// hint when the rules refused it.
async function write(c: AgentContext, cmd: Command, label: string, row: TreeRow | undefined): Promise<ToolText> {
  const event = cmd.kind === "event" ? cmd.event : "ADD_SUBTASK";
  const r = (await new Dispatcher(c.store, c.registry).submit(cmd)).result;
  const said = flashFor(event, label, r);
  if (said.ok || (r.status !== "rejected" && r.status !== "refused")) return said;
  const hint = hintFor(r.code, r.detail, event, label, row?.state ?? "");
  return { ok: false, text: hint ? `${said.text} What to do: ${hint}` : said.text };
}

const event = (c: AgentContext, id: string, name: string, payload: Record<string, unknown> = {}): Command => ({ stream: c.stream, kind: "event", entity: { type: NODE, id }, event: name, actor: c.actor, payload });
const birth = (c: AgentContext, id: string, payload: Record<string, unknown>): Command => ({ stream: c.stream, kind: "create", entity: { type: NODE, id }, actor: c.actor, payload });

// start: the task moves to in progress (one at a time: the gate says which to finish first)
export async function startTask(c: AgentContext, id: string): Promise<ToolText> {
  const row = (await treeNow(c)).rows.find((x) => x.id === id);
  if (!row) return missing(c, id);
  return write(c, event(c, id, "START"), id, row);
}

// complete: done, with proof of work anyone can re-check (and a note for the history, if given)
// complete: the proof of work is a commit or pull request of the project's repo: one of the task's own
// commits (its sha, or 7 or more of its first characters; one tira hasn't seen yet makes it look on
// GitHub for the task's newest first), else any other, checked on GitHub and kept for the task
export async function completeTask(c: AgentContext, id: string, proof: string, note?: string): Promise<ToolText> {
  const commitsNow = async () => commitsOf((await treeNow(c)).r, c.stream).get(id) ?? [];
  const row = (await treeNow(c)).rows.find((x) => x.id === id);
  if (!row) return missing(c, id);
  const ref = proof.trim().toLowerCase();
  const match = (list: Commit[]) => (ref.length >= 7 ? list.filter((x) => x.sha.startsWith(ref)) : []);
  let commits = await commitsNow();
  let synced: string | undefined;
  if (match(commits).length !== 1 && c.fetchCommits) {
    synced = await c.fetchCommits(id);
    commits = await commitsNow();
  }
  const found = match(commits);
  // Muse reviews it first, when tira has a reviewer (src/serve/review.ts): problems come back as fix
  // subtasks, and the task stays open
  const done = async (ref: string): Promise<ToolText> => {
    // its subtasks still open: tira's rules refuse it, so there's nothing to review yet
    const open = row.children.some((k) => k.state !== "done" && k.state !== "cancelled");
    const reviewed = c.reviewFirst && !open ? await c.reviewFirst(id, ref) : { go: true as const, note: "" };
    if (!reviewed.go) return { ok: false, text: `${reviewed.text} Nothing else was written.` };
    const said = await write(c, event(c, id, "COMPLETE", { evidenceRef: ref, ...(note ? { note } : {}) }), id, row);
    return said.ok && reviewed.note ? { ...said, text: `${said.text}${reviewed.note}` } : said;
  };
  // work that isn't code (Isha, 2026-10-26): a spec, a design, research and the rest are proven by a
  // link to the work itself; a commit still counts for any kind
  const { kind } = kindOf(id, ticketsOf((await treeNow(c)).r, c.stream).get(id));
  if (kind !== "code" && found.length === 0 && LINK.test(proof.trim())) return done(proof.trim());
  if (found.length === 1) return done((found[0] as Commit).sha);
  if (c.proveWith && found.length === 0) {
    const got = await c.proveWith(id, proof).catch((err: unknown) => ({ why: `Couldn't reach GitHub (${(err as Error).message}).` }));
    if ("ref" in got) return done(got.ref);
    return { ok: false, text: `${got.why} Nothing was written.` };
  }
  const after = synced ? ` (${synced})` : "";
  if (commits.length === 0) return { ok: false, text: `${id} has no commits yet${after}: push the work to a branch named after it (${id}), or write "tira: ${id}" in its pull request, then complete it with the commit's id. Nothing was written.` };
  const list = commits.slice(0, 10).map((x) => `${shortSha(x.sha)} ${firstLine(x.message)}`).join("; ");
  const why = found.length > 1 ? `${proof} matches more than one of ${id}'s commits` : `${proof} isn't one of ${id}'s commits`;
  return { ok: false, text: `${why}${after}. Its commits: ${list}. Nothing was written.` };
}

// block: blocked, with the reason; what it waits on is an open task, or a new ticket created under
// it first (found while working on it), as the page's Block does
export async function blockTask(c: AgentContext, id: string, reason: string, waitsOn?: string, newTicket?: string): Promise<ToolText> {
  const { r, rows } = await treeNow(c);
  const row = rows.find((x) => x.id === id);
  if (!row) return missing(c, id);
  if (waitsOn !== undefined && newTicket !== undefined) return { ok: false, text: "Name what it waits on once: an open task (waits_on) or a new ticket (new_ticket), not both. Nothing was written." };
  if (newTicket !== undefined) {
    const name = subtaskName(newTicket);
    if (name === undefined) return { ok: false, text: "A new ticket's name is 1 to 80 characters, with no control characters. Nothing was written." };
    return inOrder([
      () => write(c, birth(c, name, { parent_id: id, kind: "discovered", discovered_during: id }), `${name} under ${id}`, undefined),
      () => write(c, event(c, id, "BLOCK", { reason, blocker: name }), id, row),
    ]);
  }
  if (waitsOn !== undefined && !rows.some((x) => x.id === waitsOn)) return { ok: false, text: `There is no task ${waitsOn} for ${id} to wait on: to wait on a new ticket, name it in new_ticket instead. Nothing was written.` };
  const problem = waitsOn === undefined ? undefined : blockerProblem(r, c.stream, { type: NODE, id }, waitsOn);
  if (problem) return { ok: false, text: `${id} can't wait on that: ${problem}. Nothing was written.` };
  return write(c, event(c, id, "BLOCK", { reason, ...(waitsOn === undefined ? {} : { blocker: waitsOn }) }), id, row);
}

// add a subtask: a new task under one, planned unless the agent says it found the work while doing
// that task (Isha, 2026-10-26: an agent breaking a task into its steps had every step marked found)
export async function addSubtask(c: AgentContext, under: string, name: string, found = false): Promise<ToolText> {
  if (!(await treeNow(c)).rows.some((x) => x.id === under)) return missing(c, under);
  const id = subtaskName(name);
  if (id === undefined) return { ok: false, text: "A subtask's name is 1 to 80 characters, with no control characters. Nothing was written." };
  const kind = found ? { kind: "discovered", discovered_during: under } : {};
  return write(c, birth(c, id, { parent_id: under, ...kind }), `${id} under ${under}`, undefined);
}

// comment on a task: a reply to its feedback, a question or a note, shown on its ticket as the agent's
export async function addComment(c: AgentContext, id: string, text: string): Promise<ToolText> {
  const { rows } = await treeNow(c);
  if (!rows.some((x) => x.id === id)) return missing(c, id);
  const words = text.replaceAll("\r\n", "\n").trim();
  if (words.length > MAX_COMMENT) return { ok: false, text: `Keep a comment to ${MAX_COMMENT} characters. Nothing was written.` };
  const cmd: Command = { stream: c.stream, kind: "create", entity: { type: COMMENT, id: `c-${randomBytes(6).toString("hex")}` }, actor: c.actor, payload: { task: id, text: words } };
  const r = (await new Dispatcher(c.store, c.registry).submit(cmd)).result;
  if (r.status === "appended") return { ok: true, text: `Commented on ${id} (seq ${r.seq}): people see it on the ticket.` };
  return { ok: false, text: `The comment wasn't written: ${r.status === "rejected" || r.status === "refused" ? r.detail : r.status}.` };
}

// fill in a ticket: its title, description, steps and estimate, as the agent, the whole ticket as its
// next version (as the page's Edit saves it). What's left out stays as it is and an empty one is
// cleared; who it's assigned to, and whether Muse reviews it, are a person's to say, so they stay as they are.
export interface TicketFill { title?: string | undefined; description?: string | undefined; steps?: string[] | undefined; estimate?: string | undefined; kind?: string | undefined }
// the ticket's words once filled: each given one, else what it says now, trimmed as the page trims them
const filledWords = (fill: TicketFill, before: Ticket | undefined): TicketWords => ({
  title: (fill.title ?? before?.title ?? "").trim().replaceAll(/\s+/g, " "),
  description: (fill.description ?? before?.description ?? "").replaceAll("\r\n", "\n").trim(),
  steps: (fill.steps ?? before?.steps ?? []).map((x) => x.trim()).filter((x) => x !== ""),
  estimate: (fill.estimate ?? before?.estimate ?? "").trim(),
  kind: (fill.kind ?? before?.kind ?? "").trim(),
});
export async function fillTicket(c: AgentContext, id: string, fill: TicketFill): Promise<ToolText> {
  const { r, rows } = await treeNow(c);
  if (!rows.some((x) => x.id === id)) return missing(c, id);
  if (Object.values(fill).every((x) => x === undefined)) return { ok: false, text: "Give at least one of title, description, steps, estimate or kind. Nothing was written." };
  const before = ticketsOf(r, c.stream).get(id);
  const words = filledWords(fill, before);
  const why = ticketWordsProblem(words);
  if (why) return { ok: false, text: `${why} Nothing was written.` };
  const assignee = before?.assignee;
  const payload = ticketPayload(id, words, assignee, before?.review); // whether Muse reviews it is a person's call: as it was
  if (saysSame(before, payload)) return { ok: true, text: `Nothing changed: ${id}'s ticket already says that.` };
  const cmd: Command = { stream: c.stream, kind: "create", entity: { type: TICKET, id, version: (before?.version ?? 0) + 1 }, actor: c.actor, payload };
  const w = (await new Dispatcher(c.store, c.registry).submit(cmd)).result;
  if (w.status === "appended") return { ok: true, text: `Filled in ${id}'s ticket (seq ${w.seq}): people see it on the ticket. get_task shows it.` };
  return { ok: false, text: `The ticket wasn't written: ${w.status === "rejected" || w.status === "refused" ? w.detail : w.status}.` };
}

// file an idea: its summary and why; tira drafts its file and proposes where it goes, and a person
// approves both before it becomes a task (the CLI's tira idea)
export async function fileIdea(c: AgentContext, summary: string, why: string, under?: string): Promise<ToolText> {
  if (summary.length > IDEA_TEXT_MAX || why.length > IDEA_TEXT_MAX) return { ok: false, text: `Keep the summary and the why to ${IDEA_TEXT_MAX} characters each. Nothing was written.` };
  const { r } = await treeNow(c);
  const view = makeView(new Map(r.entities.filter((e) => e.stream === c.stream).map((e) => [e.key, e])));
  const place = placement(view, c.registry, { summary, why }, under);
  const id = ideaId(view, summary, place.parent);
  const cmd: Command = { stream: c.stream, kind: "create", entity: { type: IDEA, id }, actor: c.actor, payload: { summary, why, ...(under === undefined ? {} : { under }) } };
  const said = flashFor("File idea", id, (await new Dispatcher(c.store, c.registry).submit(cmd)).result); // not a page verb: its label as given
  if (!said.ok) return said;
  return { ok: true, text: `${said.text}\nidea ${id}: "${summary}"\nparent: ${place.parent ?? "not settled"} (${place.basis})\nnext: ${whatNext(place)}` };
}
