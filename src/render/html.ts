// D1: the read-only HTML page. Two views of the same fold: a living tree (branches
// grow, finished tasks bloom, tira's closes carry a leaf) and a board (status columns,
// minimal cards). Words live in a drawer that opens when you click a task: its state,
// marks and full event history. Tabs and drawers are CSS only (radio inputs and
// :target), so the page needs no JS and nothing from the network: re-run `tira render`
// and reload to refresh. Motion is CSS only and off for reduced motion and for print.
// Deterministic: the same fold renders the same bytes. Each tree node carries data-*
// attributes once (on its tree-view glyph) and the page carries the `tira dump --hash`,
// so manual test M1 can check the page against the dump node-for-node. Parents tira
// closed carry a leaf, and every node is one click from its event trail (ruling
// 2026-10-18: the machine is never invisible).
import type { FoldResult, Rejection } from "../fold/fold.ts";
import { MACHINE_ACTOR, type EntityState } from "../fold/types.ts";
import { REJECTED, type EventData, type RejectedData } from "../fold/events.ts";
import type { StoredEvent } from "../store/types.ts";
import { flatten, streamView, type TreeRow } from "./tree-view.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bare = (key: string) => key.replace(/^[^:]+:/, "");
// The node table's closed states (its tree config's terminal list), for progress.
const CLOSED = new Set(["done", "cancelled"]);
const fx = (n: number) => n.toFixed(1);
// Tree labels stay inside their column; the SVG title, aria-label and drawer keep the full id.
const MAX_LABEL = 22;
const short = (id: string) => ([...id].length > MAX_LABEL ? `${[...id].slice(0, MAX_LABEL - 1).join("")}…` : id);

