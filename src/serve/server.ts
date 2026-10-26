// `tira serve` (the D1 UI brief; approved 2026-10-19: localhost only, every change
// through the guarded write path). The page, live: each request folds the log and renders
// it, as `tira render` does, plus what only a live page can have: actions, the ⌘K
// palette and the last action's result.
//
// Every action goes through a decision first (trust at the time of action), in two views:
// the work in a nutshell, what tira recommends and why it would refuse (brief.ts), and your
// action as a tira command, filled in and editable before it runs (command.ts). Nothing on
// the page fires a write by itself.
//
// Safety: bound to 127.0.0.1; any other Host is refused (DNS rebinding); a write needs
// this process's random token and, when the browser sends one, a same-origin Origin
// (cross-site forms); the actor is the person signed in with GitHub, or a name fixed when the
// server starts (then no one needs to sign in); only the tree verbs
// below, and an idea's approvals, are accepted; a strict Content-Security-Policy allows only
// this server's scripts.
//
// Ideas (D5, the vapor catch): an idea's two approvals, the file then the placement, go through
// the same decision. A stage skip (approving the placement while the file is still pending) is
// refused in the dialog with a plain reason, and the placement's parent is checked before the
// approval is written: the task the idea becomes must fit there.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventStore, StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { fingerprint, fold, type FoldResult } from "../fold/fold.ts";
import { entityKey } from "../fold/types.ts";
import { attentionSince, brand, CSS, mentionedHtml, proofsOf, renderHtml, THEME_RADIOS, type DivergencePanel } from "../render/html.ts";
import { flatten, streamView } from "../render/tree-view.ts";
import { esc } from "../render/escape.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import { WritePath, isReservedActor, type Command, type Preview, type WriteResult } from "../write/write-path.ts";
import { blockerOf, commandFor, dragMoves, missing, PAGE_VERBS, parseCommand, subtaskName, verbFits, withDefaults, type PageAction } from "./command.ts";
import { briefFor, ideaBriefFor, ideaRefusal, type Brief, type BriefFacts } from "./brief.ts";
import { IDEA, ideaRows, placeProblem, type IdeaRow } from "../fold/ideas.ts";
import { compareCodeUnits, makeView } from "../fold/view.ts";
import { linksOf, workspaceOf } from "../fold/workspace.ts";
import { JIRA_PROJECT, REPO, TITLE, WORKSPACE, WORKSPACE_ID } from "../tables/links.ts";
import { ASSIGNEE, COMMENT, MAX_COMMENT, NO_CONTROL, saysSame, TICKET, ticketPayload, ticketWordsProblem, type TicketWords } from "../tables/tickets.ts";
import { commitsOf, ticketKeys, ticketsOf, type Ticket } from "../fold/tickets.ts";
import { lookedSaid, lookForCommits, proofSaid, proveWith } from "../sync/commits.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { appKeys, atlassianAuth, displayName, emailOf, importAccountsFile, isBlocked, postgresAccounts, refreshAccounts, saveProject, sessionLogin } from "../sync/credentials.ts";
import { projectName } from "../sync/jira.ts";
import { accounts, integrationRoutes, NEXT_COOKIE, whoIs, type MyProject, type Outside } from "./integrations.ts";
import { everyone, inProject, isProjectAdmin, makers, MAX_PROJECTS, projectPeople } from "./team.ts";
import { newProjectPage, type NewProject } from "./new-project.ts";
import { consentCsp, CSP } from "./csp.ts";
import { consentPage } from "./welcome.ts";
import { agentNameProblem } from "../mcp/names.ts";
import { askingOf, authorizationServer, AUTHORIZATION_SERVER, clientId, Codes, CONNECTOR_APP, PROTECTED_RESOURCE, protectedResource, registrationOf, withQuery, type Asking } from "../mcp/oauth.ts";
import { MCP_PATH, mcpRoute } from "../mcp/http.ts";
import { agentTokensFor, freeName } from "../mcp/tokens.ts";
import type { PublicSite } from "./public.ts";

export { PAGE_VERBS } from "./command.ts";
export { CSP } from "./csp.ts";
// Referrer-Policy is same-origin, not no-referrer: under no-referrer browsers send
// `Origin: null` on form posts, and the same-origin check below would refuse the page's
// own writes (found by submitting a real form, 2026-10-20).
const HEADERS = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": "no-store" };
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const MAX_BODY = 16 * 1024;

const ASSETS: Record<string, string> = {
  "/app.mjs": readFileSync(new URL("./app.mjs", import.meta.url), "utf8"),
  "/rank.mjs": readFileSync(new URL("./rank.mjs", import.meta.url), "utf8"),
  "/theme.mjs": readFileSync(new URL("./theme.mjs", import.meta.url), "utf8"),
  "/graph.mjs": readFileSync(new URL("./graph.mjs", import.meta.url), "utf8"),
  "/layout.mjs": readFileSync(new URL("./layout.mjs", import.meta.url), "utf8"),
  "/signin.mjs": readFileSync(new URL("./signin.mjs", import.meta.url), "utf8"),
  "/tabs.mjs": readFileSync(new URL("./tabs.mjs", import.meta.url), "utf8"),
  "/new-project.mjs": readFileSync(new URL("./new-project.mjs", import.meta.url), "utf8"),
  "/help.mjs": readFileSync(new URL("./help.mjs", import.meta.url), "utf8"),
  "/secrets.mjs": readFileSync(new URL("./secrets.mjs", import.meta.url), "utf8"),
  "/drag.mjs": readFileSync(new URL("./drag.mjs", import.meta.url), "utf8"),
  "/agents.mjs": readFileSync(new URL("./agents.mjs", import.meta.url), "utf8"),
  "/land.mjs": readFileSync(new URL("./land.mjs", import.meta.url), "utf8"),
};

export interface ServeOptions {
  store: EventStore;
  registry: Registry;
  stream: string;
  // who the page acts as, fixed for the server's life, until GitHub sign-in is set up; without it,
  // everyone signs in (the page starts at /welcome)
  actor?: string;
  token?: string; // tests may pin it; otherwise random per process
  // The page's divergence section, computed per page load from the events that load renders
  // (the CLI passes tira divergence's own differ); never a stored report.
  divergence?: (events: StoredEvent[]) => DivergencePanel;
  // GitHub and Jira (the Integrations page, src/serve/integrations.ts); tests pass stand-ins.
  // Absent: the real GitHub and Atlassian, and the private store under $TIRA_HOME.
  links?: Outside;
  // the public https address tira is reached at (src/serve/public.ts); absent: this computer only
  site?: PublicSite;
}

// ticket: its TIRA_<PROJECT>_<n> (src/fold/tickets.ts)
export interface TaskEntry { key: string; type: string; id: string; state: string; path: string; drawer: string; next: boolean; ticket: string }

// The palette's index: every tree task, in the page's drawer order (#t<i>); `next` marks the
// task tira says comes next, which the palette offers first.
export function taskIndex(r: FoldResult, stream: string): TaskEntry[] {
  const view = streamView(r, stream);
  const roots = view.roots;
  const rows = flatten(roots);
  const parentOf = new Map<string, string>();
  const walk = (row: (typeof rows)[number]) => row.children.forEach((c) => { parentOf.set(c.key, row.key); walk(c); });
  roots.forEach(walk);
  const idOf = new Map(rows.map((x) => [x.key, x.id]));
  const keys = ticketKeys(r, stream);
  return rows.map((row, i) => {
    const up: string[] = [];
    for (let p = parentOf.get(row.key); p !== undefined; p = parentOf.get(p)) up.unshift(idOf.get(p) ?? p);
    return { key: row.key, type: row.type, id: row.id, state: row.state, path: up.join(" › "), drawer: `t${i}`, next: row.key === view.cursor, ticket: keys.get(row.id) ?? "" };
  });
}

// Workspaces: one task tree each, a stream in the store. The server starts on one (--stream) and
// serves any other the store holds at ?w=<name>; every link and form it makes carries that on,
// so a page, its decisions and their writes stay in the workspace they were opened in.
export interface Workspace { stream: string; q: string } // q: "w=…", or "" for the one it started on
// what joins a query onto a path: ? for the first, & after
const joiner = (path: string) => (path.includes("?") ? "&" : "?");
export const withQ = (path: string, q: string) => (q === "" ? path : `${path}${joiner(path)}${q}`);
const MAX_NAME = 200;
// a new project's name: the same rule the New project page's field shows
const NEW_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
// a request's route: its method and path (a profile, /u/<username>, is one route)
const routeKey = (method: string | undefined, path: string) => `${method} ${/^\/u\/[^/]+$/.test(path) ? "/u" : path}`;
// the workspace a request names, or undefined when the name can't be one
export function workspaceIn(url: URL, home: string): Workspace | undefined {
  const w = url.searchParams.get("w");
  if (w === null || w === "" || w === home) return { stream: home, q: "" };
  if (w.length > MAX_NAME || [...w].some((c) => (c.codePointAt(0) ?? 0) < 32 || c === "\u007f")) return undefined;
  return { stream: w, q: `w=${encodeURIComponent(w)}` };
}

export interface WorkspaceEntry { stream: string; title?: string; href: string; current: boolean; tasks: number; open: number; attention: number }

// The switcher's list: every stream with something in it (but deleted projects), by name as people see it, each with where it opens,
// its tasks (the leaves, as the page counts them), those still open, and how many need you
// (blocked, or being worked on: the page's Needs attention count).
export function workspaceList(r: FoldResult, streams: readonly string[], home: string, current: string): WorkspaceEntry[] {
  const live = [...new Set(streams)].map((stream) => ({ stream, link: workspaceOf(r, stream) })).filter((x) => !x.link?.deleted);
  const named = (x: { stream: string; link?: { title?: string } | undefined }) => x.link?.title ?? x.stream; // as people see it
  live.sort((a, b) => compareCodeUnits(named(a), named(b)));
  return live.map(({ stream, link }) => {
    const rows = flatten(streamView(r, stream).roots);
    const leaves = rows.filter((x) => x.children.length === 0);
    const attention = rows.filter((x) => x.state === "blocked" || (x.active && !x.awaitingClose)).length;
    return { stream, ...(link?.title ? { title: link.title } : {}), href: withQ("/", stream === home ? "" : `w=${encodeURIComponent(stream)}`), current: stream === current, tasks: leaves.length, open: leaves.filter((x) => !CLOSED.has(x.state)).length, attention };
  });
}

// waitables: to block, the open tasks it could wait on instead of a new ticket; parents: to place an
// idea, the tasks tira found for it
// ticket: what the task's ticket says (src/fold/tickets.ts), shown beside the move
// closes: the finished parents tira closes first, citing the move
interface Packet { ok: boolean; title: string; verdict: string; hint?: string; seen: number; brief?: Brief; command?: string; suggestions: string[]; found?: boolean; waitables?: string[]; parents?: string[]; ticket?: Ticket; closes?: string[] }

export interface PacketAsk { wp: WritePath; r: FoldResult; events: readonly StoredEvent[]; registry: Registry; stream: string; actor: string; type: string; id: string; event: string }

const bareKey = (key: string) => key.replace(/^[^:]+:/, "");
const spaced = (state: string) => state.replace("_", " ");
const CLOSED = new Set(["done", "cancelled"]);

function verdictOf(pv: Preview): string {
  if (!pv.ok) return `tira would refuse this: ${pv.code}: ${pv.detail}.`;
  return pv.outcome === "noop" ? "tira's check: allowed, but nothing changes (already so)." : "tira's check: allowed.";
}

