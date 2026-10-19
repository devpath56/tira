// D1 — the thin, read-only HTML page: the fold's tree with cursor, active task and
// drain flags. Static (no JS, no server): re-run `tira render` and reload to refresh.
// Deterministic: the same fold renders the same bytes. Every node carries data-*
// attributes and the page carries the `tira dump --hash`, so manual test M1 can check
// the page against the dump node-for-node. Parents tira closed carry a quiet mark, and
// every node opens to its own event trail (ruling 2026-10-18: the machine is never invisible).
import type { FoldResult, Rejection } from "../fold/fold.ts";
import { MACHINE_ACTOR, type EntityState } from "../fold/types.ts";
import { REJECTED, type EventData, type RejectedData } from "../fold/events.ts";
import type { StoredEvent } from "../store/types.ts";
import { flatten, streamView, type TreeRow } from "./tree-view.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#ffffff;
--unstarted:#8a8a84;--in_progress:#b45309;--blocked:#b91c1c;--done:#15803d;--cancelled:#6b6b66;
--cursor:#1d4ed8;--active:#b45309;--chip:#f1f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--card:#1e1e1b;
--unstarted:#a3a29b;--in_progress:#f59e0b;--blocked:#f87171;--done:#4ade80;--cancelled:#a3a29b;
--cursor:#93b4ff;--active:#f59e0b;--chip:#2a2926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.meta{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;padding:0;list-style:none}
.chips li{background:var(--chip);border-radius:999px;padding:3px 10px;font-size:13px}
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree ul{margin-left:14px;padding-left:12px;border-left:1px solid var(--line)}
.node{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;border-radius:8px}
.node .id{font-weight:600}
.state{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.s-unstarted{color:var(--unstarted)}.s-in_progress{color:var(--in_progress)}.s-blocked{color:var(--blocked)}
.s-done{color:var(--done)}.s-cancelled{color:var(--cancelled);text-decoration:line-through}
.tag{font-size:12px;color:var(--muted)}
.is-cursor{outline:2px solid var(--cursor);background:var(--card)}
.is-active{box-shadow:inset 3px 0 0 var(--active)}
.mark{font-size:12px;font-weight:600}.mark.cursor{color:var(--cursor)}.mark.active{color:var(--active)}
.mark.drained{color:var(--done)}.mark.tira{color:var(--muted);font-weight:500;font-style:italic}
details.trail{flex-basis:100%;font-size:12px;color:var(--muted);margin:2px 0 0}
details.trail summary{cursor:pointer;width:max-content}
details.trail ol{margin:4px 0 2px;padding-left:20px}details.trail li{margin:1px 0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:10px}
.empty{color:var(--muted)}
`;

// One line per event that touched a node, oldest first (incl. refused commands).
function trails(events: readonly StoredEvent[], stream: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, line: string) => out.set(key, [...(out.get(key) ?? []), line]);
  // tira's lines cite the move by its seq, so the reader can find it in the other trail
  const seqOf = new Map(events.filter((e) => e.stream === stream).map((e) => [e.eventId, e.seq]));
  const cites = (trigger: unknown) => {
    if (typeof trigger !== "string" || trigger.length === 0) return "cites nothing";
    const seq = seqOf.get(trigger);
    return seq === undefined ? `cites ${trigger} (not in this stream)` : `cites seq ${seq}`;
  };
  for (const e of events) {
    if (e.stream !== stream) continue;
    const who = e.metadata.actor ?? "—";
    if (e.type === REJECTED) {
      const d = e.data as unknown as RejectedData;
      if (!d?.intent?.entity) continue;
      const what = d.intent.kind === "create" ? "create" : d.intent.event;
      add(`${d.intent.entity.type}:${d.intent.entity.id}`, `seq ${e.seq} · refused ${what} · ${who} · ${d.reason?.code}: ${d.reason?.detail}`);
      continue;
    }
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const type = e.type.slice(0, e.type.indexOf("."));
    const p = d.payload ?? {};
    const detail = who === MACHINE_ACTOR
      ? `${String(p.reason ?? "")} · ${cites(p.trigger)}`
      : Object.keys(p).length > 0 ? JSON.stringify(p) : "";
    add(`${type}:${d.entity.id}`, `seq ${e.seq} · ${e.type} · ${who}${detail ? ` · ${detail}` : ""}`);
  }
  return out;
}

function nodeHtml(r: TreeRow, trail: Map<string, string[]>): string {
  const cls = ["node", r.cursor ? "is-cursor" : "", r.active ? "is-active" : ""].filter(Boolean).join(" ");
  const marks = [
    r.cursor ? `<span class="mark cursor">◆ cursor</span>` : "",
    r.active ? `<span class="mark active">● active</span>` : "",
    r.drained ? `<span class="mark drained">drained</span>` : "",
    r.closedByTira ? `<span class="mark tira">closed by tira</span>` : "",
    r.awaitingClose ? `<span class="tag">tira closes it when you move on</span>` : "",
    r.discoveredDuring ? `<span class="tag">found during ${esc(r.discoveredDuring.replace(/^[^:]+:/, ""))}</span>` : "",
  ].filter(Boolean).join("");
  const lines = trail.get(r.key) ?? [];
  const history = lines.length > 0
    ? `<details class="trail"><summary>history (${lines.length})</summary><ol>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></details>`
    : "";
  const kids = r.children.length > 0 ? `<ul>${r.children.map((c) => nodeHtml(c, trail)).join("")}</ul>` : "";
  return `<li><div class="${cls}" data-key="${esc(r.key)}" data-state="${esc(r.state)}" data-drained="${r.drained}" data-cursor="${r.cursor}" data-active="${r.active}" data-depth="${r.depth}" data-closed-by-tira="${r.closedByTira}" data-awaiting-close="${r.awaitingClose}" data-history="${lines.length}">`
    + `<span class="id">${esc(r.id)}</span><span class="state s-${esc(r.state)}">${esc(r.state.replace("_", " "))}</span>${marks}${history}</div>${kids}</li>`;
}

function rejectionsHtml(rows: Rejection[]): string {
  if (rows.length === 0) return `<p class="empty">None.</p>`;
  const cmd = (x: Rejection) => (x.intent.kind === "create" ? `create ${x.intent.entity.type}:${x.intent.entity.id}` : `${x.intent.event} ${x.intent.entity.type}:${x.intent.entity.id}`);
  return `<div class="scroll"><table><thead><tr><th>seq</th><th>command</th><th>code</th><th>detail</th></tr></thead><tbody>`
    + rows.map((x) => `<tr><td>${x.seq}</td><td>${esc(cmd(x))}</td><td>${esc(x.code)}</td><td>${esc(x.detail)}</td></tr>`).join("")
    + `</tbody></table></div>`;
}

function othersHtml(rows: EntityState[]): string {
  if (rows.length === 0) return "";
  return `<h2>Other entities</h2><div class="scroll"><table><thead><tr><th>key</th><th>state</th><th>last seq</th></tr></thead><tbody>`
    + rows.map((e) => `<tr><td>${esc(e.key)}</td><td>${esc(Object.entries(e.regions).map(([k, v]) => (Object.keys(e.regions).length === 1 ? v : `${k}=${v}`)).join(" "))}</td><td>${e.lastSeq}</td></tr>`).join("")
    + `</tbody></table></div>`;
}

export function renderHtml(r: FoldResult, stream: string, dumpHash: string, events: readonly StoredEvent[] = []): string {
  const v = streamView(r, stream);
  const rejections = r.rejections.filter((x) => x.stream === stream);
  const anomalies = r.anomalies.filter((a) => a.stream === stream);
  const chips = [
    `${v.nodeCount} node${v.nodeCount === 1 ? "" : "s"}`,
    `cursor: ${v.cursor ? v.cursor.replace(/^[^:]+:/, "") : "—"}`,
    `active: ${v.active.map((k) => k.replace(/^[^:]+:/, "")).join(", ") || "—"}`,
    `${flatten(v.roots).filter((x) => x.drained).length} drained`,
    `${flatten(v.roots).filter((x) => x.closedByTira).length} closed by tira`,
    `${rejections.length} rejected`,
    ...(anomalies.length > 0 ? [`${anomalies.length} anomalies`] : []),
  ];
  const trail = trails(events, stream);
  const tree = v.roots.length > 0 ? `<ul class="tree">${v.roots.map((n) => nodeHtml(n, trail)).join("")}</ul>` : `<p class="empty">No tree yet.</p>`;
  // Counted from the fold, independently of the rendered rows: M1 compares the two.
  const foldTreeCount = r.entities.filter((e) => e.stream === stream && e.tree !== undefined).length;
  const anomalyHtml = anomalies.length === 0 ? "" : `<h2>Anomalies</h2><div class="scroll"><table><thead><tr><th>seq</th><th>type</th><th>problem</th></tr></thead><tbody>`
    + anomalies.map((a) => `<tr><td>${a.seq}</td><td>${esc(a.type)}</td><td>${esc(a.problem)}</td></tr>`).join("") + `</tbody></table></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tira · ${esc(stream)}</title><style>${CSS}</style></head>
<body><main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}">
<h1>tira · ${esc(stream)}</h1>
<p class="meta">Folded to seq ${v.lastSeq} · read-only render of the replayed log · <code>sha256:${esc(dumpHash)}</code> (matches <code>tira dump --hash</code>)</p>
<ul class="chips">${chips.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<h2>Tree</h2>${tree}
<div class="legend"><span><span class="mark cursor">◆ cursor</span> next task to work on: first open leaf, depth-first</span><span><span class="mark active">● active</span> in progress, nothing in progress below</span><span><span class="mark drained">drained</span> every child done or cancelled</span><span><span class="mark tira">closed by tira</span> tira wrote the completion when work moved on (see its history)</span></div>
<h2>Rejected commands</h2>${rejectionsHtml(rejections)}
${anomalyHtml}${othersHtml(v.others)}
</main></body></html>
`;
}