// Palette from Sylva (moss, petal, pollen) with GSAP's lime as the one accent.
const CSS = `
:root{color-scheme:light dark;
--bg1:#eef1e8;--bg2:#e3e8dc;--panel:#ffffff;--panel-2:#f4f6f1;--line:#dde3d6;--fg:#141a16;--mut:#56625a;--dim:#5f6a63;
--moss:#5b7a3d;--moss-2:#5f8239;--petal:#fffaf0;--petal-edge:#a8946a;--pollen:#8f6700;--lime:#376b0b;--lime-bg:#e8f5d3;
--prog:#1f5fcc;--prog-bg:#e4edff;--block:#b42318;--block-bg:#fde8e5;--done:#2c7a45;--done-bg:#e2f3e6;--gone:#69736c;
--r-lg:16px;--r:11px;--ease:cubic-bezier(.2,.8,.2,1);
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg1:#242b26;--bg2:#121513;--panel:#171c19;--panel-2:#1d241f;--line:#29322c;--fg:#f4efe2;--mut:#a9b3aa;--dim:#8d978f;
--moss:#58773f;--moss-2:#7f9f5a;--petal:#f6eedf;--petal-edge:#d9ccb0;--pollen:#e7c35f;--lime:#c4f26a;--lime-bg:rgba(196,242,106,.10);
--prog:#9bbcff;--prog-bg:rgba(120,160,255,.14);--block:#ff9b8f;--block-bg:rgba(255,120,105,.14);--done:#8fdca5;--done-bg:rgba(110,210,140,.12);--gone:#939d95}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--fg);font:14px/1.45 var(--sans);background:radial-gradient(1100px 620px at 72% 18%,var(--bg1),var(--bg2));background-color:var(--bg2)}
main{max-width:1180px;margin:0 auto;padding:18px 16px 56px;position:relative}
a{color:inherit;text-decoration:none}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:17px;letter-spacing:-.02em}
.brand svg{width:22px;height:22px;color:var(--lime)}
.tabs{display:flex;gap:2px;border:1px solid var(--line);border-radius:10px;padding:3px;background:var(--panel-2)}
.tabs label{cursor:pointer;font-weight:600;font-size:13px;padding:5px 12px;border-radius:7px;color:var(--mut)}
.view-radio{position:absolute;opacity:0;pointer-events:none}
#v-tree:checked~main .tabs label[for=v-tree],#v-board:checked~main .tabs label[for=v-board],#v-lanes:checked~main .tabs label[for=v-lanes],#v-log:checked~main .tabs label[for=v-log]{background:var(--panel);color:var(--fg);box-shadow:0 1px 0 var(--line)}
#v-tree:focus-visible~main .tabs label[for=v-tree],#v-board:focus-visible~main .tabs label[for=v-board],#v-lanes:focus-visible~main .tabs label[for=v-lanes],#v-log:focus-visible~main .tabs label[for=v-log]{outline:2px solid var(--lime);outline-offset:1px}
.verify{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:var(--panel-2);white-space:nowrap}
.hero{display:flex;align-items:flex-end;gap:16px 22px;flex-wrap:wrap;margin:26px 0 8px}
.big{font-size:clamp(64px,13vw,118px);font-weight:800;letter-spacing:-.06em;line-height:.82;font-variant-numeric:tabular-nums}
.big small{font-size:.36em;color:var(--mut);letter-spacing:-.03em}
.who{padding-bottom:6px;min-width:0}
.who h1{margin:0;font-size:24px;letter-spacing:-.03em;font-weight:720;overflow-wrap:anywhere}
.stats{display:flex;gap:6px 16px;flex-wrap:wrap;margin:6px 0 0;padding:0;list-style:none;color:var(--mut);font-size:13px}
.stats li{display:inline-flex;align-items:center;gap:6px}
.stats svg{width:15px;height:15px}
.stats b{color:var(--fg);font-weight:700;font-variant-numeric:tabular-nums}
.stats .warn,.stats .warn b{color:var(--block)}
.view{display:none;margin-top:14px;animation:fade .45s var(--ease) both}
#v-tree:checked~main .view-tree,#v-board:checked~main .view-board,#v-lanes:checked~main .view-lanes,#v-log:checked~main .view-log{display:block}
.lanes{display:grid;grid-template-columns:minmax(90px,.8fr) repeat(var(--n),minmax(120px,1fr));gap:6px;align-items:center;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:10px 12px;overflow-x:auto}
.lanes .lh{font-size:11.5px;font-weight:650;color:var(--dim);padding:0 4px 4px}
.lanes .who{font-weight:650;overflow-wrap:anywhere;padding:4px}.lanes .who.old{color:var(--dim);text-decoration:line-through}
.lane{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:10px;background:var(--panel);border:1px solid var(--line);min-height:36px;animation:fade .45s var(--ease) both}
.pill{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--panel-2);color:var(--mut);white-space:nowrap}
.pill.go{color:var(--done);background:var(--done-bg)}.pill.work{color:var(--prog);background:var(--prog-bg)}.pill.stop{color:var(--block);background:var(--block-bg)}.pill.wait{color:var(--pollen);background:transparent;box-shadow:inset 0 0 0 1px var(--pollen)}
.cap{font-size:11.5px;color:var(--mut);display:inline-flex;align-items:center;gap:4px}
.cap .av{width:18px;height:18px;font-size:10px}
.chips2{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0}
.pairs{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}
.pairs li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:7px 10px}
.pairs .arrow{color:var(--lime);font-weight:700}.pairs code{font-family:var(--mono);font-size:11.5px;color:var(--fg)}
.pairs li.waiting{border-style:dashed}
@keyframes fade{from{opacity:.3;transform:translateY(6px)}}
.stage{overflow-x:auto;padding:4px 0 8px;scrollbar-width:thin}
svg.tree{display:block;height:auto;overflow:visible}
.branch{fill:none;stroke:var(--moss);stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:grow 1.1s cubic-bezier(.3,.7,.2,1) forwards}
@keyframes grow{to{stroke-dashoffset:0}}
.tnode{animation:pop .6s cubic-bezier(.3,1.5,.4,1) both;transform-box:fill-box;transform-origin:center}
@keyframes pop{from{opacity:.3;transform:scale(.4)}}
a.tlink:focus-visible{outline:none}a.tlink:focus-visible .lbl{fill:var(--lime);text-decoration:underline}
a.tlink:hover .lbl{fill:var(--fg)}
.lbl{fill:var(--mut);font-size:13px;font-weight:600}
.lbl.on{fill:var(--fg)}.lbl.gone{text-decoration:line-through;fill:var(--dim)}
.petal{fill:var(--petal);stroke:var(--petal-edge);stroke-width:1}.core{fill:var(--pollen)}
.bud{fill:var(--panel);stroke:var(--moss-2);stroke-width:2}
.bud.blocked{stroke:var(--block)}.x{stroke:var(--block);stroke-width:2;stroke-linecap:round}
.grow{fill:var(--lime)}.halo{fill:none;stroke:var(--lime);stroke-width:2;animation:breathe 2.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes breathe{50%{transform:scale(1.4);opacity:.2}}
.wait{fill:none;stroke:var(--pollen);stroke-width:1.6;stroke-dasharray:3 3}
.fallen{fill:var(--gone);opacity:.75}
.tira-leaf{fill:none;stroke:var(--lime);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.next{fill:var(--lime);font-size:11px;font-weight:700}
.key{display:flex;gap:8px 18px;flex-wrap:wrap;color:var(--mut);font-size:12.5px;margin:6px 2px 0}
.key span{display:inline-flex;align-items:center;gap:6px}.key svg{width:18px;height:18px;overflow:visible}
.strip{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.br{display:flex;align-items:center;gap:10px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:9px 12px;min-width:200px;flex:1 1 200px;transition:transform .25s var(--ease)}
.br:hover{transform:translateY(-2px)}
.br .nm{font-weight:650;overflow-wrap:anywhere}.br svg{width:15px;height:15px;color:var(--lime);flex:none}
.meter{flex:1;min-width:40px;height:5px;border-radius:9px;background:var(--line);overflow:hidden;display:flex}.meter i{display:block;height:100%}
.m-done{background:var(--done)}.m-cancelled{background:var(--gone)}.m-in_progress{background:var(--prog)}.m-blocked{background:var(--block)}
.ct{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;align-items:start}
.col{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:10px}
.ch{display:flex;align-items:center;gap:8px;padding:2px 4px 10px;font-weight:650;font-size:13px}
.dot{width:8px;height:8px;border-radius:9px}.ch .k{color:var(--mut);font-weight:600;background:var(--panel);border-radius:6px;padding:0 7px;font-size:12px}
.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:11px 12px;margin-bottom:8px;transition:transform .25s var(--ease),border-color .2s;animation:fade .5s var(--ease) both}
.card:hover{transform:translateY(-2px);border-color:var(--moss-2)}.card:focus-visible,.br:focus-visible{outline:2px solid var(--lime);outline-offset:2px}
.card .t{font-weight:650;font-size:14.5px;overflow-wrap:anywhere}
.card .row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:9px;color:var(--mut);font-size:12px}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--panel-2);border-radius:6px;padding:1px 7px;font-size:11.5px;color:var(--mut);overflow-wrap:anywhere}
.hist{margin-left:auto;display:inline-flex;align-items:center;gap:3px}.hist svg,.chip svg{width:12px;height:12px}
.pin{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:var(--lime);background:var(--lime-bg);border-radius:6px;padding:1px 7px;margin-bottom:7px}
.card.is-next{border-color:var(--lime);box-shadow:0 0 0 3px var(--lime-bg)}
.card.is-gone .t{text-decoration:line-through;color:var(--dim)}
.empty{color:var(--dim);font-size:13px;padding:6px 4px;margin:0}
.drawer{position:fixed;top:12px;right:12px;bottom:12px;width:min(380px,calc(100vw - 24px));background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px 18px 22px;overflow-y:auto;visibility:hidden;transform:translateX(calc(100% + 24px));transition:transform .45s var(--ease),visibility 0s .45s;box-shadow:0 24px 70px rgba(0,0,0,.28);z-index:10}
.drawer:target{visibility:visible;transform:none;transition:transform .45s var(--ease)}
.drawer .close{position:absolute;right:12px;top:10px;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;color:var(--mut);font-size:18px}
.drawer .close:hover{background:var(--panel-2);color:var(--fg)}.drawer .close:focus-visible{outline:2px solid var(--lime);outline-offset:1px;color:var(--fg)}
.drawer h2{margin:6px 0 2px;font-size:24px;letter-spacing:-.03em;overflow-wrap:anywhere;padding-right:30px}
.path{color:var(--mut);font-size:12.5px;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.state{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 9px;border-radius:999px}
.s-unstarted{color:var(--mut);background:var(--panel-2)}.s-in_progress{color:var(--prog);background:var(--prog-bg)}.s-blocked{color:var(--block);background:var(--block-bg)}
.s-done{color:var(--done);background:var(--done-bg)}.s-cancelled{color:var(--gone);background:var(--panel-2)}
.mark{font-size:11.5px;font-weight:650;padding:2px 9px;border-radius:999px;background:var(--panel-2);color:var(--mut)}
.mark.cursor{color:var(--lime);background:var(--lime-bg)}.mark.active{color:var(--prog);background:var(--prog-bg)}
.mark.tira{color:var(--lime);background:var(--lime-bg)}.mark.wait{color:var(--pollen)}
.kids{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--mut);font-size:12.5px}
details.trail{margin-top:16px}details.trail summary{cursor:pointer;color:var(--dim);font-size:12px;font-weight:650;min-height:24px}
.feed{list-style:none;margin:8px 0 0;padding:0;position:relative}
.feed::before{content:"";position:absolute;left:11px;top:6px;bottom:6px;width:1px;background:var(--line)}
.ev{position:relative;display:flex;gap:10px;padding:5px 0}
.av{position:relative;z-index:1;flex:none;width:23px;height:23px;border-radius:999px;display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--fg);background:var(--panel-2);border:1px solid var(--line)}
.ev.tira .av{color:var(--lime);background:var(--lime-bg);border-color:transparent}.av svg{width:13px;height:13px}
.ev.refused .av{color:var(--block);background:var(--block-bg);border-color:transparent}
.ev-body{min-width:0;padding-top:2px}
.ev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px}
.ev-what{font-family:var(--mono);font-size:12px}.ev.refused .ev-what{color:var(--block)}
.ev-who{font-weight:650;font-size:13px}.ev-task{font-weight:650;font-size:13px;color:var(--fg)}
.ev-seq{font-family:var(--mono);font-size:11px;color:var(--dim)}
.ev-detail{color:var(--mut);font-size:12.5px;overflow-wrap:anywhere;margin-top:1px}
.log{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:6px 16px 14px}
.log h3{font-size:12px;color:var(--dim);font-weight:650;margin:14px 0 0;letter-spacing:.02em}
.hash{font-family:var(--mono);font-size:12px;color:var(--mut);word-break:break-all}
.others{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.alert{border:1px solid var(--block);border-radius:var(--r);padding:8px 12px;margin:12px 0 0;color:var(--block);font-size:13px}
.pollen{position:absolute;width:4px;height:4px;border-radius:9px;background:var(--pollen);opacity:.35;animation:drift 13s ease-in-out infinite;pointer-events:none}
@keyframes drift{50%{transform:translate(36px,-54px)}}
@media (max-width:560px){.big{font-size:64px}.verify{margin-left:0}.lanes{grid-template-columns:1fr;overflow:visible}.lanes .lh{display:none}.lanes .who{padding-top:10px}.lane::before{content:attr(data-region);font-size:11px;color:var(--dim);min-width:52px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.branch{stroke-dashoffset:0}}
@media print{:root{--bg1:#eef1e8;--bg2:#e3e8dc;--panel:#ffffff;--panel-2:#f4f6f1;--line:#dde3d6;--fg:#141a16;--mut:#56625a;--dim:#5f6a63;--moss:#5b7a3d;--moss-2:#5f8239;--petal:#fffaf0;--petal-edge:#a8946a;--pollen:#8f6700;--lime:#376b0b;--lime-bg:#e8f5d3;--prog:#1f5fcc;--prog-bg:#e4edff;--block:#b42318;--block-bg:#fde8e5;--done:#2c7a45;--done-bg:#e2f3e6;--gone:#69736c;}*,*::before,*::after{animation:none!important;transition:none!important}.branch{stroke-dashoffset:0}body{background:#fff}.view{display:block!important}.drawer{display:none}.stage{overflow:visible}svg.tree{max-width:100%;height:auto}}
`;