// What to do instead, when tira would refuse: the refusals a person can act on.
export function hintFor(code: string, detail: string, event: string, id: string, state: string): string | undefined {
  const verb = (PAGE_VERBS[event]?.label ?? event).toLowerCase();
  if (code === "gate" && detail.startsWith("one active task: ")) {
    const others = detail.slice("one active task: ".length).replace(/ is already active$/, "").split(", ").map(bareKey);
    return `Only one task can be in progress. Complete or block ${others.join(", ")} first, then ${verb} ${id}.`;
  }
  const open = / has open children (.+)$/.exec(detail) ?? /while children are open: (.+?) \(close them first\)$/.exec(detail);
  if (code === "gate" && open) return `Close its open subtasks first (complete or cancel them): ${(open[1] ?? "").split(", ").map(bareKey).join(", ")}.`;
  const reopenFirst = /re-open (\S+?):?(?: first| \()/.exec(detail);
  if ((code === "gate" || code === "denied") && reopenFirst) return `Re-open ${bareKey(reopenFirst[1] ?? "")} first, with a reason.`;
  if (code !== "denied") return undefined;
  if (state === "cancelled") return "Cancelled is final: add a new task instead.";
  if (state === "blocked" && event === "START") return `${id} is blocked: unblock it instead.`;
  if (state === "unstarted" && event === "COMPLETE") return `Start ${id} first.`;
  if (event === "UNBLOCK") return `${id} isn't blocked.`;
  if (event === "REOPEN") return `Only a done task can be re-opened; ${id} is ${spaced(state)}.`;
  return undefined;
}

// The facts the left view is written from: the task, where it sits, its subtasks, why and
// since when it's blocked (the needs-attention reading), its proof, what's next, and tira's
// preview of the move (the rule it must pass, what tira closes first, or the refusal).
function factsFor(ask: PacketAsk, state: string, region: string, pv: Preview, found: boolean): BriefFacts {
  const { r, events, stream, type, id, event } = ask;
  const key = entityKey({ type, id });
  const v = streamView(r, stream);
  const rows = flatten(v.roots);
  const row = rows.find((x) => x.key === key);
  const up = rows.find((x) => x.children.some((c) => c.key === key));
  const idOf = (k: string) => rows.find((x) => x.key === k)?.id ?? bareKey(k);
  const skip = new Set(r.anomalies.map((a) => a.seq));
  const stretch = attentionSince(events, stream, skip);
  const since = (state === "blocked" ? stretch.blocked : stretch.working).get(key);
  // what it waits on: the blocker ticket the block named, else a reason "waiting on <task>"
  const waiting = state === "blocked" ? /^waiting on (.+)$/.exec(since?.reason?.trim() ?? "")?.[1] : undefined;
  const ticket = state === "blocked" ? since?.blocker : undefined;
  const byTicket = ticket === undefined ? undefined : rows.find((x) => x.key === ticket);
  const waitRow = byTicket ?? rows.find((x) => waiting !== undefined && x.id === waiting);
  const hit = ask.registry.resolve(type, event);
  const guard = hit?.table.pairs.find((x) => x.from === state && x.event === event)?.guard;
  const rule = guard === undefined ? undefined : hit?.table.guards[guard] ?? guard;
  return {
    id, event, state, found, actor: ask.actor,
    parent: up ? { id: up.id, state: up.state, closable: (ask.registry.get(type)?.tree?.actionable ?? []).includes(up.state), othersOpen: up.children.filter((c) => c.key !== key && !CLOSED.has(c.state)).length } : undefined,
    kids: (row?.children ?? []).map((c) => ({ id: c.id, state: c.state })),
    since: since ? { seq: since.seq, reason: since.reason } : undefined,
    proof: proofsOf(events, stream, skip).get(key)?.ref,
    next: v.cursor === null ? undefined : idOf(v.cursor),
    active: v.active.filter((k) => k !== key).map(idOf),
    waitingOn: waitRow ? { id: waitRow.id, state: waitRow.state } : undefined,
    preview: pv.ok
      ? { ok: true, noop: pv.outcome === "noop", to: pv.regions[region], closes: pv.closes.map(bareKey), rule }
      : { ok: false, code: pv.code, detail: pv.detail, closes: [], rule },
  };
}

// A decision, in two views: what tira says and recommends (brief.ts), and the command it
// will run, filled in (command.ts). The verdict is the write path's own (WritePath.preview:
// reserved names, tira's closes, then the rules), with any value you still have to fill in
// counted as filled. `seen` is the stream's last seq it was decided on: the write is refused
// if the log moved since (the decision is shown again).
export async function packetFor(ask: PacketAsk): Promise<Packet> {
  const { r, registry, stream, type, id, event } = ask;
  const verb = PAGE_VERBS[event];
  const title = `${verb?.label ?? event} ${id}?`;
  const seen = r.lastSeq;
  if (type === IDEA) return ideaPacketFor(ask);
  if (!verb) return { ok: false, title, verdict: `tira doesn't take ${event} from the page.`, seen, suggestions: [] };
  if (verb.on !== undefined) return { ok: false, title, verdict: `${verb.label} is for ${verb.on}s, not tasks.`, seen, suggestions: [] };
  const current = r.entities.find((e) => e.stream === stream && e.key === entityKey({ type, id }));
  const cfg = registry.get(type)?.tree;
  if (!current || !cfg) return { ok: false, title, verdict: `There is no task ${id}.`, seen, suggestions: [] };
  const state = current.regions[cfg.region] ?? "";
  // a subtask added while its parent is under way was found while working on it
  const found = verb.creates === true && (state === "in_progress" || state === "blocked");
  const pv = verb.creates
    // the new task's name isn't known yet: judge the birth under a stand-in name
    ? await ask.wp.preview({ stream, kind: "create", entity: { type, id: "(new subtask)" }, actor: ask.actor, payload: { parent_id: id } })
    : await ask.wp.preview({ stream, kind: "event", entity: { type, id }, event, actor: ask.actor, payload: verb.field ? { [verb.field.name]: "(you fill this in)" } : {} });
  const hint = pv.ok ? undefined : hintFor(pv.code, pv.detail, event, id, state);
  const suggestions = verb.field?.suggest ? reasonSuggestions(ask.events, stream, r, event, id) : [];
  return {
    ok: pv.ok, title, verdict: verdictOf(pv), ...(hint ? { hint } : {}), seen, suggestions, found, ...packetExtras(ask, pv),
    brief: briefFor(factsFor(ask, state, cfg.region, pv, found)),
    command: commandFor(type, id, event, found),
  };
}
// what only some decisions carry: to block, the open tasks it could wait on; the finished parents
// tira closes too; the task's ticket, once written
function packetExtras({ r, stream, id, event }: PacketAsk, pv: Preview): Partial<Packet> {
  const ticket = ticketsOf(r, stream).get(id);
  return {
    ...(event === "BLOCK" ? { waitables: waitable(r, stream, id) } : {}),
    ...(pv.ok && pv.closes.length > 0 ? { closes: pv.closes.map(bareKey) } : {}),
    ...(ticket ? { ticket } : {}),
  };
}

// The stream as one view, for the checks that read the tree (an idea's parent).
const viewOf = (r: FoldResult, stream: string) => makeView(new Map(r.entities.filter((e) => e.stream === stream).map((e) => [e.key, e])));

// An idea's approval, in the same two views. The verdict is the write path's, said in plain words
// when it is a stage skip; approving the placement is also judged on the task it becomes (the
// birth tira writes next): the parent must take it.
// What the idea dialog says: tira's refusal of a stage skip, a parent that can't take the task,
// or the plain preview.
function ideaVerdict(pv: Preview, refusal: { why: string; todo: string } | undefined, misplaced: string | undefined): { verdict: string; hint: string | undefined } {
  if (refusal) {
    const code = pv.ok ? "" : `${pv.code}: ${pv.detail}`;
    return { verdict: `tira would refuse this: ${refusal.why} (${code}).`, hint: refusal.todo };
  }
  if (misplaced) return { verdict: `tira would refuse this: ${misplaced}.`, hint: "Put it under another task: change parent_id." };
  return { verdict: verdictOf(pv), hint: undefined };
}

async function ideaPacketFor(ask: PacketAsk): Promise<Packet> {
  const { r, events, registry, stream, id, event } = ask;
  const verb = PAGE_VERBS[event];
  const title = `${verb?.label ?? event} ${id}?`;
  const seen = r.lastSeq;
  const own = Object.keys(PAGE_VERBS).filter((k) => PAGE_VERBS[k]?.on === IDEA).map((k) => PAGE_VERBS[k]?.label.toLowerCase()).join(", ");
  if (verb?.on !== IDEA) return { ok: false, title, verdict: `tira doesn't take ${event} on an idea from the page: an idea takes ${own}.`, seen, suggestions: [] };
  const idea = ideaRows(r, events, stream).find((i) => i.id === id);
  if (!idea) return { ok: false, title, verdict: `There is no idea ${id}.`, seen, suggestions: [] };
  const parent = event === "APPROVE_NODE" ? idea.proposal?.parent : undefined;
  const filled = verb.field ? { [verb.field.name]: parent ?? "(you fill this in)" } : {};
  const pv = await ask.wp.preview({ stream, kind: "event", entity: { type: IDEA, id }, event, actor: ask.actor, payload: filled });
  const refusal = pv.ok ? undefined : ideaRefusal(idea.stage, event, id, idea.summary !== undefined);
  const misplaced = pv.ok && parent !== undefined ? placeProblem(viewOf(r, stream), registry, id, parent) : undefined;
  const hit = registry.resolve(IDEA, event);
  const guard = hit?.table.pairs.find((x) => x.from === idea.stage && x.event === event)?.guard;
  const { verdict, hint } = ideaVerdict(pv, refusal, misplaced);
  return {
    ok: pv.ok && misplaced === undefined, title, verdict, ...(hint ? { hint } : {}), seen, suggestions: [],
    // the tasks tira found, as buttons, unless the one it found is already filled in
    ...(event === "APPROVE_NODE" ? { parents: (idea.proposal?.candidates ?? []).filter((c) => c !== parent) } : {}),
    brief: ideaBriefFor({
      id, event, stage: idea.stage, summary: idea.summary, why: idea.why, declaredBy: idea.declaredBy, declaredSeq: idea.declaredSeq,
      proposal: idea.proposal, refusal, noop: pv.ok && pv.outcome === "noop", rule: guard === undefined ? undefined : hit?.table.guards[guard] ?? guard, actor: ask.actor,
    }),
    command: commandFor(IDEA, id, event, false, parent),
  };
}

// What a reason field offers: reasons already written for this event in this stream (newest
// first, among the events replay applied), then, to block, "waiting on <task>" for each other
// open task. Free text is still allowed.
export function reasonSuggestions(events: readonly StoredEvent[], stream: string, r: FoldResult, event: string, id: string): string[] {
  const skip = new Set(r.anomalies.map((a) => a.seq));
  const used: string[] = [];
  for (const e of [...events].reverse()) {
    if (e.stream !== stream || skip.has(e.seq) || e.type !== `node.${event.toLowerCase()}`) continue;
    const reason = (e.data as { payload?: { reason?: unknown } }).payload?.reason;
    if (typeof reason === "string" && reason.trim() !== "" && !used.includes(reason.trim())) used.push(reason.trim());
  }
  const waiting = event === "BLOCK" ? waitable(r, stream, id).map((x) => `waiting on ${x}`) : [];
  return [...used.slice(0, 8), ...waiting.filter((w) => !used.includes(w)).slice(0, 8)];
}

// The open tasks a task could wait on: any other open task, but not one it sits under (a
// parent waits on it, not the reverse).
export function waitable(r: FoldResult, stream: string, id: string): string[] {
  const rows = flatten(streamView(r, stream).roots);
  const above = new Set<string>();
  for (let k = rows.find((x) => x.id === id)?.key; k !== undefined; ) {
    const up = rows.find((x) => x.children.some((c) => c.key === k));
    if (up) above.add(up.id);
    k = up?.key;
  }
  return rows.filter((x) => x.id !== id && !above.has(x.id) && !CLOSED.has(x.state)).map((x) => x.id);
}

// values: what the dialog's fields held when it comes back (a value missing, a moved log)
interface ConfirmOpts { type: string; id: string; event: string; token: string; q?: string; moved?: boolean; command?: string; error?: string; notice?: string; values?: Record<string, string> }

// The decision: tira recommends (read-only) beside your action (the command, editable), then
// the button. The same body serves the confirm page and, under `tira serve`, the dialog the
// live page opens over itself (?fragment=1): there the way out closes the dialog, and the
// suggested reasons and tasks are buttons that fill the command in.
// The nutshell first: what the move is and tira's verdict on it (with what to do instead), then
// the recommendation; the tradeoffs, best practice and kind wait under "Why".
function briefHtml(p: Packet): string {
  const b = p.brief;
  const para = ([k, t]: [string, string]) => `<p><b>${k}:</b> ${esc(t)}</p>`;
  const why: [string, string][] = b ? ([["Tradeoffs", b.tradeoffs], ["Best practice", b.practice], ["Kind", b.kind]] as [string, string][]).filter(([, t]) => t !== "") : [];
  const nutshell = b && b.decision !== "" ? `<p class="nutshell" data-nutshell><b>Decision:</b> ${esc(b.decision)}</p>` : "";
  const hint = p.hint ? `<p class="hint" data-hint><b>What to do:</b> ${esc(p.hint)}</p>` : "";
  const rec = b && b.recommendation !== "" ? para(["Recommendation", b.recommendation]) : "";
  const more = why.length === 0 ? "" : `<details class="why" data-why><summary>Why: tradeoffs, best practice, kind</summary>${why.map(para).join("")}</details>`;
  return `<section class="brief" aria-label="tira recommends (read-only)" data-brief><h2>tira recommends</h2>`
    + `${nutshell}<p class="verdict ${p.ok ? "ok" : "no"}">${esc(p.verdict)}</p>${hint}${rec}${more}</section>`;
}

// why nothing was written, or what changed since it opened
function noticesHtml(opts: ConfirmOpts): string {
  const moved = opts.moved ? `<p class="flash no" role="status" data-moved>The log changed since you opened this, so nothing was written. This is what tira says now.</p>` : "";
  const notice = opts.notice ? `<p class="flash no" role="status" data-notice>${esc(opts.notice)}</p>` : "";
  const error = opts.error ? `<p class="flash no" role="alert" data-error>${esc(opts.error)} Nothing was written.</p>` : "";
  return moved + notice + error;
}

// The ticket, beside the move: what the work is (its title, description, steps, estimate and
// assignee), under tira's word when it would refuse, or when nothing would change, and what to do.
const paragraph = (x: string) => `<p>${mentionedHtml(x.trim()).replaceAll("\n", "<br>")}</p>`; // @mentions marked
const listItem = (x: string) => `<li>${mentionedHtml(x)}</li>`;
const factHtml = ([k, v]: [string, string | undefined]) => (v ? `<span><span class="lk">${k}</span>${esc(v)}</span>` : "");
// what a ticket says, as the dialog shows it (the task's own dialog: src/render/html.ts)
function ticketWordsHtml(t: Ticket | undefined): string {
  if (!t) return "";
  const facts = ([["Estimate", t.estimate], ["Assignee", t.assignee]] as [string, string | undefined][]).map(factHtml).join("");
  return [
    t.title ? `<p class="tk-title" data-ticket-title>${esc(t.title)}</p>` : "",
    t.description ? `<div class="tk-desc">${t.description.split(/\n{2,}/).map(paragraph).join("")}</div>` : "",
    t.steps.length > 0 ? `<div class="tk-steps"><span class="lk">Steps</span><ol>${t.steps.map(listItem).join("")}</ol></div>` : "",
    facts === "" ? "" : `<div class="tk-facts">${facts}</div>`,
  ].join("");
}
// tira's word, when there is one: what to do instead when it would refuse (its rule's own words when
// it has no plainer ones), that nothing would change, or the finished parents it closes first
function wordHtml(p: Packet): string {
  if (!p.ok) return p.hint ? `<p class="verdict no" data-hint title="${esc(p.verdict)}">${esc(p.hint)}</p>` : `<p class="verdict no">${esc(p.verdict)}</p>`;
  if (p.verdict.includes("nothing changes")) return `<p class="verdict ok">Nothing would change: it's already so.</p>`;
  return p.closes && p.closes.length > 0 ? `<p class="hint" data-closes>Also closes ${esc(p.closes.join(", then "))}.</p>` : "";
}
function ticketSideHtml(p: Packet): string {
  const body = ticketWordsHtml(p.ticket);
  const none = body === "" ? `<p class="tk-none">No details yet.</p>` : "";
  return `<section class="brief ticket-side" aria-label="The ticket" data-brief>${wordHtml(p)}<div class="ticket" data-ticket>${body}${none}</div></section>`;
}

// values the move can take, as buttons that fill its field live, a plain list on the confirm page
function choicesHtml(values: string[], fragment: boolean, caption: string, plainCaption: string, attrs: (v: string) => string): string {
  if (values.length === 0) return "";
  if (!fragment) return `<p class="cmd-help">${plainCaption}: ${values.map(esc).join(" · ")}</p>`;
  const buttons = values.map((v) => `<button type="button" class="fill" ${attrs(v)}>${esc(v)}</button>`).join("");
  return `<div class="fills" data-fills><span>${caption}</span>${buttons}</div>`;
}

// one field of the move: a label, an input with what it held
function fieldHtml(name: string, label: string, value: string, placeholder: string, extra = ""): string {
  return `<label class="field" data-field="${name}"><span>${label}</span><input type="text" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"${extra}></label>`;
}

// To complete: the proof of work, a commit or pull request of the project's repo, typed or pasted
// (its id or link). The page's script checks it on GitHub as it's typed (POST /proof) and says what
// it found; Complete checks it again, and keeps it for the task.
function proofFieldHtml(opts: ConfirmOpts): string {
  const check = ` data-proof-check="${esc(withQ("/proof", opts.q ?? ""))}"`;
  return fieldHtml("proofRef", "Proof of work", opts.values?.proofRef ?? "", "Commit or pull request: id or link…", check) + `<p class="proof-said" data-proof-said role="status" aria-live="polite"></p>`;
}

// To add a subtask: its name; under work already under way it's marked as found, elsewhere a chip marks it.
function subtaskFieldHtml(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  const v = opts.values ?? {};
  const proposed = p.found ? "1" : "";
  const found = v.discovered ?? proposed;
  const mark = found === "1" || !fragment ? "" : `<div class="fills" data-fills><button type="button" class="fill" data-fill-found="${esc(opts.id)}">Mark as found while working on ${esc(opts.id)}</button></div>`;
  return fieldHtml("name", "Name", v.name ?? "", "Name…", " required maxlength=\"80\"") + `<input type="hidden" name="discovered" value="${found}">` + mark;
}

// What the move needs from you: to block, what it waits on (a new ticket by name, or an open task)
// and why; to complete, the proof of work; to add a subtask, its name; a reason or a parent where
// the move takes one.
function moveFieldsHtml(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  const v = opts.values ?? {};
  const verb = PAGE_VERBS[opts.event];
  if (!p.ok || !verb) return "";
  if (opts.event === "BLOCK") {
    const open = (p.waitables ?? []).slice(0, 12);
    return fieldHtml("blocker", "Blocked by", v.blocker ?? "", "New ticket or open task…", ` data-blocked-by="${esc(opts.id)}"`)
      + choicesHtml(open, fragment, "Or an open task:", "Open tasks it could wait on", (x) => `data-fill="blocker" data-value="${esc(x)}"`)
      + fieldHtml("reason", "Reason", v.reason ?? "", "Optional…");
  }
  if (opts.event === "COMPLETE") return proofFieldHtml(opts);
  if (verb.creates) return subtaskFieldHtml(p, opts, fragment);
  if (!verb.field) return "";
  const proposed = /parent_id="((?:[^"\\]|\\.)*)"/.exec(p.command ?? "")?.[1] ?? ""; // tira's proposal for an idea's parent
  const label = verb.field.name === "parent_id" ? "Goes under" : "Reason";
  return fieldHtml(verb.field.name, label, v[verb.field.name] ?? (verb.field.name === "parent_id" ? proposed : ""), verb.field.name === "parent_id" ? "Parent task…" : "Why…")
    + choicesHtml(p.suggestions, fragment, "Used before:", "Reasons used before", (x) => `data-fill="reason" data-value="${esc(x)}"`)
    + choicesHtml(p.parents ?? [], fragment, "Put it under:", "Tasks tira found for it", (x) => `data-fill="parent_id" data-value="${esc(x)}"`);
}

