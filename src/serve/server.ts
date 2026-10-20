// `tira serve` (the D1 UI brief; approved 2026-10-19: localhost only, every change
// through the guarded write path). The page, live: each request folds the log and renders
// it, as `tira render` does, plus what only a live page can have: actions, the ⌘K
// palette and the last action's result.
//
// Every action goes through a confirm page first (trust at the time of action): tira's
// read-only part says what will happen, and why it would refuse; your part is the fields
// you fill in (evidence, a reason). Nothing on the page fires a write by itself.
//
// Safety: bound to 127.0.0.1; any other Host is refused (DNS rebinding); a write needs
// this process's random token and, when the browser sends one, a same-origin Origin
// (cross-site forms); the actor is fixed when the server starts; only the tree verbs
// below are accepted; a strict Content-Security-Policy allows only this server's scripts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { canonicalJson, fold, type FoldResult } from "../fold/fold.ts";
import { entityKey } from "../fold/types.ts";
import { attentionSince, CSS, renderHtml } from "../render/html.ts";
import { flatten, streamView } from "../render/tree-view.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import { WritePath, isReservedActor, type Command, type WriteResult } from "../write/write-path.ts";

// The verbs a page may send, with the field each needs (the node table's guards).
export const PAGE_VERBS: Record<string, { label: string; field?: { name: string; label: string } }> = {
  START: { label: "Start" },
  UNBLOCK: { label: "Unblock" },
  COMPLETE: { label: "Complete", field: { name: "evidenceRef", label: "Evidence (a file, link or note anyone can re-check)" } },
  BLOCK: { label: "Block", field: { name: "reason", label: "Why is it blocked?" } },
};

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
};