const ICON = {
  brand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V11"/><path d="M12 13c-4.2 0-7-2.6-7-7 4.2 0 7 2.6 7 7z"/><path d="M12 11c0-3.7 2.4-6 6.5-6 0 3.7-2.4 6-6.5 6z"/></svg>`,
  leaf: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12.5c0-5 3-8.5 9-9-.4 6-4 9-9 9z"/><path d="M3.5 12.5l4.5-4.5"/></svg>`,
  history: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.5 2.5v2.4h2.4"/><path d="M8 5.2V8l2 1.3"/></svg>`,
  ban: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>`,
  alert: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>`,
  spark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2v4M8 10v4M2 8h4M10 8h4"/></svg>`,
};

// ---------- glyphs (tree view), drawn at (x, y) ----------

const blossom = (x: number, y: number, s: number) =>
  `<g transform="translate(${fx(x)} ${fx(y)}) scale(${s})"><circle class="petal" cx="0" cy="-11" r="8"/><circle class="petal" cx="10.5" cy="-3.4" r="8"/><circle class="petal" cx="6.5" cy="9" r="8"/><circle class="petal" cx="-6.5" cy="9" r="8"/><circle class="petal" cx="-10.5" cy="-3.4" r="8"/><circle class="core" r="5"/></g>`;