function packetBody(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  const verb = PAGE_VERBS[opts.event];
  const leave = (label: string) => (fragment ? `<button class="how" type="button" data-close-confirm>${label}</button>` : `<a class="how" href="${esc(withQ("/", opts.q ?? ""))}">${label}</a>`);
  const close = leave(fragment ? "Close" : "Back to the page");
  const head = `<div class="packet" data-packet data-ok="${p.ok && verb !== undefined}"><h1>${esc(p.title)}</h1>${noticesHtml(opts)}`;
  const left = opts.type === IDEA ? briefHtml(p) : ticketSideHtml(p);
  // no such verb or task: nothing to fill in
  if (!verb || p.brief === undefined) return `${head}<div class="split">${left}</div><div class="run">${close}</div></div>`;
  const hidden = [["token", opts.token], ["type", opts.type], ["id", opts.id], ["event", opts.event], ["seen", String(p.seen)], ["dialog", "1"]]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v as string)}">`).join("");
  const comment = opts.type === IDEA || !p.ok ? "" : `<label class="field comment-field" data-comment-field><span>Comment</span><textarea name="comment" rows="2" maxlength="2000" placeholder="Add a comment…">${esc(opts.values?.comment ?? "")}</textarea></label>`;
  const fields = moveFieldsHtml(p, opts, fragment) + comment;
  const right = fields === "" ? "" : `<section class="your-part" aria-label="Your part" data-you-part>${fields}</section>`;
  const button = p.ok ? `<button class="act primary" type="submit">${esc(verb.label)}</button> ${leave("Not now")}` : `<button class="act" type="submit">Check again</button> ${close}`;
  return `${head}<form method="post" action="${esc(withQ("/act", opts.q ?? ""))}" class="you-decide" aria-label="Your decision" data-you>${hidden}<div class="split">${left}${right}</div>`
    + `<div class="run">${button}</div></form></div>`;
}