export interface ServeOptions {
  store: EventStore;
  registry: Registry;
  stream: string;
  actor: string; // who the page acts as, fixed for the server's life
  token?: string; // tests may pin it; otherwise random per process
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

interface Packet { ok: boolean; title: string; lines: string[]; verdict: string; seen: number }

// What tira says before an action fires: the move, the rule, the record it will leave,
// every parent tira will close first, and whether it would refuse. It is the write path's
// own decision (WritePath.preview: reserved names, tira's closes, then the rules), with any
// field you still have to fill counted as filled. `seen` is the stream's last seq it was
// decided on: the write is refused if the log moved since (the packet is shown again).
export async function packetFor(wp: WritePath, r: FoldResult, registry: Registry, stream: string, actor: string, type: string, id: string, event: string): Promise<Packet> {
  const verb = PAGE_VERBS[event];
  const title = `${verb?.label ?? event} ${id}?`;
  const current = r.entities.find((e) => e.stream === stream && e.key === entityKey({ type, id }));
  const seen = r.lastSeq;
  if (!current || !verb || !registry.get(type)?.tree) {
    return { ok: false, title, lines: [], verdict: !verb ? `tira doesn't take ${event} from the page.` : `There is no task ${id}.`, seen };
  }
  const cfg = registry.get(type)?.tree;
  const state = cfg ? (current.regions[cfg.region] ?? "") : "";
  const placeholder = verb.field ? { [verb.field.name]: "(you fill this in)" } : {};
  const pv = await wp.preview({ stream, kind: "event", entity: { type, id }, event, actor, payload: placeholder });
  const lines: string[] = [];
  const hit = registry.resolve(type, event);
  const pair = hit?.table.pairs.find((x) => x.from === state && x.event === event);
  if (pv.ok) lines.push(`${id}: ${state.replace("_", " ")} → ${(cfg ? (pv.regions[cfg.region] ?? "") : "").replace("_", " ")}`);
  if (pair?.guard) lines.push(`The rule: ${hit?.table.guards[pair.guard] ?? pair.guard}.`);
  if (pv.ok && pv.closes.length > 0) {
    const names = pv.closes.map((k) => k.replace(/^[^:]+:/, ""));
    lines.push(`tira will first close ${names.join(", then ")} (every child is done or cancelled), citing this move.`);
  }
  lines.push(`Recorded as ${actor}, in ${stream}${pv.ok && pv.closes.length > 0 ? ", after tira's closes" : ""}.`);
  return {
    ok: pv.ok,
    title,
    lines,
    verdict: pv.ok ? (pv.outcome === "noop" ? "tira's check: allowed, but nothing changes (already so)." : "tira's check: allowed.") : `tira would refuse this: ${pv.code}: ${pv.detail}.`,
    seen,
  };
}

function confirmPage(p: Packet, opts: { type: string; id: string; event: string; token: string; blockedWhy?: string; moved?: boolean }): string {
  const verb = PAGE_VERBS[opts.event];
  const field = verb?.field;
  const form = p.ok
    ? `<form method="post" action="/act" class="you-decide" aria-label="What you control" data-you>`
      + `<input type="hidden" name="token" value="${esc(opts.token)}"><input type="hidden" name="type" value="${esc(opts.type)}"><input type="hidden" name="id" value="${esc(opts.id)}"><input type="hidden" name="event" value="${esc(opts.event)}"><input type="hidden" name="seen" value="${p.seen}">`
      + (field ? `<label>${esc(field.label)}<input name="${field.name}" aria-label="${esc(field.label)}" required autocomplete="off" autofocus></label>` : "")
      + `<button class="act" type="submit">${esc(verb?.label ?? opts.event)} ${esc(opts.id)}</button> <a class="how" href="/">Cancel</a></form>`
    : `<p><a class="how" href="/">Back to the page</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · ${esc(p.title)}</title><style>${CSS}
.packet{max-width:620px}.packet h1{font-size:22px;letter-spacing:-.02em;margin:18px 0 12px}.packet section{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px;margin:0 0 14px}
.packet h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0 0 8px}.packet ul{margin:0;padding-left:18px}.packet li{margin:4px 0}
.verdict{margin:10px 0 0;font-weight:650}.verdict.ok{color:var(--done)}.verdict.no{color:var(--block)}
.you-decide{display:grid;gap:10px;justify-items:start}.you-decide label{justify-self:stretch}.you-decide label{display:grid;gap:6px;font-weight:600;font-size:13px}.you-decide input[name]{font:500 14px var(--sans);color:var(--fg);background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
</style></head><body><main class="packet" data-packet data-ok="${p.ok}"><a class="how" href="/">← the page</a><h1>${esc(p.title)}</h1>`
    + (opts.moved ? `<p class="flash no" role="status" data-moved>The log changed since you opened this, so nothing was written. This is what tira says now.</p>` : "")
    + `<section class="tira-says" aria-label="What tira says (read-only)" data-tira-says><h2>What tira says</h2><ul>${p.lines.map((l) => `<li>${esc(l)}</li>`).join("")}${opts.blockedWhy !== undefined ? `<li>Blocked because: ${esc(opts.blockedWhy)}</li>` : ""}</ul><p class="verdict ${p.ok ? "ok" : "no"}">${esc(p.verdict)}</p></section>`
    + `<section aria-label="What you decide"><h2>What you decide</h2>${form}</section></main></body></html>\n`;
}

const flashFor = (event: string, id: string, r: WriteResult): { ok: boolean; text: string } => {
  const label = PAGE_VERBS[event]?.label ?? event;
  if (r.status === "appended") {
    const closes = (r.closedByTira ?? []).map((c) => c.key.replace(/^[^:]+:/, ""));
    return { ok: true, text: `${label} ${id}: done (seq ${r.seq})${r.outcome === "noop" ? ", nothing changed" : ""}.${closes.length > 0 ? ` tira closed ${closes.join(", ")}, citing it.` : ""}` };
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
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    if (!LOCAL_HOST.test(host)) return send(res, 403, "text/plain; charset=utf-8", "tira serve answers on 127.0.0.1 only\n");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/") {
      const { events, r, hash } = await now();
      const rk = url.searchParams.get("r") ?? "";
      const flash = flashes.get(rk);
      flashes.delete(rk); // a result shows once
      return send(res, 200, "text/html; charset=utf-8", renderHtml(r, opts.stream, hash, events, { live: flash ? { flash } : {} }));
    }
    if (req.method === "GET" && ASSETS[url.pathname] !== undefined) return send(res, 200, "text/javascript; charset=utf-8", ASSETS[url.pathname] as string);
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const { r } = await now();
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(taskIndex(r, opts.stream)));
    }
    if (req.method === "GET" && url.pathname === "/confirm") {
      const type = url.searchParams.get("type") ?? "node";
      const id = url.searchParams.get("id") ?? "";
      const event = url.searchParams.get("event") ?? "";
      const { events, r } = await now();
      const p = await packetFor(previews, r, opts.registry, opts.stream, opts.actor, type, id, event);
      // why it is blocked: the block that started the current stretch, among the events
      // replay applied (the same reading as the page's needs-attention section)
      const skip = new Set(r.anomalies.map((a) => a.seq));
      const stretch = event === "UNBLOCK" ? attentionSince(events, opts.stream, skip).blocked.get(entityKey({ type, id })) : undefined;
      const blockedWhy = stretch === undefined ? undefined : stretch.reason?.trim() ? stretch.reason : "(no reason given)";
      return send(res, p.ok ? 200 : 409, "text/html; charset=utf-8", confirmPage(p, { type, id, event, token, moved: url.searchParams.get("moved") === "1", ...(blockedWhy === undefined ? {} : { blockedWhy }) }));
    }
    if (req.method === "POST" && url.pathname === "/act") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, "text/plain; charset=utf-8", "cross-origin writes are refused\n");
      let form: URLSearchParams;
      try { form = new URLSearchParams(await readBody(req)); } catch { return send(res, 413, "text/plain; charset=utf-8", "too large\n"); }
      if (!safeEqual(form.get("token") ?? "", token)) return send(res, 403, "text/plain; charset=utf-8", "missing or wrong token\n");
      const type = form.get("type") ?? "";
      const id = form.get("id") ?? "";
      const event = form.get("event") ?? "";
      const verb = PAGE_VERBS[event];
      if (!verb || !opts.registry.get(type)?.tree || id === "") return send(res, 400, "text/plain; charset=utf-8", "the page can only start, unblock, complete or block a task\n");
      const payload: Record<string, unknown> = {};
      if (verb.field) {
        const v = form.get(verb.field.name);
        if (v !== null) payload[verb.field.name] = v;
      }
      // decided on one log, written on another? show the packet again instead
      // (a post without `seen` didn't come from a confirm page: it gets one first)
      const seen = form.get("seen");
      if (seen !== String((await now()).r.lastSeq)) {
        return send(res, 303, "text/plain; charset=utf-8", "", { Location: `/confirm?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&event=${encodeURIComponent(event)}${seen === null ? "" : "&moved=1"}` });
      }
      const cmd: Command = { stream: opts.stream, kind: "event", entity: { type, id }, event, actor: opts.actor, payload };
      let flash: { ok: boolean; text: string };
      try {
        flash = flashFor(event, id, (await dispatcher.submit(cmd)).result);
      } catch (err) {
        flash = { ok: false, text: `${verb.label} ${id}: not sent (${(err as Error).message}).` };
      }
      const key = String(++flashSeq);
      flashes.set(key, flash);
      if (flashes.size > 50) flashes.delete(flashes.keys().next().value as string);
      return send(res, 303, "text/plain; charset=utf-8", "", { Location: `/?r=${key}` });
    }
    return send(res, 404, "text/plain; charset=utf-8", "not found\n");
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, "text/plain; charset=utf-8", `tira serve: ${(err as Error).message}\n`));
  });
  return Object.assign(server, { token });
}