function glyph(r: TreeRow, x: number, y: number): string {
  const parent = r.children.length > 0;
  const size = parent ? 1 : 0.68;
  switch (r.state) {
    case "done": return blossom(x, y, size);
    case "cancelled": return `<ellipse class="fallen" cx="${fx(x)}" cy="${fx(y + 3)}" rx="7" ry="4" transform="rotate(25 ${fx(x)} ${fx(y + 3)})"/>`;
    case "in_progress": // the halo marks the active task only (in progress, nothing in progress below)
      return `${r.active ? `<circle class="halo" cx="${fx(x)}" cy="${fx(y)}" r="${parent ? 17 : 14}"/>` : ""}<circle class="grow" cx="${fx(x)}" cy="${fx(y)}" r="${parent ? 12 : 10}"/><circle class="core" cx="${fx(x)}" cy="${fx(y)}" r="4"/>`;
    case "blocked": return `<circle class="bud blocked" cx="${fx(x)}" cy="${fx(y)}" r="${parent ? 12 : 9}"/><path class="x" d="M${fx(x - 3.5)} ${fx(y - 3.5)}l7 7m0-7l-7 7"/>`;
    default: return `<circle class="bud" cx="${fx(x)}" cy="${fx(y)}" r="${parent ? 12 : 9}"/>`;
  }
}

interface Placed { row: TreeRow; x: number; y: number; i: number; parent?: Placed }

// Tidy left-to-right layout: leaves take consecutive rows, a parent sits midway between
// its first and last child. Preorder index `i` names drawers and staggers the motion.
function layout(roots: TreeRow[]): { nodes: Placed[]; width: number; height: number } {
  const COL = 220, ROW = 58, X0 = 34, Y0 = 34;
  const nodes: Placed[] = [];
  let slot = 0;
  let deepest = 1;
  const place = (r: TreeRow, depth: number, parent?: Placed): Placed => {
    const p: Placed = { row: r, x: X0 + (depth - 1) * COL, y: 0, i: nodes.length, ...(parent ? { parent } : {}) };
    nodes.push(p);
    deepest = Math.max(deepest, depth);
    if (r.children.length === 0) p.y = Y0 + slot++ * ROW;
    else {
      const kids = r.children.map((c) => place(c, depth + 1, p));
      p.y = ((kids[0] as Placed).y + (kids.at(-1) as Placed).y) / 2;
    }
    return p;
  };
  roots.forEach((r, n) => {
    place(r, 1);
    if (n < roots.length - 1) slot += 0.6; // a little air between trees
  });
  return { nodes, width: X0 + (deepest - 1) * COL + 230, height: Y0 + Math.max(slot - 1, 0) * ROW + 70 };
}

function treeSvg(roots: TreeRow[], trail: Map<string, TrailEntry[]>): string {
  const { nodes, width, height } = layout(roots);
  const branches = nodes.filter((n) => n.parent).map((n) => {
    const p = n.parent as Placed;
    const mid = (p.x + n.x) / 2;
    const w = Math.max(3, 10 - 2 * (n.row.depth - 1));
    return `<path class="branch" pathLength="1" style="stroke-width:${w};animation-delay:${fx((n.row.depth - 2) * 0.22)}s" d="M${fx(p.x)} ${fx(p.y)} C${fx(mid)} ${fx(p.y)} ${fx(mid)} ${fx(n.y)} ${fx(n.x)} ${fx(n.y)}"/>`;
  }).join("");
  const glyphs = nodes.map((n) => {
    const r = n.row;
    const parent = r.children.length > 0;
    const lines = trail.get(r.key) ?? [];
    // Leaves label to the right; parents label below (the root starts at the left edge).
    const lx = parent ? (r.depth === 1 ? n.x - 12 : n.x) : n.x + 18;
    const ly = parent ? n.y + 32 : n.y + 4.5;
    const anchor = parent ? (r.depth === 1 ? "start" : "middle") : "start";
    const lcls = ["lbl", r.cursor || r.active || r.depth === 1 ? "on" : "", r.state === "cancelled" ? "gone" : ""].filter(Boolean).join(" ");
    const extras = [
      r.awaitingClose ? `<circle class="wait" cx="${fx(n.x)}" cy="${fx(n.y)}" r="${parent ? 18 : 15}"><title>tira closes it when you move on</title></circle>` : "",
      r.closedByTira ? `<path class="tira-leaf" d="M${fx(n.x + 12)} ${fx(n.y - 14)}c0-7 4-11 11-12-.5 7-4 11-11 12z"><title>closed by tira</title></path>` : "",
      r.cursor ? `<text class="next" x="${fx(lx)}" y="${fx(ly + 16)}" text-anchor="${anchor}">◆ ${r.active ? "now" : "next"}</text>` : "",
    ].join("");
    const found = r.discoveredDuring ? ` ✦` : "";
    const label = `${r.id}, ${r.state.replace("_", " ")}${r.cursor ? ", next" : ""}${r.closedByTira ? ", closed by tira" : ""}`;
    return `<a class="tlink" href="#t${n.i}" aria-label="${esc(label)}"><g class="tnode" style="animation-delay:${fx(0.15 + (r.depth - 1) * 0.22)}s" data-key="${esc(r.key)}" data-state="${esc(r.state)}" data-drained="${r.drained}" data-cursor="${r.cursor}" data-active="${r.active}" data-depth="${r.depth}" data-closed-by-tira="${r.closedByTira}" data-awaiting-close="${r.awaitingClose}" data-history="${lines.length}">`
      + `<title>${esc(r.id)}</title>${glyph(r, n.x, n.y)}${extras}<text class="${lcls}" x="${fx(lx)}" y="${fx(ly)}" text-anchor="${anchor}">${esc(short(r.id))}${found}</text></g></a>`;
  }).join("");
  return `<div class="stage"><svg class="tree" width="${width}" height="${fx(height)}" viewBox="0 0 ${width} ${fx(height)}" role="group" aria-label="Task tree">${branches}${glyphs}</svg></div>`;
}