// A decision as a page of its own (the confirm page, and Connect Jira), for a browser without the dialog.
function standalone(title: string, body: string, q = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · ${esc(title)}</title><style>${CSS}</style></head><body>${THEME_RADIOS}<main class="packet-page"><nav class="top">${brand(withQ("/", q))}</nav><a class="how" href="${esc(withQ("/", q))}">← the page</a>`
    + body + `</main><script type="module" src="/theme.mjs"></script></body></html>\n`;
}

const confirmPage = (p: Packet, opts: ConfirmOpts): string => standalone(p.title, packetBody(p, opts, false), opts.q ?? "");

// a project the store doesn't hold yet: say so, how to start it (connect its repo, which needs
// GitHub sign-in: Project settings), and the way home
function noWorkspace(stream: string): string {
  const q = `w=${encodeURIComponent(stream)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · no project</title><style>${CSS}</style></head><body>${THEME_RADIOS}<main class="packet-page"><nav class="top">${brand("/")}</nav>`
    + `<div class="packet" data-no-workspace><h1>No project named ${esc(stream)} yet</h1>`
    + `<p class="hint">A project starts when it's connected to its GitHub repo (and, if you use one, its Jira board), which needs GitHub sign-in. <a class="how" href="${esc(withQ("/integrations", q))}" data-start-project>Project settings for ${esc(stream)}</a></p>`
    + `<p class="hint"><a class="how" href="/">Back to your board</a></p></div></main><script type="module" src="/theme.mjs"></script></body></html>\n`;
}

// a project someone deleted: its board is closed (its history stays in the log), and the way home
function deletedProject(stream: string, by: string | undefined): string {
  const who = by ? esc(by) + " deleted it. " : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · deleted project</title><style>${CSS}</style></head><body>${THEME_RADIOS}<main class="packet-page"><nav class="top">${brand("/")}</nav>`
    + `<div class="packet" data-deleted-project><h1>${esc(stream)} was deleted</h1>`
    + `<p class="hint">${who}Its board is closed; its history stays in tira's log.</p>`
    + `<p class="hint"><a class="how" href="/">Back to your board</a></p></div></main><script type="module" src="/theme.mjs"></script></body></html>\n`;
}

// The Integrations pages (integrations.ts, welcome.ts) were written for one project per server:
// their links, forms and redirects name a path alone. Served for another project, each same-site
// path they send gets the project's query too, so a connect, a link or a sync stays in it.
export function carryQ(html: string, q: string): string {
  if (q === "") return html;
  return html.replace(/\b(href|action|data-go)="(\/(?!\/)[^"#]*)"/g, (m, attr: string, path: string) =>
    /[?&;]w=/.test(path) ? m : `${attr}="${path}${esc(joiner(path))}${esc(q)}"`);
}

// A write's result in the page's words (and tira mcp's).
export const flashFor = (event: string, id: string, r: WriteResult): { ok: boolean; text: string } => {
  const label = PAGE_VERBS[event]?.label ?? event;
  if (r.status === "appended") {
    const closes = (r.closedByTira ?? []).map((c) => bareKey(c.key));
    const nothing = r.outcome === "noop" ? ", nothing changed" : "";
    const closed = closes.length > 0 ? " tira closed " + closes.join(", ") + ", citing it." : "";
    return { ok: true, text: `${label} ${id}: done (seq ${r.seq})${nothing}.${closed}` };
  }
  if (r.status === "rejected") return { ok: false, text: `${label} ${id}: refused (${r.code}: ${r.detail}). The refusal is in the log (seq ${r.seq}).` };
  if (r.status === "refused") return { ok: false, text: `${label} ${id}: refused (${r.code}: ${r.detail}). Nothing was written.` };
  return { ok: true, text: `${label} ${id}: ${r.status} (seq ${r.seq}).` };
};

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Over the cap: stop keeping it, drain the rest, and answer 413 (destroying the socket
// would leave the client with a reset instead of an answer).
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => { if (size > MAX_BODY) reject(new Error("body too large")); });
    req.on("end", () => { if (size <= MAX_BODY) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// Why a block can't wait on an existing task: it must be an open task of the stream, and not
// one the blocked task sits under (a task can't wait on what it is part of).
export function blockerProblem(r: FoldResult, stream: string, a: Pick<PageAction, "type" | "id">, blocker: string): string | undefined {
  const rows = flatten(streamView(r, stream).roots);
  const target = rows.find((x) => x.type === a.type && x.id === blocker);
  if (!target) return `there is no task ${blocker} to wait on. To make it a new ticket, create it on the line above: tira create ${a.type} ${blocker} --parent ${a.id}`;
  if (CLOSED.has(target.state)) return `${blocker} is already ${spaced(target.state)}: there's nothing to wait on`;
  for (let k: string | undefined = entityKey({ type: a.type, id: a.id }); k !== undefined;) {
    const up = rows.find((x) => x.children.some((c) => c.key === k));
    if (up?.key === target.key) return `${a.id} sits under ${blocker}: a task can't wait on what it is part of`;
    k = up?.key;
  }
  return undefined;
}

// Writes run in order, each only if the one before it was written: a block's new ticket
// first, since the block names it. The result says what each did, up to the one that stopped.
export async function inOrder(steps: (() => Promise<{ ok: boolean; text: string }>)[]): Promise<{ ok: boolean; text: string }> {
  const said: string[] = [];
  for (const step of steps) {
    const done = await step();
    said.push(done.text);
    if (!done.ok) return { ok: false, text: said.join(" ") };
  }
  return { ok: true, text: said.join(" ") };
}

// What a written action changed, so the page can make it glow once: the task it moved (or the
// subtask it added), and a block's new ticket.
export const changedBy = (a: PageAction, ticket?: PageAction): string[] =>
  [a, ...(ticket === undefined ? [] : [ticket])].map((x) => entityKey({ type: x.type, id: x.child ?? x.id }));

const commandOf = (a: PageAction, stream: string, actor: string): Command => {
  // the actor is who's signed in (or the server's, without sign-in): a posted "actor" field is ignored
  const base = { stream, actor, payload: a.payload };
  return a.child === undefined
    ? { ...base, kind: "event", entity: { type: a.type, id: a.id }, event: a.event }
    : { ...base, kind: "create", entity: { type: a.type, id: a.child } };
};

// What posted fields ask for (without a command: a script or a test), or undefined when the
// page may not send it: one of the page's verbs, on a task of a tree type, with the verb's
// field when it has one. Add subtask is a birth under the task: a well-formed name, and
// "discovered" marks it as found during it.
function actionFrom(form: URLSearchParams, registry: Registry): PageAction | undefined {
  const type = form.get("type") ?? "";
  const id = form.get("id") ?? "";
  const event = form.get("event") ?? "";
  const verb = PAGE_VERBS[event];
  if (!verb || !verbFits(verb, type, (t) => registry.get(t)?.tree !== undefined) || id === "") return undefined;
  if (verb.creates) {
    const child = subtaskName(form.get("name"));
    if (child === undefined) return undefined;
    const found = form.get("discovered") === "1" ? { kind: "discovered", discovered_during: id } : {};
    return { type, id, event, child, payload: { parent_id: id, ...found } };
  }
  const payload: Record<string, unknown> = {};
  const value = verb.field ? form.get(verb.field.name) : null;
  if (verb.field && value !== null) payload[verb.field.name] = value;
  return { type, id, event, payload };
}

// A decision's own form (the dialog, the confirm page): the move from its fields, never a command.
// To block: what it waits on, an open task, else a new ticket made under the task (found while
// working on it) first; the reason written, else it waits on that ticket.
function fromDialog(form: URLSearchParams, registry: Registry, r: FoldResult, stream: string): { ask: PageAction; ticket?: PageAction } | { why: string } | undefined {
  const type = form.get("type") ?? "";
  const id = form.get("id") ?? "";
  const event = form.get("event") ?? "";
  const verb = PAGE_VERBS[event];
  if (!verb || id === "" || !verbFits(verb, type, (t) => registry.get(t)?.tree !== undefined)) return undefined;
  if (verb.creates) {
    const child = subtaskName(form.get("name"));
    if (child === undefined) return { why: "Name the new subtask: 1 to 80 characters." };
    const found = form.get("discovered") !== "1" ? {} : { kind: "discovered", discovered_during: id };
    return { ask: { type, id, event, child, payload: { parent_id: id, ...found } } };
  }
  if (event === "BLOCK") return blockFromDialog(form, type, id, r, stream);
  const pasted = event === "COMPLETE" ? (form.get("proofRef") ?? "").trim() : ""; // a proof typed in, over one picked
  const value = pasted || (verb.field ? form.get(verb.field.name) : null);
  return { ask: { type, id, event, payload: verb.field && value !== null ? { [verb.field.name]: value } : {} } };
}
// to block: on an open task, or on a new ticket by name (made under the task first)
function blockFromDialog(form: URLSearchParams, type: string, id: string, r: FoldResult, stream: string): { ask: PageAction; ticket?: PageAction } | { why: string } {
  const blocker = (form.get("blocker") ?? "").trim();
  const reason = (form.get("reason") ?? "").trim();
  const ask: PageAction = { type, id, event: "BLOCK", payload: { ...(blocker ? { blocker } : {}), ...(reason ? { reason } : {}) } };
  if (blocker === "" || r.entities.some((e) => e.stream === stream && e.type === type && e.id === blocker)) return { ask };
  const child = subtaskName(blocker);
  if (child === undefined) return { why: "Name what it waits on: a new ticket (1 to 80 characters), or an open task." };
  return { ask, ticket: { type, id, event: "ADD_SUBTASK", child, payload: { parent_id: id, kind: "discovered", discovered_during: id } } };
}

// what a decision's fields held, to show them again when it comes back
const DIALOG_FIELDS = ["blocker", "reason", "evidenceRef", "proofRef", "name", "discovered", "parent_id", "comment"];
const valuesOf = (form: URLSearchParams) => Object.fromEntries(DIALOG_FIELDS.flatMap((k) => (form.get(k) === null ? [] : [[k, form.get(k) as string]])));

export function tiraServer(opts: ServeOptions): Server & { token: string } {
  if (opts.actor !== undefined && isReservedActor(opts.actor)) throw new Error(`"${opts.actor}" is reserved for tira's, the dispatcher's and the sync's own writes: serve as a person`);
  const token = opts.token ?? randomBytes(24).toString("hex");
  const dispatcher = new Dispatcher(opts.store, opts.registry);
  // what a drag between the Kanban's columns means: today's rules, so the same for every page
  const moves = dragMoves(opts.registry);
  // Who this request acts as: the GitHub login signed in, once GitHub sign-in is set up (no one,
  // until they sign in); else the name tira serve was started with.
  const linkEnv = opts.links?.env ?? process.env;
  // People's accounts: in Postgres when tira's data is (credentials.ts), so with no $TIRA_SECRET_KEY
  // to seal them tira serve doesn't start. Each request reads them again first, so one person's
  // change shows on everyone's next page; this computer's old file is brought over once.
  postgresAccounts(linkEnv);
  let brought: Promise<void> | undefined;
  const accountsNow = async () => {
    brought ??= importAccountsFile(linkEnv).then((added) => {
      const said = added && [added.apps ? "tira's apps" : "", added.access ? "who may sign in" : "", added.github ? `${added.github} GitHub link(s)` : "", added.atlassian ? `${added.atlassian} Jira link(s)` : "", added.names ? `${added.names} display name(s)` : "", added.sessions ? `${added.sessions} session(s)` : ""].filter(Boolean);
      if (said && said.length > 0) process.stderr.write(`tira: brought this computer's accounts into Postgres: ${said.join(", ")}. The old file keeps a copy; tira reads only Postgres now.\n`);
    }).catch((err: unknown) => {
      brought = undefined; // try again on the next request
      throw err;
    });
    await brought;
    await refreshAccounts(linkEnv);
  };
  const who = (req: IncomingMessage) => whoIs(req, opts.actor, linkEnv, (id) => sessionLogin(id, linkEnv));
  const current = new AsyncLocalStorage<ReturnType<typeof who> & { ws?: Workspace }>();
  const actorNow = () => current.getStore()?.actor;
  const previews = new WritePath(opts.store, opts.registry);
  const flashes = new Map<string, { ok: boolean; text: string; changed?: string[] }>();
  const flashKey = () => String(randomInt(1, 2 ** 47)); // unguessable: one person's result isn't another's to read
  const now = async (stream: string) => {
    const events = await opts.store.readStream(stream);
    const r = fold(events, opts.registry);
    return { events, r, hash: fingerprint(r) };
  };
  // a project's people (src/serve/team.ts): as saved, else whoever made it and the people from before
  const peopleNow = async (stream: string) => {
    const [first] = await opts.store.readStream(stream, { limit: 1 });
    return projectPeople(stream, first?.metadata.actor, linkEnv);
  };
  // every live project, by name as people see it (the switcher's list; home: the one tira opened on,
  // even before anything is in it), and the ones someone is in
  const projectsNow = async (current: string, home = true) => {
    const all = await opts.store.readAll();
    const list = workspaceList(fold(all, opts.registry), [...(home ? [opts.stream] : []), ...all.map((e) => e.stream)], opts.stream, current);
    return { list, by: makers(all) };
  };
  const projectsOf = async (login: string, current = opts.stream, home = true): Promise<(MyProject & { entry: ReturnType<typeof workspaceList>[number] })[]> => {
    const { list, by } = await projectsNow(current, home);
    return list.flatMap((w) => {
      const p = projectPeople(w.stream, by.get(w.stream), linkEnv);
      return inProject(p, login) ? [{ stream: w.stream, ...(w.title ? { title: w.title } : {}), href: w.href, admin: isProjectAdmin(p, login), tasks: w.tasks, open: w.open, entry: w }] : [];
    });
  };
  // at a public address: browsers keep to https, and cookies go over https only
  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    const cookie = extra["Set-Cookie"];
    const secure = opts.site ? { "Strict-Transport-Security": "max-age=31536000", ...(cookie ? { "Set-Cookie": `${cookie}; Secure` } : {}) } : {};
    res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra, ...secure });
    res.end(body);
  };
  const text = "text/plain; charset=utf-8";
  const html = "text/html; charset=utf-8";

  // GET /: the page, live, with the last action's result once. No one who can act yet: the
  // landing (sign in). Signed in with GitHub, but the project has no repo: connect one first. A
  // project the store doesn't hold (and no one to connect it): a 404; one someone deleted: closed.
  const page = async (req: IncomingMessage, res: ServerResponse, url: URL, _host: string, ws: Workspace) => {
    const { events, r, hash } = await now(ws.stream);
    const me = who(req);
    if (!me.actor) return send(res, 303, text, "", { Location: `/welcome${url.search}` }); // a result goes along
    const link = workspaceOf(r, ws.stream);
    if (link?.deleted) return send(res, 410, html, deletedProject(link.title ?? ws.stream, link.by));
    if (me.login && !link?.repo) return send(res, 303, text, "", { Location: `/connect${url.search}` });
    if (events.length === 0 && ws.q !== "") return send(res, 404, html, noWorkspace(ws.stream));
    const rk = url.searchParams.get("r") ?? "";
    const flash = flashes.get(rk);
    flashes.delete(rk); // a result shows once
    const divergence = opts.divergence?.(events);
    const name = me.actor ? displayName(me.actor, linkEnv) : undefined; // as they chose to be shown
    const { people, agents } = await assignees(ws.stream, me.actor);
    const live = { ...(flash ? { flash } : {}), ...(ws.q === "" ? {} : { query: ws.q }), ...(me.actor ? { actor: me.actor } : {}), ...(me.login ? { user: me.login } : {}), ...(name ? { name } : {}), token, moves, people, agents };
    send(res, 200, html, renderHtml(r, ws.stream, hash, events, { live, ...(divergence !== undefined ? { divergence } : {}) }));
  };

  // GET /api/live: where the project's log is now (its last seq), asked every few seconds by the
  // page so it follows the log by itself (app.mjs). The one event at the end only: cheap to ask.
  // what only someone signed in may read: the projects, their tasks, how far each log has got
  const signedOut = (res: ServerResponse) => actorNow() === undefined && (send(res, 401, text, "sign in first\n"), true);
  const liveSeq = async (_req: IncomingMessage, res: ServerResponse, _url: URL, _host: string, ws: Workspace) => {
    if (signedOut(res)) return;
    const [last] = await opts.store.readStream(ws.stream, { direction: "backwards", limit: 1 });
    send(res, 200, "application/json; charset=utf-8", JSON.stringify({ seq: last?.seq ?? 0 }));
  };

  // GET /api/tasks: the palette's index
  const tasks = async (_req: IncomingMessage, res: ServerResponse, _url: URL, _host: string, ws: Workspace) => {
    if (signedOut(res)) return;
    const { r } = await now(ws.stream);
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(taskIndex(r, ws.stream)));
  };

  // GET /api/workspaces: the switcher's list, read when it opens (every stream, folded once): the
  // projects you're in, once people sign in
  const workspaces = async (req: IncomingMessage, res: ServerResponse, _url: URL, _host: string, ws: Workspace) => {
    if (signedOut(res)) return;
    const login = who(req).login;
    if (login) return send(res, 200, "application/json; charset=utf-8", JSON.stringify((await projectsOf(login, ws.stream, false)).map((p) => p.entry)));
    const all = await opts.store.readAll();
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(workspaceList(fold(all, opts.registry), all.map((e) => e.stream), opts.stream, ws.stream)));
  };

  // A decision, shown (or shown again: a value missing, a different action, the log moved).
  // Nothing is written on the way.
  const decide = async (res: ServerResponse, ws: Workspace, at: { type: string; id: string; event: string }, o: Partial<ConfirmOpts>, fragment: boolean, status?: number) => {
    const { events, r } = await now(ws.stream);
    const actor = actorNow();
    const p = actor === undefined
      ? { ok: false, title: `${PAGE_VERBS[at.event]?.label ?? at.event} ${at.id}?`, verdict: "Sign in with GitHub first (Integrations), so tira knows who makes this change.", seen: r.lastSeq, suggestions: [] }
      : await packetFor({ wp: previews, r, events, registry: opts.registry, stream: ws.stream, actor, ...at });
    const co: ConfirmOpts = { ...at, token, q: ws.q, ...o };
    send(res, status ?? (p.ok ? 200 : 409), html, fragment ? packetBody(p, co, true) : confirmPage(p, co));
  };

  // GET /confirm: the decision; ?fragment=1 is just the packet, for the dialog the live page
  // opens over itself
  const confirm = async (_req: IncomingMessage, res: ServerResponse, url: URL, _host: string, ws: Workspace) => {
    const at = { type: url.searchParams.get("type") ?? "node", id: url.searchParams.get("id") ?? "", event: url.searchParams.get("event") ?? "" };
    await decide(res, ws, at, { moved: url.searchParams.get("moved") === "1" }, url.searchParams.get("fragment") === "1");
  };

  // POST /proof: the Complete dialog's check of a proof as it's typed: what tira found on GitHub, or
  // why it can't be one ({ok, text}). Nothing is written: Complete checks it again, and keeps it.
  const proofPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    if (actorNow() === undefined) return send(res, 401, "application/json; charset=utf-8", JSON.stringify({ ok: false, text: "Sign in with GitHub first." }));
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(await proofSaid(opts.store, opts.registry, ws.stream, acc.githubOf(who(req).login), form.get("proofRef") ?? "")));
  };

  // POST /act, in stages: the form (from this page only), what it asks for, what stops it
  // before anything is written, then the write and back to the page with its result. The
  // dialog's own posts (fragment=1) get the decision back to show in place, or where to go next.
  interface Target { type: string; id: string; event: string }
  // dialog: from a decision's own fields (shown again with what's wrong, as a typed command is)
  // login: who's signed in with GitHub (a proof named by its id is looked up as them)
  interface Asked { ws: Workspace; fragment: boolean; typed: string | null; seen: string | null; ask: PageAction; ticket: PageAction | undefined; target: Target; dialog?: boolean; values?: Record<string, string>; login?: string }
  const shown = (a: Asked) => a.typed !== null || a.dialog === true;
  const targetOf = (a: PageAction): Target => ({ type: a.type, id: a.id, event: a.event });

  // the same origin, within the size cap, with this process's token
  const formOf = async (req: IncomingMessage, res: ServerResponse, host: string): Promise<URLSearchParams | undefined> => {
    const origin = req.headers.origin;
    const own = host === opts.site?.host ? opts.site.origin : `http://${host}`;
    if (origin !== undefined && origin !== own) { send(res, 403, text, "cross-origin writes are refused\n"); return undefined; }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      send(res, 413, text, "too large\n");
      return undefined;
    }
    if (!safeEqual(form.get("token") ?? "", token)) { send(res, 403, text, "This page is out of date, or isn't tira's own: nothing was saved. Go back, reload the page, and try again.\n"); return undefined; }
    return form;
  };

  // from a decision's own fields (the dialog): what it asks for, else the dialog again with what's wrong
  const dialogAsked = async (res: ServerResponse, form: URLSearchParams, ws: Workspace, fragment: boolean, seen: string | null): Promise<Asked | undefined> => {
    const opened = { type: form.get("type") ?? "", id: form.get("id") ?? "", event: form.get("event") ?? "" };
    const values = valuesOf(form);
    const got = fromDialog(form, opts.registry, (await now(ws.stream)).r, ws.stream);
    if (!got) { send(res, 400, text, "the page can only start, unblock, complete, block, cancel or reopen a task, add a subtask with a name, or approve or reject an idea\n"); return undefined; }
    const long = (values.comment ?? "").trim().length > MAX_COMMENT ? `Keep the comment to ${MAX_COMMENT} characters.` : undefined;
    const why = "why" in got ? got.why : long;
    if (why !== undefined || "why" in got) { await decide(res, ws, opened, { error: why ?? "", values }, fragment, 422); return undefined; }
    return { ws, fragment, typed: null, seen, ask: withDefaults(got.ask), ticket: got.ticket, target: targetOf(got.ask), dialog: true, values };
  };
  // what it asks for: the command as you left it, read strictly; without one, the posted fields
  const askedOf = async (res: ServerResponse, form: URLSearchParams, ws: Workspace): Promise<Asked | undefined> => {
    const fragment = form.get("fragment") === "1";
    const seen = form.get("seen");
    const typed = form.get("command");
    if (form.get("dialog") === "1") return dialogAsked(res, form, ws, fragment, seen);
    if (typed === null) {
      const ask = actionFrom(form, opts.registry);
      if (!ask) { send(res, 400, text, "the page can only start, unblock, complete, block, cancel or reopen a task, add a subtask with a name, or approve or reject an idea\n"); return undefined; }
      return { ws, fragment, typed, seen, ask, ticket: undefined, target: targetOf(ask) };
    }
    const opened = { type: form.get("type") ?? "", id: form.get("id") ?? "", event: form.get("event") ?? "" };
    const parsed = parseCommand(typed, (t) => opts.registry.get(t)?.tree !== undefined);
    if (!parsed.ok) { await decide(res, ws, opened, { command: typed, error: `tira can't run that: ${parsed.why}.` }, fragment, 422); return undefined; }
    const target = targetOf(parsed.action);
    // edited into another action (another task or verb): what tira says about that one first
    if (target.type !== opened.type || target.id !== opened.id || target.event !== opened.event) {
      await decide(res, ws, target, { command: typed, notice: "That's a different action from the one you opened, so here is what tira says about it first. Nothing was written." }, fragment);
      return undefined;
    }
    return { ws, fragment, typed, seen, ask: withDefaults(parsed.action), ticket: parsed.ticket, target };
  };

  // what stops it before anything is written (true: it answered): a value missing, a blocker
  // that can't be, a moved log, or, for a typed command, tira's refusal of the ticket or the move
  const heldBack = async (res: ServerResponse, a: Asked, cmd: Command, first: Command | undefined): Promise<boolean> => {
    const back = async (o: Partial<ConfirmOpts>, status?: number) => { await decide(res, a.ws, a.target, { command: a.typed ?? "", ...(a.values ? { values: a.values } : {}), ...o }, a.fragment, status); return true; };
    const lacking = missing(a.ask);
    if (lacking !== undefined && !shown(a)) { send(res, 400, text, `${lacking}\n`); return true; }
    if (lacking !== undefined) return back({ error: lacking }, 422);
    const problem = await waitProblem(a);
    if (problem) return back({ error: `tira can't run that: ${problem}.` }, 422);
    if (await proofHeldBack(res, a, back)) return true;
    const misplaced = await placeCheck(a);
    if (misplaced && !shown(a)) { send(res, 409, text, `tira can't run that: ${misplaced}\n`); return true; }
    if (misplaced) return back({ error: `tira can't run that: ${misplaced}.` }, 422);
    // decided on one log, written on another? show the decision again instead
    // (a post without `seen` didn't come from a decision: it gets one first)
    if (a.seen !== String((await now(a.ws.stream)).r.lastSeq)) {
      if (shown(a)) return back({ moved: a.seen !== null }, 409);
      const again = withQ(`/confirm?type=${encodeURIComponent(a.ask.type)}&id=${encodeURIComponent(a.ask.id)}&event=${encodeURIComponent(a.ask.event)}`, a.ws.q);
      send(res, 303, text, "", { Location: a.seen === null ? again : again + "&moved=1" });
      return true;
    }
    if (!shown(a)) return false;
    const refused = await refusal(a, cmd, first);
    if (refused) return back({ error: refused }, 409);
    return false;
  };

  // a Complete's proof of work that can't be: said, or the dialog again with why; keeping it for the
  // task moves the log, which doesn't count as the log moving under the decision
  const proofHeldBack = async (res: ServerResponse, a: Asked, back: (o: Partial<ConfirmOpts>, status?: number) => Promise<boolean>): Promise<boolean> => {
    const atStart = String((await now(a.ws.stream)).r.lastSeq);
    const proof = await commitProblem(a);
    if (proof.why && !shown(a)) { send(res, 409, text, `${proof.why}\n`); return true; }
    if (proof.why) return back({ error: proof.why }, 422);
    if (proof.kept && a.seen === atStart) a.seen = String((await now(a.ws.stream)).r.lastSeq); // its own keeping moved the log
    return false;
  };

  // Completing a task from the page: its proof of work is a commit or a pull request of the project's
  // repo: one kept for it already, or one named now, checked on GitHub and kept for it (its whole id
  // or link is what's written). Why not, if it can't be; whether keeping it wrote to the log.
  const commitProblem = async (a: Asked): Promise<{ why?: string; kept: boolean }> => {
    if (a.ask.event !== "COMPLETE" || opts.registry.get(a.ask.type)?.tree === undefined) return { kept: false };
    const ref = typeof a.ask.payload.evidenceRef === "string" ? a.ask.payload.evidenceRef.trim() : "";
    const { r } = await now(a.ws.stream);
    const commits = commitsOf(r, a.ws.stream).get(a.ask.id) ?? [];
    const prs = linksOf(r, a.ws.stream).get(a.ask.id)?.prs ?? [];
    if (commits.some((c) => c.sha === ref) || prs.some((p) => p.url === ref)) return { kept: false };
    const got = await proveWith(opts.store, opts.registry, a.ws.stream, a.ask.id, acc.githubOf(a.login), ref).catch((err: unknown) => ({ why: `Couldn't reach GitHub (${(err as Error).message}).` }));
    if ("why" in got) return { why: got.why, kept: false };
    a.ask.payload.evidenceRef = got.ref;
    return { kept: true };
  };

  // a typed block on an open task: why it can't wait on that task, if it can't
  const waitProblem = async (a: Asked): Promise<string | undefined> => {
    const blocker = blockerOf(a.ask);
    if (!shown(a) || blocker === undefined || a.ticket !== undefined) return undefined;
    return blockerProblem((await now(a.ws.stream)).r, a.ws.stream, a.ask, blocker);
  };

  // approving an idea's placement: the task it becomes must fit under the parent named (the idea's
  // own stage is the rules' to judge)
  const placeCheck = async (a: Asked): Promise<string | undefined> => {
    const parent = a.ask.payload.parent_id;
    if (a.ask.type !== IDEA || a.ask.event !== "APPROVE_NODE" || typeof parent !== "string" || parent.trim() === "") return undefined;
    return placeProblem(viewOf((await now(a.ws.stream)).r, a.ws.stream), opts.registry, a.ask.id, parent.trim());
  };

  // a typed command tira would refuse goes back into the dialog, not into the log; a new
  // ticket and its block are both checked before either is written. An idea's stage skip says
  // so in plain words.
  const refusal = async (a: Asked, cmd: Command, first: Command | undefined): Promise<string | undefined> => {
    for (const c of first === undefined ? [cmd] : [first, cmd]) {
      const pv = await previews.preview(c);
      const what = c === first ? "the new ticket " + (a.ticket?.child ?? "") : "this";
      if (pv.ok) continue;
      const idea = a.ask.type === IDEA ? await ideaNow(a.ws.stream, a.ask.id) : undefined;
      if (idea) return `tira would still refuse ${what}: ${ideaRefusal(idea.stage, a.ask.event, idea.id, idea.summary !== undefined).why} (${pv.code}: ${pv.detail}).`;
      return `tira would still refuse ${what}: ${pv.code}: ${pv.detail}.`;
    }
    return undefined;
  };
  const ideaNow = async (stream: string, id: string): Promise<IdeaRow | undefined> => {
    const { events, r } = await now(stream);
    return ideaRows(r, events, stream).find((i) => i.id === id);
  };

  // after an idea's approval: what tira did next, in a sentence
  const ideaAfter = async (stream: string, id: string): Promise<string> => {
    const i = await ideaNow(stream, id);
    const p = i?.proposal;
    if (i?.stage === "node_pending" && p?.parent !== undefined) return `tira proposes it under ${p.parent} (${p.basis}): approve the placement next.`;
    if (i?.stage === "node_pending") return `tira couldn't settle where it goes (${p?.basis.replace(/^needs you: /, "") ?? "no proposal"}): pick its parent when you approve the placement.`;
    if (i?.stage === "materialized") {
      const { r } = await now(stream);
      const born = viewOf(r, stream).get({ type: "node", id });
      return born ? `It's a task now: ${id}, under ${i.placedUnder ?? "its parent"}.` : "The task isn't born yet: see the handoffs waiting in Lanes.";
    }
    if (i?.stage === "dropped") return "It's dropped; your reason stays in its history.";
    return "";
  };

  const label = (a: PageAction) => (a.child === undefined ? a.id : a.child + " under " + a.id);
  const write = async (a: PageAction, c: Command) => {
    try {
      const flash = flashFor(a.event, label(a), (await dispatcher.submit(c)).result);
      return a.type === IDEA && flash.ok ? { ok: true, text: `${flash.text} ${await ideaAfter(c.stream, a.id)}`.trim() } : flash;
    } catch (err) {
      return { ok: false, text: `${PAGE_VERBS[a.event]?.label ?? a.event} ${label(a)}: not sent (${(err as Error).message}).` };
    }
  };

  // Who a ticket can be assigned to: the project's people (its admins and members, and whoever is
  // acting) and its connected agents (Project settings → Connect agents).
  const assignees = async (stream: string, actor: string | undefined): Promise<{ people: string[]; agents: string[] }> => {
    const people = [...new Set([...everyone(await peopleNow(stream)), actor].filter((x): x is string => typeof x === "string" && x !== ""))];
    const tokens = opts.links?.agentTokens ?? agentTokensFor(linkEnv);
    const agents = tokens ? (await tokens.list(stream)).map((x) => x.agent) : [];
    return { people, agents };
  };
  // a ticket's own forms come back to its dialog (#t<i>), with what happened
  const toTicket = (res: ServerResponse, ws: Workspace, form: URLSearchParams, f: { ok: boolean; text: string }, task?: string) => {
    const key = flashKey();
    flashes.set(key, task && f.ok ? { ...f, changed: [entityKey({ type: "node", id: task })] } : f);
    if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
    const back = /^#t\d+$/.test(form.get("back") ?? "") ? form.get("back") ?? "" : "";
    send(res, 303, text, "", { Location: withQ(`/?r=${key}`, ws.q) + back });
  };
  // the task a ticket form is about, if it's one in this project
  const taskIn = async (ws: Workspace, id: string) => {
    const { r } = await now(ws.stream);
    return r.entities.some((e) => e.stream === ws.stream && e.type === "node" && e.id === id) ? r : undefined;
  };
  // a ticket's Edit form, read: each field trimmed, the steps one per line
  type TicketAsked = TicketWords & { assignee: string };
  const ticketAsked = (form: URLSearchParams): TicketAsked => ({
    title: (form.get("title") ?? "").trim().replaceAll(/\s+/g, " "),
    description: (form.get("description") ?? "").replaceAll("\r\n", "\n").trim(),
    steps: (form.get("steps") ?? "").replaceAll("\r\n", "\n").split("\n").map((x) => x.trim()).filter((x) => x !== ""),
    estimate: (form.get("estimate") ?? "").trim(),
    assignee: (form.get("assignee") ?? "").trim(),
  });
  // what a ticket can't say, if anything: `allowed`, who it can be assigned to
  const assigneeProblem = (assignee: string, allowed: (string | undefined)[]) =>
    assignee !== "" && (!ASSIGNEE.test(assignee) || !allowed.includes(assignee)) ? `${assignee} isn't on this project's team or one of its agents.` : undefined;
  const ticketProblem = (asked: TicketAsked, allowed: (string | undefined)[]): string | undefined => ticketWordsProblem(asked) ?? assigneeProblem(asked.assignee, allowed);

  // POST /tickets: a ticket's Edit form (its title, description, steps, estimate and assignee), the
  // whole ticket as a new version, written as the person saving it.
  const saveTicket = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const said = (f: { ok: boolean; text: string }, task?: string) => toTicket(res, ws, form, f, task);
    const actor = actorNow();
    if (actor === undefined) return said({ ok: false, text: "Sign in with GitHub first, so tira knows who writes the ticket." });
    const task = form.get("task") ?? "";
    const r = await taskIn(ws, task);
    if (!r) return said({ ok: false, text: `There is no task ${task}.` });
    const asked = ticketAsked(form);
    const before = ticketsOf(r, ws.stream).get(task);
    const { people, agents } = await assignees(ws.stream, actor);
    const why = ticketProblem(asked, [...people, ...agents, before?.assignee]);
    if (why) return said({ ok: false, text: `The ticket wasn't saved: ${why}` });
    const payload = ticketPayload(task, asked, asked.assignee);
    if (saysSame(before, payload)) return said({ ok: true, text: "Nothing changed." });
    const w = (await dispatcher.submit({ stream: ws.stream, kind: "create", entity: { type: TICKET, id: task, version: (before?.version ?? 0) + 1 }, actor, payload })).result;
    if (w.status !== "appended") return said({ ok: false, text: `The ticket wasn't saved (${w.status === "rejected" || w.status === "refused" ? w.detail : w.status}).` });
    said({ ok: true, text: "Saved." }, task);
  };

  // POST /comments: a comment on a ticket (feedback its agent reads), written as the person commenting.
  const addComment = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const said = (f: { ok: boolean; text: string }, task?: string) => toTicket(res, ws, form, f, task);
    const actor = actorNow();
    if (actor === undefined) return said({ ok: false, text: "Sign in with GitHub first, so tira knows who comments." });
    const task = form.get("task") ?? "";
    if (!(await taskIn(ws, task))) return said({ ok: false, text: `There is no task ${task}.` });
    const words = (form.get("text") ?? "").replaceAll("\r\n", "\n").trim();
    if (words === "" || words.length > MAX_COMMENT || !NO_CONTROL.test(words)) return said({ ok: false, text: `A comment is 1 to ${MAX_COMMENT} characters.` });
    const w = await writeComment(ws.stream, task, words, actor);
    if (w !== undefined) return said({ ok: false, text: `The comment wasn't added (${w}).` });
    said({ ok: true, text: "Comment added." }, task);
  };
  // a comment on a task, as `actor`: undefined when it was written, else why not
  const writeComment = async (stream: string, task: string, words: string, actor: string): Promise<string | undefined> => {
    const w = (await dispatcher.submit({ stream, kind: "create", entity: { type: COMMENT, id: `c-${randomBytes(6).toString("hex")}` }, actor, payload: { task, text: words } })).result;
    if (w.status === "appended") return undefined;
    return w.status === "rejected" || w.status === "refused" ? w.detail : w.status;
  };

  const act = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const a = await askedOf(res, form, ws);
    if (a === undefined) return;
    const login = who(req).login;
    if (login) a.login = login;
    const ask = a.ask;
    const ticket = a.ticket;
    const actor = actorNow();
    if (actor === undefined) { send(res, 401, text, "sign in with GitHub first (Integrations)\n"); return; }
    const cmd = commandOf(ask, ws.stream, actor);
    const first = ticket === undefined ? undefined : commandOf(ticket, ws.stream, actor);
    if (await heldBack(res, a, cmd, first)) return;
    let flash = await inOrder([
      ...(ticket === undefined || first === undefined ? [] : [() => write(ticket, first)]),
      () => write(ask, cmd),
    ]);
    // the decision's comment, on the ticket, once the move is written
    const comment = (a.values?.comment ?? "").replaceAll("\r\n", "\n").trim();
    if (flash.ok && comment !== "" && ask.type !== IDEA) {
      const why = await writeComment(ws.stream, ask.id, comment, actor);
      flash = { ...flash, text: why === undefined ? `${flash.text} Comment added.` : `${flash.text} The comment wasn't added (${why}).` };
    }
    const key = flashKey();
    flashes.set(key, flash.ok ? { ...flash, changed: changedBy(ask, ticket) } : flash);
    if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
    const back = withQ(`/?r=${key}`, ws.q); // the result, in the workspace it was written to
    if (a.fragment) return send(res, 200, html, `<div data-go="${esc(back)}"></div>`);
    send(res, 303, text, "", { Location: back });
  };

  // GET /projects/new: + New project's page (new-project.ts), opened from the board you're on, which
  // Cancel and the tira mark go back to. It offers what your accounts hold: your GitHub repos, and
  // your Jira's projects (or a way to connect it). No one who can act yet: the landing first.
  const acc = accounts(opts.links, opts.site);
  // A task's newest commits, looked up on GitHub (only that task's) and kept: what the look said.
  const commitsSaid = (stream: string, task: string, login: string | undefined) =>
    lookedSaid(task, () => lookForCommits(opts.store, opts.registry, stream, task, acc.githubOf(login)));
  // the page's Jira: your connected site's projects, else a way to sign in, else that it isn't set up
  const newProjectJira = async (login: string | undefined, host: string, ws: Workspace): Promise<NewProject["jira"]> => {
    if (login) return acc.jira(login, host, withQ("/projects/new", ws.q));
    return appKeys(acc.env).atlassian ? { state: "signin" } : { state: "unset" };
  };
  const projectForm = async (login: string | undefined, host: string, ws: Workspace, f: Partial<NewProject> = {}): Promise<NewProject> => {
    const got = await acc.repos(login);
    const jira = await newProjectJira(login, host, ws);
    return { token, back: withQ("/", ws.q), action: withQ("/projects", ws.q), repos: got.repos, jira, ...f };
  };
  const newProjectGet = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string, ws: Workspace) => {
    const me = who(req);
    if (!me.actor) return send(res, 303, text, "", { Location: `/welcome${url.search}` });
    send(res, 200, html, newProjectPage(await projectForm(me.login, host, ws)));
  };

  // POST /projects: the New project page's form. A project is born with its link (tira's rules want
  // a repo or a Jira project on it): its name, its GitHub repo and, if picked, its Jira project from
  // your connected site, written as the person acting; then its board. One that can't be made comes
  // back to the page, with what was typed and why.
  // what's wrong with a new project, or the workspace it makes and the Jira site it links (none: no Jira)
  type NewProjectField = "name" | "repo" | "jira" | "who";
  const newProjectCheck = async (name: string, repo: string, key: string, login: string | undefined, actor: string | undefined): Promise<{ problem: [number, NewProjectField, string] } | { at: Workspace; site: string | undefined; actor: string }> => {
    if (actor === undefined) return { problem: [401, "who", "Sign in with GitHub first (Settings), so tira knows who makes the project."] };
    const at = NEW_NAME.test(name) ? workspaceIn(new URL(`http://h/?w=${encodeURIComponent(name)}`), opts.stream) : undefined;
    if (!at) return { problem: [400, "name", "A project's name is letters, digits, dots, dashes or underscores, starting with a letter or digit."] };
    if (!REPO.test(repo)) return { problem: [400, "repo", `${repo || "That"} isn't a GitHub repo as owner/name.`] };
    const site = key !== "" && login ? atlassianAuth(login, acc.env)?.site : undefined;
    if (key !== "" && (!JIRA_PROJECT.test(key) || !site)) return { problem: [400, "jira", "Pick a Jira project from your connected site, or none for now."] };
    // at a public address, a few projects each (the free database stays small)
    if (opts.site && login && (await projectsOf(login)).filter((p) => p.admin).length >= MAX_PROJECTS) {
      return { problem: [409, "who", `You're the admin of ${MAX_PROJECTS} projects already, the most each person can have here: delete one to make another.`] };
    }
    const before = await opts.store.readStream(at.stream);
    if (before.length === 0) {
      const clash = await nameTaken(name);
      return clash ? { problem: [409, "name", `Another project is already called ${clash}: name this one differently.`] } : { at, site, actor };
    }
    const deleted = workspaceOf(fold(before, opts.registry), at.stream)?.deleted;
    return { problem: [409, "name", deleted ? `${name} was a project here, since deleted: pick another name.` : `There is a project named ${name} already: pick it in Projects, or name this one differently.`] };
  };
  // a project's id and its name are each unique on this tira, whatever their case (Isha, 2026-10-25): the
  // live project a new one's name would clash with (by its id, or the name it's shown by), if any
  const nameTaken = async (name: string): Promise<string | undefined> => {
    const all = await opts.store.readAll();
    const r = fold(all, opts.registry);
    const same = (x: string) => x.toLowerCase() === name.toLowerCase();
    const live = [...new Set(all.map((e) => e.stream))].filter((s) => !workspaceOf(r, s)?.deleted);
    const hit = live.find((s) => same(s) || same(workspaceOf(r, s)?.title ?? s));
    return hit === undefined ? undefined : workspaceOf(r, hit)?.title ?? hit;
  };
  // a new project's link: its repo and, when one was picked, its Jira project (with Jira's name for it)
  const newLink = (repo: string, site: string | undefined, key: string, jiraName: string | undefined) => {
    if (!site) return { repo };
    return { repo, jira_site: site, jira_project: key, ...(jiraName ? { jira_name: jiraName } : {}) };
  };
  const newProject = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    const actor = actorNow();
    const name = (form.get("name") ?? "").trim();
    const repo = (form.get("repo") ?? "").trim();
    const key = (form.get("jira_project") ?? "").trim();
    const again = async (status: number, field: NewProjectField, why: string) => send(res, status, html, newProjectPage(await projectForm(me.login, host, ws, { name, repo, jiraProject: key, problem: { field, text: why } })));
    const checked = await newProjectCheck(name, repo, key, me.login, actor);
    if ("problem" in checked) return again(...checked.problem);
    const { at, site, actor: by } = checked;
    const jiraName = site ? await projectName(acc.jiraOf(me.login, { version: 0, jira_site: site }), key) : undefined;
    // whoever makes it is its admin (Isha, 2026-10-25): its people first, so no one else can claim it
    // meanwhile; given back if the project isn't made after all
    const login = me.login;
    if (login && !(await saveProject(at.stream, (p) => (p ? undefined : { admins: [login], members: [] }), linkEnv))) return again(409, "name", `Another project is already called ${name}: name this one differently.`);
    const w = (await dispatcher.submit({ stream: at.stream, kind: "create", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: 1 }, actor: by, payload: newLink(repo, site, key, jiraName) })).result;
    if (w.status !== "appended" && login) await saveProject(at.stream, () => ({ admins: [], members: [] }), linkEnv);
    if (w.status !== "appended") return again(400, "name", `${name} wasn't created (${w.status === "rejected" || w.status === "refused" ? w.detail : w.status}).`);
    const made = site ? `Created ${name}, linked to GitHub ${repo} and Jira ${jiraName ?? key}. Sync from here.` : `Created ${name}, linked to GitHub ${repo}. Add its Jira project, or sync, from here.`;
    const k = flashKey();
    flashes.set(k, { ok: true, text: made });
    if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
    send(res, 303, text, "", { Location: withQ(`/?r=${k}`, at.q) });
  };

  // POST /projects/delete: Project settings' Delete, with the project's name typed to be sure; never
  // the project tira serve was started with. A new version of its link, marked deleted: it leaves
  // the project list and its board closes, for everyone; its history stays in the log.
  const deleteProject = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const go = (f: { ok: boolean; text: string }, to: (key: string) => string) => {
      const k = flashKey();
      flashes.set(k, f);
      if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
      send(res, 303, text, "", { Location: to(k) });
    };
    const stay = (why: string) => go({ ok: false, text: why }, (k) => withQ(`/integrations?r=${k}`, ws.q));
    const actor = actorNow();
    if (actor === undefined) return stay("Sign in with GitHub first, so tira knows who deletes it. Nothing was deleted.");
    const login = who(req).login;
    if (login && !isProjectAdmin(await peopleNow(ws.stream), login)) return stay("Only this project's admins can delete it. Nothing was deleted.");
    if (ws.stream === opts.stream) return stay("This is the project tira serve was started with: it can't be deleted here. Nothing was deleted.");
    const { r } = await now(ws.stream);
    const link = workspaceOf(r, ws.stream);
    const shown = link?.title ?? ws.stream; // its name as people see it
    if ((form.get("confirm") ?? "").trim() !== shown) return stay(`Type ${shown} exactly to delete it. Nothing was deleted.`);
    const payload = { ...(link?.repo ? { repo: link.repo } : {}), ...(link?.jira_site ? { jira_site: link.jira_site } : {}), ...(link?.jira_project ? { jira_project: link.jira_project } : {}), deleted: true };
    const w = (await dispatcher.submit({ stream: ws.stream, kind: "create", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: (link?.version ?? 0) + 1 }, actor, payload })).result;
    if (w.status !== "appended") return stay(`${ws.stream} wasn't deleted (${w.status === "rejected" || w.status === "refused" ? w.detail : w.status}).`);
    go({ ok: true, text: `Deleted ${shown}: it's off the project list. Its history stays in tira's log.` }, (k) => `/?r=${k}`);
  };

  // POST /projects/rename: Project settings' General. A new version of the project's link, with its
  // links as they are and the name people see (its stream, address and history keep the name it
  // was made with). Two live projects can't share a name.
  const renameProject = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const done = (f: { ok: boolean; text: string }) => {
      const k = flashKey();
      flashes.set(k, f);
      if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
      send(res, 303, text, "", { Location: withQ(`/integrations?r=${k}`, ws.q) });
    };
    const actor = actorNow();
    if (actor === undefined) return done({ ok: false, text: "Sign in with GitHub first, so tira knows who renames it." });
    const login = who(req).login;
    if (login && !isProjectAdmin(await peopleNow(ws.stream), login)) return done({ ok: false, text: "Only this project's admins can rename it." });
    const title = (form.get("title") ?? "").trim().replace(/\s+/g, " ");
    if (!TITLE.test(title)) return done({ ok: false, text: "A project's name is 1 to 80 characters, with no control characters." });
    const all = await opts.store.readAll();
    const r = fold(all, opts.registry);
    const link = workspaceOf(r, ws.stream);
    if (title === (link?.title ?? ws.stream)) return done({ ok: true, text: `It's already called ${title}.` });
    const others = [...new Set(all.map((e) => e.stream))].filter((s) => s !== ws.stream && !workspaceOf(r, s)?.deleted);
    if (others.some((s) => (workspaceOf(r, s)?.title ?? s).toLowerCase() === title.toLowerCase())) return done({ ok: false, text: `Another project is already called ${title}: pick another name.` });
    const payload = { ...(link?.repo ? { repo: link.repo } : {}), ...(link?.jira_site ? { jira_site: link.jira_site } : {}), ...(link?.jira_project ? { jira_project: link.jira_project } : {}), title };
    const w = (await dispatcher.submit({ stream: ws.stream, kind: "create", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: (link?.version ?? 0) + 1 }, actor, payload })).result;
    if (w.status !== "appended") return done({ ok: false, text: `Not renamed (${w.status === "rejected" || w.status === "refused" ? w.detail : w.status}).` });
    done({ ok: true, text: `Renamed to ${title}. Its address and history keep ${ws.stream}.` });
  };

  type Route = (req: IncomingMessage, res: ServerResponse, url: URL, host: string, ws: Workspace) => Promise<void>;
  // the Integrations pages, in the project the request names (their stream and log are its; their
  // redirects and links keep it: carryQ)
  const wsNow = (): Workspace => current.getStore()?.ws ?? { stream: opts.stream, q: "" };
  const integrations = integrationRoutes({
    store: opts.store, registry: opts.registry, get stream() { return wsNow().stream; }, home: opts.stream, token, ...(opts.actor !== undefined ? { fallbackActor: opts.actor } : {}), dispatcher, outside: opts.links, ...(opts.site ? { site: opts.site } : {}),
    now: async () => ({ r: (await now(wsNow().stream)).r }), formOf, people: peopleNow, projectsOf: (login) => projectsOf(login),
    send: (res, status, type, body, extra = {}) => {
      const q = wsNow().q;
      const at = extra.Location;
      send(res, status, type, type.startsWith("text/html") ? carryQ(body, q) : body, at?.startsWith("/") && !/[?&]w=/.test(at) ? { ...extra, Location: withQ(at, q) } : extra);
    },
    flash: (f) => {
      const key = flashKey();
      flashes.set(key, f);
      if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
      return key;
    },
    takeFlash: (key) => {
      const f = flashes.get(key);
      flashes.delete(key);
      return f;
    },
  }, who);
  // ---------- Claude's connectors sign in (src/mcp/oauth.ts): at a public address only ----------
  const oauthSecret = linkEnv.TIRA_SECRET_KEY ?? "";
  const codes = new Codes();
  const tokensNow = () => opts.links?.agentTokens ?? agentTokensFor(linkEnv);
  const asJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body), { "Access-Control-Allow-Origin": "*" });
  // registration: Claude's, by JSON; its id is the registration, signed
  const register = async (req: IncomingMessage, res: ServerResponse) => {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return asJson(res, 400, { error: "invalid_client_metadata", error_description: "send the registration as JSON" });
    }
    const got = registrationOf(body);
    if ("error" in got) return asJson(res, 400, { error: got.error, error_description: got.why });
    asJson(res, 201, { client_id: clientId(oauthSecret, got.client), client_id_issued_at: Math.floor(Date.now() / 1000), ...got.client, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
  };
  // the code's exchange: the agent the person approved is connected now, and its token is the answer
  const exchange = async (req: IncomingMessage, res: ServerResponse) => {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      return asJson(res, 400, { error: "invalid_request", error_description: "too large" });
    }
    const got = codes.exchange(form);
    if ("error" in got) return asJson(res, 400, { error: got.error, error_description: got.why });
    const tokens = tokensNow();
    if (!tokens) return asJson(res, 503, { error: "temporarily_unavailable", error_description: "connecting agents needs tira's Postgres database" });
    const { project, agent, login } = got.grant;
    const name = freeName(agent, (await tokens.list(project)).map((x) => x.agent));
    const made = await tokens.create(project, name, login, CONNECTOR_APP);
    asJson(res, 200, { access_token: made.token, token_type: "Bearer" });
  };
  // the side Claude's servers call: discovery, registration, the exchange (true: answered)
  const oauthMachine = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const site = opts.site;
    if (!site) return false;
    const answers: Record<string, () => unknown> = {
      [`GET ${PROTECTED_RESOURCE}`]: () => asJson(res, 200, protectedResource(site.origin)),
      [`GET ${PROTECTED_RESOURCE}/mcp`]: () => asJson(res, 200, protectedResource(site.origin)),
      [`GET ${AUTHORIZATION_SERVER}`]: () => asJson(res, 200, authorizationServer(site.origin)),
      "POST /oauth/register": () => register(req, res),
      "POST /oauth/token": () => exchange(req, res),
    };
    const answer = answers[`${req.method} ${url.pathname}`];
    if (answer) await answer();
    return answer !== undefined;
  };
  // the person's side: approving Claude's connection, signed in with GitHub, to one of their projects
  const connectable = async (login: string, current: string) => (await projectsOf(login, current)).map((p) => ({ stream: p.stream, ...(p.title ? { title: p.title } : {}) }));
  const consent = async (res: ServerResponse, login: string, asking: Asking, current: string, status = 200, flash?: { ok: boolean; text: string }) => {
    const fields = { client_id: asking.client_id, redirect_uri: asking.redirect_uri, ...(asking.state ? { state: asking.state } : {}), code_challenge: asking.challenge };
    const projects = await connectable(login, current);
    const body = consentPage({ token, login, fields, projects, project: projects.some((p) => p.stream === current) ? current : projects[0]?.stream ?? current, agent: "claude", ...(flash ? { flash } : {}) });
    send(res, status, html, body, { "Content-Security-Policy": consentCsp(asking.redirect_uri), "Set-Cookie": `${NEXT_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  };
  const authorizeGet = async (req: IncomingMessage, res: ServerResponse, url: URL, _host: string, ws: Workspace) => {
    if (!opts.site) return send(res, 404, text, "not found\n");
    const got = askingOf(oauthSecret, opts.site.origin, url.searchParams);
    if ("show" in got) return send(res, 400, text, `${got.show}\n`);
    if ("back" in got) return send(res, 303, text, "", { Location: got.back });
    const login = who(req).login;
    if (!login) { // sign in first, then back here
      const key = flashKey();
      flashes.set(key, { ok: true, text: "Sign in to connect Claude to tira." });
      return send(res, 303, text, "", { Location: `/welcome?r=${key}`, "Set-Cookie": `${NEXT_COOKIE}=${encodeURIComponent(url.pathname + url.search)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` });
    }
    await consent(res, login, got.asking, ws.stream);
  };
  const authorizePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string, ws: Workspace) => {
    if (!opts.site) return send(res, 404, text, "not found\n");
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const got = askingOf(oauthSecret, opts.site.origin, form);
    if ("show" in got) return send(res, 400, text, `${got.show}\n`);
    if ("back" in got) return send(res, 303, text, "", { Location: got.back });
    const { asking } = got;
    const login = who(req).login;
    if (!login) return send(res, 303, text, "", { Location: "/welcome" });
    const state = asking.state ? { state: asking.state } : {};
    if (form.get("decision") !== "allow") return send(res, 303, text, "", { Location: withQuery(asking.redirect_uri, { error: "access_denied", error_description: "the person didn't allow it", ...state }) });
    const project = form.get("project") ?? "";
    const agent = (form.get("agent") ?? "").trim();
    const known = (await connectable(login, ws.stream)).some((p) => p.stream === project);
    const why = known ? agentNameProblem(agent) : "Pick one of your projects.";
    if (why) return consent(res, login, asking, ws.stream, 422, { ok: false, text: why });
    const code = codes.issue(asking, { project, agent, login });
    send(res, 303, text, "", { Location: withQuery(asking.redirect_uri, { code, ...state, iss: opts.site.origin }) });
  };

  const routes: Record<string, Route> = { "GET /": page, "GET /oauth/authorize": authorizeGet, "POST /oauth/authorize": authorizePost, "GET /api/tasks": tasks, "GET /api/workspaces": workspaces, "GET /api/live": liveSeq, "GET /confirm": confirm, "POST /act": act, "GET /projects/new": newProjectGet, "POST /projects": newProject, "POST /projects/delete": deleteProject, "POST /projects/rename": renameProject, "POST /tickets": saveTicket, "POST /comments": addComment, "POST /proof": proofPost, ...integrations };
  // tira's MCP server at /mcp (src/mcp/http.ts), with the same agents' tokens as Project settings
  // an agent works while the person who connected it is still in its project and not removed (once
  // people sign in: before that, there's no one to check)
  const stillIn = async (agent: { project: string; createdBy: string }) => {
    if (!appKeys(linkEnv).github) return true;
    await accountsNow();
    return !isBlocked(agent.createdBy, linkEnv) && inProject(await peopleNow(agent.project), agent.createdBy);
  };
  const mcp = mcpRoute({ store: opts.store, registry: opts.registry, ...(opts.site ? { site: opts.site } : {}), tokens: () => opts.links?.agentTokens ?? agentTokensFor(opts.links?.env ?? process.env), stillIn, commitsFor: (agent, task) => commitsSaid(agent.project, task, agent.createdBy), proofFor: (agent, task, ref) => proveWith(opts.store, opts.registry, agent.project, task, acc.githubOf(agent.createdBy), ref) });
  // The pages that are yours, not a project's: signing in, your settings and profile, your project
  // list and making a project, approving Claude. Every other page is its project's, and only its
  // people get it (src/serve/team.ts); anyone else finds no such project.
  const YOURS = new Set(["GET /welcome", "GET /settings", "GET /u", "GET /projects", "GET /projects/new", "POST /projects", "GET /oauth/authorize", "POST /oauth/authorize", "GET /api/workspaces",
    "GET /signup/email", "POST /signup/email", "POST /integrations/setup", "POST /integrations/setup/reveal", "POST /integrations/profile", "POST /integrations/accounts", "POST /integrations/github/disconnect",
    "GET /integrations/jira/connect", "GET /integrations/jira/callback", "POST /integrations/jira/site", "POST /integrations/jira/disconnect",
    "POST /signin/start", "GET /signin/start", "GET /signin/code", "GET /signin/github/callback", "POST /signin/poll", "POST /signout"]);
  // pages someone with no email yet may still open (else they give one first)
  const BEFORE_EMAIL = new Set(["GET /welcome", "GET /signup/email", "GET /signin/start", "GET /signin/code", "GET /signin/github/callback"]);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, text, "ok\n"); // the host's check that tira is up: says nothing else
    if (!LOCAL_HOST.test(host) && host !== opts.site?.host) return send(res, 403, "text/plain; charset=utf-8", opts.site ? `tira answers at ${opts.site.origin} only\n` : "tira serve answers on 127.0.0.1 only\n");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === MCP_PATH) return mcp(req, res, url); // agents, by their own token: no page, no sign-in
    if (await oauthMachine(req, res, url)) return; // Claude's servers, signing a connector in
    const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
    if (asset !== undefined) return send(res, 200, "text/javascript; charset=utf-8", asset);
    const key = routeKey(req.method, url.pathname);
    const route = routes[key];
    if (!route) return send(res, 404, text, "not found\n");
    if (route !== liveSeq) await accountsNow(); // the live check reads no one's account
    const ws = workspaceIn(url, opts.stream);
    if (!ws) return send(res, 400, text, "that can't be a project's name\n");
    const me = who(req);
    if (me.login && (await turnedAway(req, res, url, key, ws, me.login))) return;
    return current.run({ ...me, ws }, () => route(req, res, url, host, ws));
  };
  // Where someone signed in goes instead, if anywhere (true: sent there): with no email yet, the
  // email step; on a project they aren't one of the people of, no such project (the one tira opened
  // on: their own projects instead).
  const turnedAway = async (req: IncomingMessage, res: ServerResponse, url: URL, key: string, ws: Workspace, login: string): Promise<boolean> => {
    const page = req.method === "GET" && !key.startsWith("GET /api/");
    if (page && !BEFORE_EMAIL.has(key) && !emailOf(login, linkEnv)) {
      send(res, 303, text, "", { Location: "/signup/email" });
      return true;
    }
    if (YOURS.has(key) || inProject(await peopleNow(ws.stream), login)) return false;
    const flash = url.searchParams.get("r");
    if (key === "GET /" && ws.q === "") send(res, 303, text, "", { Location: withQ("/projects", flash === null ? "" : `r=${encodeURIComponent(flash)}`) });
    else if (page) send(res, 404, html, noWorkspace(ws.stream));
    else send(res, 404, text, "not found\n");
    return true;
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => (res.headersSent ? res.destroy() : send(res, 500, "text/plain; charset=utf-8", `tira serve: ${(err as Error).message}\n`)));
  });
  server.on("close", () => void mcp.close());
  return Object.assign(server, { token });
}
