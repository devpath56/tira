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
// (cross-site forms); the actor is fixed when the server starts; only the tree verbs
// below are accepted; a strict Content-Security-Policy allows only this server's scripts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventStore, StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { canonicalJson, fold, type FoldResult } from "../fold/fold.ts";
import { entityKey } from "../fold/types.ts";
import { attentionSince, BRAND, CSS, proofsOf, renderHtml, THEME_RADIOS, THEME_SWITCH, type DivergencePanel } from "../render/html.ts";
import { flatten, streamView } from "../render/tree-view.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import { WritePath, isReservedActor, type Command, type Preview, type WriteResult } from "../write/write-path.ts";
import { blockerOf, commandFor, missing, PAGE_VERBS, parseCommand, subtaskName, withDefaults, type PageAction } from "./command.ts";
import { briefFor, type Brief, type BriefFacts } from "./brief.ts";

export { PAGE_VERBS } from "./command.ts";

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// Referrer-Policy is same-origin, not no-referrer: under no-referrer browsers send
// `Origin: null` on form posts, and the same-origin check below would refuse the page's
// own writes (found by submitting a real form, 2026-10-20).
const HEADERS = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": "no-store" };
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const MAX_BODY = 16 * 1024;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
const ASSETS: Record<string, string> = {
  "/app.mjs": readFileSync(new URL("./app.mjs", import.meta.url), "utf8"),
  "/rank.mjs": readFileSync(new URL("./rank.mjs", import.meta.url), "utf8"),
  "/theme.mjs": readFileSync(new URL("./theme.mjs", import.meta.url), "utf8"),
  "/graph.mjs": readFileSync(new URL("./graph.mjs", import.meta.url), "utf8"),
  "/layout.mjs": readFileSync(new URL("./layout.mjs", import.meta.url), "utf8"),
};

export interface ServeOptions {
  store: EventStore;
  registry: Registry;
  stream: string;
  actor: string; // who the page acts as, fixed for the server's life
  token?: string; // tests may pin it; otherwise random per process
  // The page's divergence section, computed per page load from the events that load renders
  // (the CLI passes tira divergence's own differ); never a stored report.
  divergence?: (events: StoredEvent[]) => DivergencePanel;
}

export interface TaskEntry { key: string; type: string; id: string; state: string; path: string; drawer: string }

// The palette's index: every tree task, in the page's drawer order (#t<i>).
export function taskIndex(r: FoldResult, stream: string): TaskEntry[] {
  const roots = streamView(r, stream).roots;
  const rows = flatten(roots);
  const parentOf = new Map<string, string>();
  const walk = (row: (typeof rows)[number]) => row.children.forEach((c) => { parentOf.set(c.key, row.key); walk(c); });
  roots.forEach(walk);
  const idOf = new Map(rows.map((x) => [x.key, x.id]));
  return rows.map((row, i) => {
    const up: string[] = [];
    for (let p = parentOf.get(row.key); p !== undefined; p = parentOf.get(p)) up.unshift(idOf.get(p) ?? p);
    return { key: row.key, type: row.type, id: row.id, state: row.state, path: up.join(" › "), drawer: `t${i}` };
  });
}

// waitables: to block, the open tasks it could wait on instead of a new ticket
interface Packet { ok: boolean; title: string; verdict: string; hint?: string; seen: number; brief?: Brief; command?: string; suggestions: string[]; found?: boolean; waitables?: string[] }

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
  if (!verb) return { ok: false, title, verdict: `tira doesn't take ${event} from the page.`, seen, suggestions: [] };
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
    ok: pv.ok, title, verdict: verdictOf(pv), ...(hint ? { hint } : {}), seen, suggestions, found,
    ...(event === "BLOCK" ? { waitables: waitable(r, stream, id) } : {}),
    brief: briefFor(factsFor(ask, state, cfg.region, pv, found)),
    command: commandFor(type, id, event, found),
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

interface ConfirmOpts { type: string; id: string; event: string; token: string; moved?: boolean; command?: string; error?: string; notice?: string }