const KEY = `<div class="key" aria-hidden="true">`
  + `<span><svg viewBox="-10 -10 20 20"><circle class="bud" r="6"/></svg>to do</span>`
  + `<span><svg viewBox="-10 -10 20 20"><circle class="grow" r="7"/></svg>in progress</span>`
  + `<span><svg viewBox="-10 -10 20 20"><circle class="bud blocked" r="6"/></svg>blocked</span>`
  + `<span><svg viewBox="-10 -10 20 20">${blossom(0, 0, 0.55)}</svg>done</span>`
  + `<span><svg viewBox="-10 -10 20 20"><ellipse class="fallen" rx="6" ry="3.5" transform="rotate(25)"/></svg>dropped</span>`
  + `<span><svg viewBox="-10 -10 20 20"><circle class="wait" r="7"/></svg>tira will close</span>`
  + `<span><svg viewBox="-2 -2 16 16"><path class="tira-leaf" d="M1 13c0-7 4-11 11-12-.5 7-4 11-11 12z"/></svg>closed by tira</span>`
  + `<span>✦ found along the way</span>`
  + `</div>`;

// ---------- history ----------

interface TrailEntry {
  seq: number;
  key: string; // the task it touched
  what: string; // the event type, or "rejected EVENT"
  actor: string;
  detail: string;
  refused: boolean;
}

// A payload in a few words: "under dashboard", "evidence palette.png", anything else as key value.
function describe(p: Record<string, unknown>): string {
  const words: Record<string, string> = { parent_id: "under", discovered_during: "found during", evidenceRef: "evidence", reason: "reason", blocker: "blocked by" };
  return Object.entries(p)
    .filter(([k, val]) => !(k === "kind" && (val === "discovered" || val === "planned")))
    .map(([k, val]) => `${words[k] ?? k} ${typeof val === "string" ? val : JSON.stringify(val)}`)
    .join(" · ");
}

// One entry per event that touched a node, oldest first (incl. rejected commands).
function trails(events: readonly StoredEvent[], stream: string): { byKey: Map<string, TrailEntry[]>; all: TrailEntry[] } {
  const byKey = new Map<string, TrailEntry[]>();
  const all: TrailEntry[] = [];
  const add = (entry: TrailEntry) => {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
    all.push(entry);
  };
  // tira's lines cite the move by its seq, so the reader can find it in the other trail
  const seqOf = new Map(events.filter((e) => e.stream === stream).map((e) => [e.eventId, e.seq]));
  const cites = (trigger: unknown) => {
    if (typeof trigger !== "string" || trigger.length === 0) return "cites nothing";
    const seq = seqOf.get(trigger);
    return seq === undefined ? `cites ${trigger} (not in this stream)` : `cites seq ${seq}`;
  };
  for (const e of events) {
    if (e.stream !== stream) continue;
    const actor = e.metadata.actor ?? "no actor";
    if (e.type === REJECTED) {
      const d = e.data as unknown as RejectedData;
      if (!d?.intent?.entity) continue;
      const what = d.intent.kind === "create" ? "create" : d.intent.event;
      add({ seq: e.seq, key: `${d.intent.entity.type}:${d.intent.entity.id}`, what: `rejected ${what}`, actor, detail: `${d.reason?.code}: ${d.reason?.detail}`, refused: true });
      continue;
    }
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const type = e.type.slice(0, e.type.indexOf("."));
    const p = d.payload ?? {};
    const detail = actor === MACHINE_ACTOR ? `${String(p.reason ?? "")} · ${cites(p.trigger)}` : describe(p);
    add({ seq: e.seq, key: `${type}:${d.entity.id}`, what: e.type, actor, detail, refused: false });
  }
  return { byKey, all };
}

function entryHtml(x: TrailEntry, withTask = false): string {
  const tira = x.actor === MACHINE_ACTOR;
  const avatar = tira ? ICON.leaf : x.refused ? "!" : esc(([...x.actor][0] ?? "?").toUpperCase());
  const cls = ["ev", tira ? "tira" : "", x.refused ? "refused" : ""].filter(Boolean).join(" ");
  return `<li class="${cls}"><span class="av" aria-hidden="true">${avatar}</span><div class="ev-body">`
    + `<div class="ev-head">${withTask ? `<span class="ev-task">${esc(bare(x.key))}</span>` : ""}<span class="ev-what">${esc(x.what)}</span><span class="ev-who">${esc(x.actor)}</span><span class="ev-seq">seq ${x.seq}</span></div>`
    + (x.detail ? `<div class="ev-detail">${esc(x.detail)}</div>` : "")
    + `</div></li>`;
}

const stateBadge = (state: string) => `<span class="state s-${esc(state)}">${esc(state.replace("_", " "))}</span>`;

function meter(states: string[]): string {
  if (states.length === 0) return `<span class="meter"></span>`;
  const order = ["done", "cancelled", "in_progress", "blocked"];
  return `<span class="meter" aria-hidden="true">${order.map((s) => [s, states.filter((x) => x === s).length] as const).filter(([, n]) => n > 0)
    .map(([s, n]) => `<i class="m-${s}" style="width:${fx((n / states.length) * 100)}%"></i>`).join("")}</span>`;
}

// The drawer for one task: where the words live. Opens via #t<i> (CSS :target).
function drawerHtml(n: Placed, lines: TrailEntry[], path: string): string {
  const r = n.row;
  const marks = [
    r.cursor ? `<span class="mark cursor">◆ next</span>` : "",
    r.active ? `<span class="mark active">● active</span>` : "",
    r.drained ? `<span class="mark drained">drained</span>` : "",
    r.closedByTira ? `<span class="mark tira">closed by tira</span>` : "",
    r.awaitingClose ? `<span class="mark wait">tira closes it when you move on</span>` : "",
    r.discoveredDuring ? `<span class="mark">found during ${esc(bare(r.discoveredDuring))}</span>` : "",
  ].filter(Boolean).join("");
  const closedKids = r.children.filter((c) => CLOSED.has(c.state)).length;
  const kids = r.children.length > 0
    ? `<div class="kids">${meter(r.children.map((c) => c.state))}<span>${closedKids}/${r.children.length} children closed</span></div>`
    : "";
  return `<section class="drawer" id="t${n.i}" aria-label="${esc(r.id)}"><a class="close" href="#_" aria-label="Close">×</a>`
    + `<div class="path">${path}</div><h2>${esc(r.id)}</h2><div class="badges">${stateBadge(r.state)}${marks}</div>${kids}`
    + `<details class="trail" open><summary>history (${lines.length})</summary><ol class="feed">${lines.map((l) => entryHtml(l)).join("")}</ol></details></section>`;
}

// ---------- board ----------

function boardHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>): string {
  const parents = nodes.filter((n) => n.row.children.length > 0);
  const strip = parents.length === 0 ? "" : `<div class="strip">${parents.map((n) => {
    const r = n.row;
    const closedKids = r.children.filter((c) => CLOSED.has(c.state)).length;
    return `<a class="br" href="#t${n.i}">${r.closedByTira ? ICON.leaf : ""}<span class="nm">${esc(r.id)}</span>${meter(r.children.map((c) => c.state))}<span class="ct">${closedKids}/${r.children.length}</span></a>`;
  }).join("")}</div>`;
  const leaves = nodes.filter((n) => n.row.children.length === 0);
  const columns: [string, string, string][] = [
    ["unstarted", "To do", "var(--dim)"], ["in_progress", "In progress", "var(--prog)"], ["blocked", "Blocked", "var(--block)"],
    ["done", "Done", "var(--done)"], ["cancelled", "Dropped", "var(--gone)"],
  ];
  const cols = columns.filter(([s]) => s !== "blocked" || leaves.some((n) => n.row.state === s)).map(([s, title, color]) => {
    const here = leaves.filter((n) => n.row.state === s);
    const cards = here.map((n, k) => {
      const r = n.row;
      const cls = ["card", r.cursor ? "is-next" : "", r.state === "cancelled" ? "is-gone" : ""].filter(Boolean).join(" ");
      const lines = (trail.get(r.key) ?? []).length;
      const parent = n.parent ? `<span class="chip">${esc(n.parent.row.id)}</span>` : "";
      const found = r.discoveredDuring ? `<span class="chip" title="found during ${esc(bare(r.discoveredDuring))}">${ICON.spark}found</span>` : "";
      return `<a class="${cls}" href="#t${n.i}" style="animation-delay:${fx(0.04 * k)}s">${r.cursor ? `<span class="pin">◆ ${r.active ? "now" : "next"}</span>` : ""}<div class="t">${esc(r.id)}</div>`
        + `<div class="row">${parent}${found}<span class="hist" title="history">${ICON.history}${lines}</span></div></a>`;
    }).join("");
    return `<div class="col"><div class="ch"><span class="dot" style="background:${color}"></span>${title}<span class="k">${here.length}</span></div>${cards || `<p class="empty">Nothing here</p>`}</div>`;
  }).join("");
  return `${strip}<div class="cols">${cols}</div>`;
}

// ---------- lanes (D2: regions composed, handoffs paired) ----------

const VIEWS: [string, string][] = [["tree", "Tree"], ["board", "Board"], ["lanes", "Lanes"], ["log", "Activity"]];

// One tone per state family, so a lane reads at a glance; the state word stays as-is.
const TONE: Record<string, string> = {
  gated: "go", "done-verified": "go", verified: "go", live: "go",
  "claimed-active": "work", "claimed-silent": "wait", "dropped-unverified": "wait", filed: "wait",
  denied: "stop", blocked: "stop", rejected: "stop",
};
const pill = (state: string) => `<span class="pill ${TONE[state] ?? ""}">${esc(state)}</span>`;