// The decision: tira recommends (read-only) beside your action (the command, editable), then
// the button. The same body serves the confirm page and, under `tira serve`, the dialog the
// live page opens over itself (?fragment=1): there the way out closes the dialog, and the
// suggested reasons and tasks are buttons that fill the command in.
function briefHtml(p: Packet): string {
  const b = p.brief;
  const lines: [string, string][] = b ? [["Decision", b.decision], ["Recommendation", b.recommendation], ["Tradeoffs", b.tradeoffs], ["Best practice", b.practice], ["Kind", b.kind]] : [];
  const hint = p.hint ? `<p class="hint" data-hint><b>What to do:</b> ${esc(p.hint)}</p>` : "";
  return `<section class="brief" aria-label="tira recommends (read-only)" data-brief><h2>tira recommends</h2>`
    + lines.filter(([, t]) => t !== "").map(([k, t]) => `<p><b>${k}:</b> ${esc(t)}</p>`).join("")
    + `<p class="verdict ${p.ok ? "ok" : "no"}">${esc(p.verdict)}</p>${hint}</section>`;
}

// why nothing was written, or what changed since it opened
function noticesHtml(opts: ConfirmOpts): string {
  const moved = opts.moved ? `<p class="flash no" role="status" data-moved>The log changed since you opened this, so nothing was written. This is what tira says now.</p>` : "";
  const notice = opts.notice ? `<p class="flash no" role="status" data-notice>${esc(opts.notice)}</p>` : "";
  const error = opts.error ? `<p class="flash no" role="alert" data-error>${esc(opts.error)} Nothing was written.</p>` : "";
  return moved + notice + error;
}

const NOTE_HELP = `Any command can take note="…": the history keeps it. The same command runs in a terminal.`;
function helpText(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  if (!p.ok) return "tira would refuse this as it stands: edit it (another task or verb) and check again, or close.";
  if (opts.event === "BLOCK" && fragment) return `Name what it waits on: a new ticket is created under ${opts.id} and linked as blocking it, or pick an open task. The command updates as you type and runs exactly as written.`;
  if (opts.event === "BLOCK") return `Name the new ticket on line 1 and as blocker= on line 2 (the reason defaults to "waiting on" it). To wait on an open task instead, delete line 1 and set blocker= to it.`;
  return (PAGE_VERBS[opts.event]?.field ? "Fill in the empty quotes. " : "Ready to run as it is. ") + NOTE_HELP;
}

// values the command can be filled with: buttons live, a plain list on the confirm page
function choicesHtml(values: string[], fragment: boolean, caption: string, plainCaption: string, attrs: (v: string) => string): string {
  if (values.length === 0) return "";
  if (!fragment) return `<p class="cmd-help">${plainCaption}: ${values.map(esc).join(" · ")}</p>`;
  const buttons = values.map((v) => `<button type="button" class="fill" ${attrs(v)}>${esc(v)}</button>`).join("");
  return `<div class="fills" data-fills><span>${caption}</span>${buttons}</div>`;
}

// to block: what it waits on, a new ticket by name or an open task
function blockedByHtml(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  if (opts.event !== "BLOCK" || !p.ok) return "";
  const open = (p.waitables ?? []).slice(0, 12);
  const tasks = choicesHtml(open, fragment, "Or an open task:", "Open tasks it could wait on", (v) => `data-fill-blocker="${esc(v)}"`);
  if (!fragment) return tasks;
  return `<label class="blocked-by" data-blocked-by="${esc(opts.id)}" data-type="${esc(opts.type)}"><span>Blocked by</span><input type="text" placeholder="a new ticket, e.g. design_tokens" autocomplete="off" spellcheck="false" aria-label="Blocked by: name a new ticket, or pick an open task"></label>` + tasks;
}

function fillsHtml(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  if (!p.ok) return "";
  const reasons = choicesHtml(p.suggestions, fragment, "Used before:", "Reasons used before", (v) => `data-fill="reason" data-value="${esc(v)}"`);
  const found = PAGE_VERBS[opts.event]?.creates && !p.found && fragment
    ? `<div class="fills" data-fills><button type="button" class="fill" data-fill-found="${esc(opts.id)}">Mark as found while working on ${esc(opts.id)}</button></div>`
    : "";
  return reasons + found;
}