function lanesHtml(r: FoldResult, stream: string, events: readonly StoredEvent[]): string {
  const inStream = r.entities.filter((e) => e.stream === stream);
  const multi = inStream.filter((e) => Object.keys(e.regions).length > 1);
  const superseded = (e: EntityState) => e.version !== undefined && inStream.some((x) => x.type === e.type && x.id === e.id && x.version === (e.version as number) + 1);
  const avatar = (who: unknown) => `<span class="av" aria-hidden="true">${esc(([...String(who)][0] ?? "?").toUpperCase())}</span>`;
  const rows = multi.map((e, k) => {
    const cells = Object.entries(e.regions).map(([region, state]) => {
      const cap = e.context?.[region] ?? {};
      const extra = [
        cap.claimant !== undefined ? `<span class="cap" title="claimed by ${esc(String(cap.claimant))}">${avatar(cap.claimant)}${esc(String(cap.claimant))}</span>` : "",
        cap.block_reason !== undefined ? `<span class="cap">${esc(String(cap.block_reason))}</span>` : "",
      ].join("");
      return `<div class="lane" style="animation-delay:${fx(0.04 * k)}s" data-lane="${esc(e.key)}" data-region="${esc(region)}" data-state="${esc(state)}">${pill(state)}${extra}</div>`;
    }).join("");
    const label = `${e.id}${e.version === undefined ? "" : `@${e.version}`}`;
    return `<div class="who${superseded(e) ? " old" : ""}" title="${esc(e.key)}${superseded(e) ? " (superseded)" : ""}">${esc(label)}</div>${cells}`;
  }).join("");
  const regionNames = multi[0] ? Object.keys(multi[0].regions) : [];
  const grid = multi.length === 0 ? "" : `<div class="lanes" style="--n:${regionNames.length}" aria-label="Regions"><div class="lh"></div>${regionNames.map((n) => `<div class="lh">${esc(n)}</div>`).join("")}${rows}</div>`;
  const singles = inStream.filter((e) => Object.keys(e.regions).length === 1 && !e.tree);
  const chips = singles.length === 0 ? "" : `<div class="chips2">${singles.map((e) => {
    const name = e.context?.lifecycle?.name;
    return `<span class="chip" title="${esc(e.key)}">${esc(e.type)} ${esc(e.id)}${e.version === undefined ? "" : `@${e.version}`} ${pill(Object.values(e.regions)[0] as string)}${e.createdBy && e.type === "drop" ? ` by ${esc(e.createdBy)}` : ""}${typeof name === "string" ? ` · ${esc(name)}` : ""}</span>`;
  }).join("")}</div>`;
  // Handoff pairs: each first event and the receivers the dispatcher wrote for it,
  // matched by correlation id (the done test: the same id on both sides).
  const mine = events.filter((e) => e.stream === stream);
  const byId = new Map(mine.map((e) => [e.eventId, e]));
  const groups = new Map<string, StoredEvent[]>();
  for (const e of mine) {
    const c = e.metadata.correlationId;
    if (e.metadata.actor === "dispatcher" && c !== undefined) groups.set(c, [...(groups.get(c) ?? []), e]);
  }
  const keyOf = (e: StoredEvent) => {
    const d = e.data as unknown as EventData;
    return d?.entity ? `${e.type.slice(0, e.type.indexOf("."))}:${d.entity.id}${d.entity.version === undefined ? "" : `@${d.entity.version}`}` : e.type;
  };
  const pairs = [...groups.entries()].map(([c, rs]) => {
    const head = byId.get(c);
    const from = head ? `<code>${esc(head.type)}</code> ${esc(keyOf(head))} <span class="ev-seq">seq ${head.seq}</span>` : `<code>${esc(c)}</code>`;
    return `<li data-correlation="${esc(c)}">${from}<span class="arrow">→</span>${rs.map((x) => `<code>${esc(x.type)}</code> ${esc(keyOf(x))} <span class="ev-seq">seq ${x.seq}</span>`).join(" · ")}</li>`;
  });
  const waiting = (r.handoffs[stream] ?? []).map((p) => `<li class="waiting"><code>${esc(p.rule)}</code> ${esc(p.key)} <span class="ev-seq">since seq ${p.since}</span><span class="arrow">…</span>${esc(p.waitingOn)}</li>`);
  const handoffs = pairs.length + waiting.length === 0 ? "" : `<ul class="pairs" aria-label="Handoffs">${[...waiting, ...pairs].join("")}</ul>`;
  if (!grid && !chips && !handoffs) return `<p class="empty">No regions or handoffs in this stream.</p>`;
  return `${grid}${chips}${handoffs}`;
}


// ---------- activity ----------

function logHtml(all: TrailEntry[], anomalies: FoldResult["anomalies"], others: EntityState[], rejections: Rejection[], dumpHash: string): string {
  const alert = anomalies.length === 0 ? "" : `<div class="alert">${anomalies.length} ${anomalies.length === 1 ? "anomaly" : "anomalies"} on replay</div><ol class="feed">${anomalies.map((a) => `<li class="ev refused"><span class="av" aria-hidden="true">!</span><div class="ev-body"><div class="ev-head"><span class="ev-what">${esc(a.type)}</span><span class="ev-seq">seq ${a.seq}</span></div><div class="ev-detail">${esc(a.problem)}</div></div></li>`).join("")}</ol>`;
  const feed = all.length === 0 ? `<p class="empty">No events yet</p>` : `<ol class="feed">${[...all].reverse().map((x) => entryHtml(x, true)).join("")}</ol>`;
  const othersHtml = others.length === 0 ? "" : `<h3>Other entities</h3><div class="others">${others.map((e) => `<span class="chip">${esc(e.key)} · ${esc(Object.values(e.regions).join(" "))}</span>`).join("")}</div>`;
  return `<div class="log">${alert}<h3>Newest first · ${all.length} events · ${rejections.length} rejected</h3>${feed}${othersHtml}<h3>Dump hash</h3><div class="hash">sha256:${esc(dumpHash)}</div></div>`;
}

// ---------- page ----------

export function renderHtml(r: FoldResult, stream: string, dumpHash: string, events: readonly StoredEvent[] = []): string {
  const v = streamView(r, stream);
  events = events.filter((e) => e.seq <= r.lastSeq); // render --at N: no history from after N
  const rejections = r.rejections.filter((x) => x.stream === stream);
  const anomalies = r.anomalies.filter((a) => a.stream === stream);
  const rows = flatten(v.roots);
  const mine = r.entities.filter((e) => e.stream === stream);
  const multiNow = mine.filter((e) => Object.keys(e.regions).length > 1 && !(e.version !== undefined && mine.some((x) => x.type === e.type && x.id === e.id && x.version === (e.version as number) + 1)));
  const { byKey: trail, all } = trails(events, stream);
  const { nodes } = layout(v.roots);
  const pathOf = (n: Placed) => {
    const up: string[] = [];
    for (let p = n.parent; p; p = p.parent) up.unshift(esc(p.row.id));
    return up.length > 0 ? up.join(" › ") : "top level";
  };
  // The header counts what this stream is about: a tree's closed nodes, or (a stream of
  // multi-region entities, like the factory's briefs) the verified ones still current.
  const lanesOnly = v.roots.length === 0 && multiNow.length > 0;
  const closed = lanesOnly ? multiNow.filter((e) => e.regions.outcome === "done-verified").length : rows.filter((x) => CLOSED.has(x.state)).length;
  const total = lanesOnly ? multiNow.length : rows.length;
  const handoffCount = new Set(events.filter((e) => e.stream === stream && e.metadata.actor === "dispatcher" && e.metadata.correlationId).map((e) => e.metadata.correlationId)).size;
  const stats = [
    ...(lanesOnly
      ? [`<li title="handoff pairs the dispatcher completed"><b>${handoffCount}</b> handoffs</li>`, `<li title="handoffs still waiting"><b>${r.handoffs[stream]?.length ?? 0}</b> waiting</li>`]
      : [`<li title="closed by tira">${ICON.leaf}<b>${rows.filter((x) => x.closedByTira).length}</b> by tira</li>`, `<li title="drained: every child done or cancelled"><b>${rows.filter((x) => x.drained).length}</b> drained</li>`]),
    `<li title="rejected commands">${ICON.ban}<b>${rejections.length}</b> rejected</li>`,
    ...(anomalies.length > 0 ? [`<li class="warn" title="replay anomalies">${ICON.alert}<b>${anomalies.length}</b> anomalies</li>`] : []),
  ];
  // Counted from the fold, independently of the rendered rows: M1 compares the two.
  const foldTreeCount = r.entities.filter((e) => e.stream === stream && e.tree !== undefined).length;
  const treeView = v.roots.length > 0 ? `${treeSvg(v.roots, trail)}${KEY}` : `<p class="empty">No tree yet.</p>`;
  // Open on the view that has something: the tree, else the lanes, else the activity.
  const first = v.roots.length > 0 ? "tree" : multiNow.length > 0 || (r.handoffs[stream]?.length ?? 0) > 0 ? "lanes" : "log";
  const shortHash = dumpHash.length > 16 ? `${dumpHash.slice(0, 8)}…${dumpHash.slice(-6)}` : dumpHash;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tira · ${esc(stream)}</title><style>${CSS}</style></head>
<body>${VIEWS.map(([t, label]) => `<input class="view-radio" type="radio" name="view" id="v-${t}"${t === first ? " checked" : ""} aria-label="${label} view">`).join("")}
<main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}">
<span class="pollen" style="left:64%;top:180px"></span><span class="pollen" style="left:82%;top:420px;animation-delay:-5s"></span><span class="pollen" style="left:40%;top:560px;animation-delay:-9s"></span>
<nav class="top"><span class="brand">${ICON.brand}tira</span><div class="tabs">${VIEWS.map(([t, label]) => `<label for="v-${t}">${label}</label>`).join("")}</div><span class="verify" title="sha256:${esc(dumpHash)} (compare with tira dump --hash)">seq ${v.lastSeq} · ${esc(shortHash)}</span></nav>
<header class="hero"><div class="big"${lanesOnly ? ` title="verified briefs, of those current"` : ""}>${closed}<small>/${total}</small></div><div class="who"><h1>${esc(stream)}</h1><ul class="stats">${stats.join("")}</ul></div></header>
<section class="view view-tree" aria-label="Tree">${treeView}</section>
<section class="view view-board" aria-label="Board">${v.roots.length > 0 ? boardHtml(nodes, trail) : `<p class="empty">No tree yet.</p>`}</section>
<section class="view view-lanes" aria-label="Lanes">${lanesHtml(r, stream, events)}</section>
<section class="view view-log" aria-label="Activity">${logHtml(all, anomalies, v.others, rejections, dumpHash)}</section>
${nodes.map((n) => drawerHtml(n, trail.get(n.row.key) ?? [], pathOf(n))).join("")}
</main></body></html>
`;
}