function packetBody(p: Packet, opts: ConfirmOpts, fragment: boolean): string {
  const verb = PAGE_VERBS[opts.event];
  const leave = (label: string) => (fragment ? `<button class="how" type="button" data-close-confirm>${label}</button>` : `<a class="how" href="/">${label}</a>`);
  const close = leave(fragment ? "Close" : "Back to the page");
  const head = `<div class="packet" data-packet data-ok="${p.ok && verb !== undefined}"><h1>${esc(p.title)}</h1>${noticesHtml(opts)}`;
  // no such verb or task: nothing to edit from
  if (!verb || p.brief === undefined) return `${head}<div class="split">${briefHtml(p)}</div><div class="run">${close}</div></div>`;
  const command = opts.command ?? p.command ?? "";
  const hidden = [["token", opts.token], ["type", opts.type], ["id", opts.id], ["event", opts.event], ["seen", String(p.seen)]]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v as string)}">`).join("");
  const right = `<section class="your-action" aria-label="Your action, edit before sending"><h2>Your action — edit before sending</h2>`
    + blockedByHtml(p, opts, fragment) + `<textarea name="command" rows="5" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="The command tira will run: edit it before sending" data-command>${esc(command)}</textarea>`
    + `<p class="cmd-help">${esc(helpText(p, opts, fragment))}</p>${fillsHtml(p, opts, fragment)}</section>`;
  const button = p.ok ? `<button class="act primary" type="submit">${esc(verb.label)} — run it</button> ${leave("Not now")}` : `<button class="act" type="submit">Check again</button> ${close}`;
  return `${head}<form method="post" action="/act" class="you-decide" aria-label="Your decision" data-you>${hidden}<div class="split">${briefHtml(p)}${right}</div>`
    + `<div class="run">${button}</div></form></div>`;
}

function confirmPage(p: Packet, opts: ConfirmOpts): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · ${esc(p.title)}</title><style>${CSS}</style></head><body>${THEME_RADIOS}<main class="packet-page"><nav class="top">${BRAND}${THEME_SWITCH}</nav><a class="how" href="/">← the page</a>`
    + packetBody(p, opts, false) + `</main><script type="module" src="/theme.mjs"></script></body></html>\n`;
}

const flashFor = (event: string, id: string, r: WriteResult): { ok: boolean; text: string } => {
  const label = PAGE_VERBS[event]?.label ?? event;
  if (r.status === "appended") {
    const closes = (r.closedByTira ?? []).map((c) => bareKey(c.key));
    const nothing = r.outcome === "noop" ? ", nothing changed" : "";
    const closed = closes.length > 0 ? " tira closed " + closes.join(", ") + ", citing it." : "";
    return { ok: true, text: `${label} ${id}: done (seq ${r.seq})${nothing}.${closed}` };
  }
  if (r.status === "rejected") return { ok: false, text: `${label} ${id}: refused (${r.code}: ${r.detail}). The refusal is in the log (seq ${r.seq}).` };
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
function blockerProblem(r: FoldResult, stream: string, a: PageAction, blocker: string): string | undefined {
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

const commandOf = (a: PageAction, stream: string, actor: string): Command => {
  // the actor is the server's, fixed at start: a posted "actor" field is ignored
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
  if (!verb || !registry.get(type)?.tree || id === "") return undefined;
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

export function tiraServer(opts: ServeOptions): Server & { token: string } {
  if (isReservedActor(opts.actor)) throw new Error(`"${opts.actor}" is reserved for tira's and the dispatcher's own writes: serve as a person`);
  const token = opts.token ?? randomBytes(24).toString("hex");
  const dispatcher = new Dispatcher(opts.store, opts.registry);
  const previews = new WritePath(opts.store, opts.registry);
  const flashes = new Map<string, { ok: boolean; text: string }>();
  let flashSeq = 0;
  const now = async () => {
    const events = await opts.store.readStream(opts.stream);
    const r = fold(events, opts.registry);
    return { events, r, hash: createHash("sha256").update(canonicalJson(r)).digest("hex") };
  };
  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const text = "text/plain; charset=utf-8";
  const html = "text/html; charset=utf-8";

  // GET /: the page, live, with the last action's result once
  const page = async (_req: IncomingMessage, res: ServerResponse, url: URL) => {
    const { events, r, hash } = await now();
    const rk = url.searchParams.get("r") ?? "";
    const flash = flashes.get(rk);
    flashes.delete(rk); // a result shows once
    const divergence = opts.divergence?.(events);
    send(res, 200, html, renderHtml(r, opts.stream, hash, events, { live: flash ? { flash } : {}, ...(divergence !== undefined ? { divergence } : {}) }));
  };

  // GET /api/tasks: the palette's index
  const tasks = async (_req: IncomingMessage, res: ServerResponse) => {
    const { r } = await now();
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(taskIndex(r, opts.stream)));
  };

  // A decision, shown (or shown again: a value missing, a different action, the log moved).
  // Nothing is written on the way.
  const decide = async (res: ServerResponse, at: { type: string; id: string; event: string }, o: Partial<ConfirmOpts>, fragment: boolean, status?: number) => {
    const { events, r } = await now();
    const p = await packetFor({ wp: previews, r, events, registry: opts.registry, stream: opts.stream, actor: opts.actor, ...at });
    const co: ConfirmOpts = { ...at, token, ...o };
    send(res, status ?? (p.ok ? 200 : 409), html, fragment ? packetBody(p, co, true) : confirmPage(p, co));
  };

  // GET /confirm: the decision; ?fragment=1 is just the packet, for the dialog the live page
  // opens over itself
  const confirm = async (_req: IncomingMessage, res: ServerResponse, url: URL) => {
    const at = { type: url.searchParams.get("type") ?? "node", id: url.searchParams.get("id") ?? "", event: url.searchParams.get("event") ?? "" };
    await decide(res, at, { moved: url.searchParams.get("moved") === "1" }, url.searchParams.get("fragment") === "1");
  };

  // POST /act, in stages: the form (from this page only), what it asks for, what stops it
  // before anything is written, then the write and back to the page with its result. The
  // dialog's own posts (fragment=1) get the decision back to show in place, or where to go next.
  interface Target { type: string; id: string; event: string }
  interface Asked { fragment: boolean; typed: string | null; seen: string | null; ask: PageAction; ticket: PageAction | undefined; target: Target }
  const targetOf = (a: PageAction): Target => ({ type: a.type, id: a.id, event: a.event });

  // the same origin, within the size cap, with this process's token
  const formOf = async (req: IncomingMessage, res: ServerResponse, host: string): Promise<URLSearchParams | undefined> => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) { send(res, 403, text, "cross-origin writes are refused\n"); return undefined; }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      send(res, 413, text, "too large\n");
      return undefined;
    }
    if (!safeEqual(form.get("token") ?? "", token)) { send(res, 403, text, "missing or wrong token\n"); return undefined; }
    return form;
  };

  // what it asks for: the command as you left it, read strictly; without one, the posted fields
  const askedOf = async (res: ServerResponse, form: URLSearchParams): Promise<Asked | undefined> => {
    const fragment = form.get("fragment") === "1";
    const seen = form.get("seen");
    const typed = form.get("command");
    if (typed === null) {
      const ask = actionFrom(form, opts.registry);
      if (!ask) { send(res, 400, text, "the page can only start, unblock, complete, block, cancel or reopen a task, or add a subtask with a name\n"); return undefined; }
      return { fragment, typed, seen, ask, ticket: undefined, target: targetOf(ask) };
    }
    const opened = { type: form.get("type") ?? "", id: form.get("id") ?? "", event: form.get("event") ?? "" };
    const parsed = parseCommand(typed, (t) => opts.registry.get(t)?.tree !== undefined);
    if (!parsed.ok) { await decide(res, opened, { command: typed, error: `tira can't run that: ${parsed.why}.` }, fragment, 422); return undefined; }
    const target = targetOf(parsed.action);
    // edited into another action (another task or verb): what tira says about that one first
    if (target.type !== opened.type || target.id !== opened.id || target.event !== opened.event) {
      { await decide(res, target, { command: typed, notice: "That's a different action from the one you opened, so here is what tira says about it first. Nothing was written." }, fragment); return undefined; }
    }
    return { fragment, typed, seen, ask: withDefaults(parsed.action), ticket: parsed.ticket, target };
  };

  // what stops it before anything is written (true: it answered): a value missing, a blocker
  // that can't be, a moved log, or, for a typed command, tira's refusal of the ticket or the move
  const heldBack = async (res: ServerResponse, a: Asked, cmd: Command, first: Command | undefined): Promise<boolean> => {
    const back = async (o: Partial<ConfirmOpts>, status?: number) => { await decide(res, a.target, { command: a.typed ?? "", ...o }, a.fragment, status); return true; };
    const lacking = missing(a.ask);
    if (lacking !== undefined && a.typed === null) { send(res, 400, text, `${lacking}\n`); return true; }
    if (lacking !== undefined) return back({ error: lacking }, 422);
    const blocker = blockerOf(a.ask);
    const problem = a.typed === null || blocker === undefined || a.ticket !== undefined ? undefined : blockerProblem((await now()).r, opts.stream, a.ask, blocker);
    if (problem) return back({ error: `tira can't run that: ${problem}.` }, 422);
    // decided on one log, written on another? show the decision again instead
    // (a post without `seen` didn't come from a decision: it gets one first)
    if (a.seen !== String((await now()).r.lastSeq)) {
      if (a.typed !== null) return back({ moved: a.seen !== null }, 409);
      const again = `/confirm?type=${encodeURIComponent(a.ask.type)}&id=${encodeURIComponent(a.ask.id)}&event=${encodeURIComponent(a.ask.event)}`;
      send(res, 303, text, "", { Location: a.seen === null ? again : again + "&moved=1" });
      return true;
    }
    if (a.typed === null) return false;
    // a typed command tira would refuse goes back into the dialog, not into the log; a new
    // ticket and its block are both checked before either is written
    for (const c of first === undefined ? [cmd] : [first, cmd]) {
      const pv = await previews.preview(c);
      const what = c === first ? "the new ticket " + (a.ticket?.child ?? "") : "this";
      if (!pv.ok) return back({ error: `tira would still refuse ${what}: ${pv.code}: ${pv.detail}.` }, 409);
    }
    return false;
  };

  const label = (a: PageAction) => (a.child === undefined ? a.id : a.child + " under " + a.id);
  const write = async (a: PageAction, c: Command) => {
    try {
      return flashFor(a.event, label(a), (await dispatcher.submit(c)).result);
    } catch (err) {
      return { ok: false, text: `${PAGE_VERBS[a.event]?.label ?? a.event} ${label(a)}: not sent (${(err as Error).message}).` };
    }
  };

  const act = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await formOf(req, res, host);
    if (form === undefined) return;
    const a = await askedOf(res, form);
    if (a === undefined) return;
    const ask = a.ask;
    const ticket = a.ticket;
    const cmd = commandOf(ask, opts.stream, opts.actor);
    const first = ticket === undefined ? undefined : commandOf(ticket, opts.stream, opts.actor);
    if (await heldBack(res, a, cmd, first)) return;
    const flash = await inOrder([
      ...(ticket === undefined || first === undefined ? [] : [() => write(ticket, first)]),
      () => write(ask, cmd),
    ]);
    const key = String(++flashSeq);
    flashes.set(key, flash);
    if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
    if (a.fragment) return send(res, 200, html, `<div data-go="/?r=${key}"></div>`);
    send(res, 303, text, "", { Location: `/?r=${key}` });
  };

  type Route = (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => Promise<void>;
  const routes: Record<string, Route> = { "GET /": page, "GET /api/tasks": tasks, "GET /confirm": confirm, "POST /act": act };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    if (!LOCAL_HOST.test(host)) return send(res, 403, "text/plain; charset=utf-8", "tira serve answers on 127.0.0.1 only\n");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
    if (asset !== undefined) return send(res, 200, "text/javascript; charset=utf-8", asset);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, text, "not found\n");
    return route(req, res, url, host);
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, "text/plain; charset=utf-8", `tira serve: ${(err as Error).message}\n`));
  });
  return Object.assign(server, { token });
}
