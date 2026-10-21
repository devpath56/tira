// D1: the read-only HTML page. Three views of the same fold: the board (Kanban status
// columns, or the whole tree as a graph, switched in its own bar; tira's closes carry its
// mark), lanes and history. Words live in a dialog that opens over the page when you click
// a task: its state, marks and full event history (never a side panel or a new page). Tabs,
// the board's switch and dialogs are CSS only (radio inputs and :target), so the page needs
// no JS and nothing from the network: re-run `tira render` and reload to refresh. The only
// motion is the dialog fading in, off for reduced motion.
// Deterministic: the same fold renders the same bytes. Each tree node carries data-*
// attributes once (on its graph node) and the page carries the `tira dump --hash`, so
// manual test M1 can check the page against the dump node-for-node. Parents tira closed
// carry a bolt, and every node is one click from its event trail (ruling 2026-10-18: the
// machine is never invisible).
import type { FoldResult, Rejection } from "../fold/fold.ts";
import { MACHINE_ACTOR, type EntityState } from "../fold/types.ts";
import { REJECTED, type EventData, type RejectedData } from "../fold/events.ts";
import type { StoredEvent } from "../store/types.ts";
import { VERDICTS, type DivergenceReport } from "../divergence/divergence.ts";
import { flatten, streamView, type TreeRow } from "./tree-view.ts";
import { show } from "../text.ts";
import { foundPath, fx, layout, treePath } from "../serve/layout.mjs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
const bare = (key: string) => key.replace(/^[^:]+:/, "");
// The node table's closed states (its tree config's terminal list), for progress.
const CLOSED = new Set(["done", "cancelled"]);
// Tree labels stay inside their column; the SVG title, aria-label and drawer keep the full id.
const MAX_LABEL = 22;
const short = (id: string) => ([...id].length > MAX_LABEL ? `${[...id].slice(0, MAX_LABEL - 1).join("")}…` : id);

// Jira's palette (Atlassian's design tokens): white or near-black surfaces, Jira blue as the
// one accent, muted status colours, squared tags, no decoration. The theme follows the
// system unless the switch at the top right picks one (radio inputs, so it is CSS only);
// print is always light.
const LIGHT = `--bg:#ffffff;--panel:#ffffff;--panel-2:#f7f8f9;--sunken:#f7f8f9;--raised:#ffffff;--hover:#f0f1f2;--line:#dcdfe4;--line-2:#b7bcc4;--fg:#292a2e;--mut:#505258;--dim:#6b6e76;
--accent:#1868db;--accent-bg:#e9f2fe;--accent-text:#1558bc;--btn:#1868db;--btn-fg:#ffffff;
--prog:#1558bc;--prog-bg:#e9f2fe;--block:#ae2e24;--block-bg:#ffeceb;--done:#216e4e;--done-bg:#dcfff1;--gone:#6b6e76;--gone-bg:#f0f1f2;--warn:#a54800;--warn-bg:#fff7d6;
--shadow:0 1px 1px rgba(30,31,33,.1),0 0 1px rgba(30,31,33,.18)`;
const DARK = `--bg:#1f1f21;--panel:#242528;--panel-2:#2b2c2f;--sunken:#242528;--raised:#2b2c2f;--hover:#2f3034;--line:#3b3d42;--line-2:#56585e;--fg:#cecfd2;--mut:#a9abaf;--dim:#96999e;
--accent:#669df1;--accent-bg:#1c2b42;--accent-text:#8fb8f6;--btn:#669df1;--btn-fg:#1f1f21;
--prog:#8fb8f6;--prog-bg:#1c2b42;--block:#fd9891;--block-bg:#42221f;--done:#7ee2b8;--done-bg:#1c3329;--gone:#96999e;--gone-bg:#2b2c2f;--warn:#f5cd47;--warn-bg:#3a2f12;
--shadow:none`;
export const CSS = `
:root{color-scheme:light dark;${LIGHT};--brand:#1868db;--r-lg:8px;--r:6px;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media screen and (prefers-color-scheme:dark){:root{${DARK}}}
:root:has(#th-light:checked){color-scheme:light;${LIGHT}}
@media screen{:root:has(#th-dark:checked){color-scheme:dark;${DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--fg);font:13.5px/1.5 var(--sans);background:var(--bg);-webkit-font-smoothing:antialiased}
main{max-width:1240px;margin:0 auto;padding:0 24px 56px;position:relative}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;min-height:56px;padding:8px 0;border-image:linear-gradient(to top,var(--line) 1px,var(--bg) 1px) fill 0/0/0 100vmax}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:650;font-size:16px;letter-spacing:-.01em;color:var(--fg);padding-right:8px}
.brand svg{width:24px;height:24px;color:var(--brand)}
.tabs{display:flex;align-self:stretch;margin:-8px 0}
.tabs label{display:flex;align-items:center;cursor:pointer;font-weight:550;font-size:14px;padding:0 10px;color:var(--mut);border-top:2px solid transparent;border-bottom:2px solid transparent}
.tabs label:hover{color:var(--fg)}
.view-radio{position:absolute;opacity:0;pointer-events:none}
#v-board:checked~main .tabs label[for=v-board],#v-lanes:checked~main .tabs label[for=v-lanes],#v-log:checked~main .tabs label[for=v-log]{color:var(--accent);border-bottom-color:var(--accent)}
#v-board:focus-visible~main .tabs label[for=v-board],#v-lanes:focus-visible~main .tabs label[for=v-lanes],#v-log:focus-visible~main .tabs label[for=v-log]{outline:2px solid var(--accent);outline-offset:-2px}
.kbd{margin-left:auto;min-width:240px;text-align:left;font:500 13px var(--sans);color:var(--dim);background:var(--panel);border:1px solid var(--line-2);border-radius:var(--r);padding:6px 10px;cursor:pointer}
.kbd:hover{background:var(--hover)}
.how{margin-left:auto;font-size:13px;color:var(--accent)}.how:hover{text-decoration:underline}.kbd~.how{margin-left:0}
.verify{font-family:var(--mono);font-size:11.5px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r);padding:4px 9px;white-space:nowrap}
a.verify:hover{color:var(--fg);border-color:var(--line-2)}.verify .vl{font-family:var(--sans);font-weight:600;color:var(--fg);margin-right:4px}
.theme{display:inline-flex;gap:2px;padding:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r)}.brand+.theme{margin-left:auto}
.theme label{display:grid;place-items:center;width:28px;height:24px;border-radius:4px;color:var(--dim);cursor:pointer}
.theme label:hover{color:var(--fg)}.theme svg{width:15px;height:15px}
#th-system:checked~main .theme label[for=th-system],#th-light:checked~main .theme label[for=th-light],#th-dark:checked~main .theme label[for=th-dark]{color:var(--accent-text);background:var(--accent-bg)}
#th-system:focus-visible~main .theme label[for=th-system],#th-light:focus-visible~main .theme label[for=th-light],#th-dark:focus-visible~main .theme label[for=th-dark]{outline:2px solid var(--accent);outline-offset:1px}
.flash{margin:16px 0 0;padding:10px 14px;border-radius:var(--r);font-size:13px;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-left-width:4px}
.flash.ok{border-left-color:var(--done);background:var(--done-bg)}.flash.no{border-left-color:var(--block);background:var(--block-bg)}
.hero{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px;margin:24px 0 16px}
.hero .who{display:contents}
.hero h1{order:-1;flex:1 0 100%;margin:0 0 4px;font-size:20px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
.hero h1::before{content:"Stream";display:block;margin-bottom:2px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.big,.stats li{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:12px 16px;box-shadow:var(--shadow)}
.big{flex:0 0 auto;min-width:200px;font-size:26px;font-weight:650;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}
.big small{font-size:.62em;font-weight:500;letter-spacing:0;color:var(--dim)}
.big::before{content:attr(title);display:block;margin-bottom:6px}
.big::before,.stats li{font-size:11px;font-weight:600;letter-spacing:.05em;line-height:1.3;text-transform:uppercase;color:var(--mut)}
.stats{display:flex;flex:1 1 480px;flex-wrap:wrap;gap:12px;margin:0;padding:0;list-style:none}
.stats li{flex:1 1 120px;display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:6px}
.stats b{font-size:26px;font-weight:650;letter-spacing:-.02em;line-height:1.15;text-transform:none;color:var(--fg);font-variant-numeric:tabular-nums}
.stats svg{display:none}
.stats .warn{border-color:var(--block)}.stats .warn,.stats .warn b{color:var(--block)}
.view{display:none;margin-top:16px}
#v-board:checked~main .view-board,#v-lanes:checked~main .view-lanes,#v-log:checked~main .view-log{display:block}
.attention{margin:0 0 16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.att-head{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;padding:12px 16px}
.att-head h2{margin:0;font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px}
.att-head h2 b{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 6px;border-radius:999px;font-size:12px;font-weight:650;color:var(--btn-fg);background:var(--btn);font-variant-numeric:tabular-nums}
.att-head .sum{color:var(--mut);font-size:12.5px}
.att-group h3{margin:0;padding:7px 16px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;background:var(--panel-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
.att-group.blocked h3{color:var(--block)}.att-group.working h3{color:var(--prog)}
.att-group h3 .why{text-transform:none;letter-spacing:0;font-weight:600;font-size:12.5px;color:var(--fg);overflow-wrap:anywhere}
.att-group h3 .k{margin-left:auto;color:var(--mut);font-weight:600;letter-spacing:0}
.att-list{list-style:none;margin:0;padding:0}
.att-row{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;padding:8px 16px;min-height:44px;border-top:1px solid var(--line)}
.att-row:first-child{border-top:0}.att-row:hover{background:var(--hover)}
.att-row .name{font-weight:600;color:var(--accent);overflow-wrap:anywhere}.att-row .name:hover{text-decoration:underline}
.att-row .path{color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.att-row .since{margin-left:auto;color:var(--mut);font-family:var(--mono);font-size:11.5px;white-space:nowrap}
.att-row .acts{display:flex;gap:6px}
.attention.calm .att-head h2{color:var(--done)}
.attention.calm p{margin:0;padding:0 16px 12px;color:var(--mut);font-size:13px}.attention.calm p a{color:var(--accent);font-weight:600}
#v-lanes:checked~main .attention,#v-log:checked~main .attention{display:none}
.divergence{margin:0 0 16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.divergence .att-head h2 b{background:var(--warn)}
.divergence.clean .att-head h2{color:var(--done)}.divergence.unevaluable .att-head h2{color:var(--block)}
.dv-counts{list-style:none;margin:0;padding:0 16px 10px;display:flex;flex-wrap:wrap;gap:6px}
.dv-counts li{font-size:12px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
.dv-counts li b{color:var(--fg);font-variant-numeric:tabular-nums;margin-left:4px}.dv-counts li.hit{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.dv-rows{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.dv-row{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;padding:8px 16px;border-top:1px solid var(--line)}.dv-row:first-child{border-top:0}
.dv-row .v{font-size:11px;font-weight:650;letter-spacing:.04em;color:var(--warn)}.dv-row .id{font-family:var(--mono);font-size:11.5px;color:var(--mut);overflow-wrap:anywhere}
.dv-row .detail{grid-column:1/-1;font-size:13px;overflow-wrap:anywhere}
.dv-meta{margin:0;padding:8px 16px 12px;color:var(--dim);font-size:12px;overflow-wrap:anywhere;border-top:1px solid var(--line)}.dv-meta code{font-family:var(--mono);font-size:11.5px}
.divergence.unevaluable p.why{margin:0;padding:0 16px 12px;font-size:13px;overflow-wrap:anywhere}
.act{display:inline-block;font:550 12.5px/1.4 var(--sans);color:var(--fg);background:var(--panel);border:1px solid var(--line-2);border-radius:var(--r);padding:4px 11px;cursor:pointer;box-shadow:var(--shadow)}
.act:hover{background:var(--hover)}
.board-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}
.seg{display:inline-flex;gap:2px;padding:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r)}
.seg label{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:4px;font-weight:550;font-size:13px;color:var(--mut);cursor:pointer}
.seg label:hover{color:var(--fg)}.seg svg{width:14px;height:14px}
#bv-kanban:checked~.board-bar label[for=bv-kanban],#bv-graph:checked~.board-bar label[for=bv-graph]{color:var(--accent-text);background:var(--accent-bg)}
#bv-kanban:focus-visible~.board-bar label[for=bv-kanban],#bv-graph:focus-visible~.board-bar label[for=bv-graph]{outline:2px solid var(--accent);outline-offset:1px}
.bv{display:none}
#bv-kanban:checked~.bv-kanban,#bv-graph:checked~.bv-graph{display:block}
.legend{display:none;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--mut)}#bv-graph:checked~.board-bar .legend{display:flex}
.legend>span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.legend svg{width:12px;height:12px;color:var(--accent)}
.legend i{display:block;width:10px;height:10px;border-radius:999px;border:2px solid var(--line-2);background:var(--panel)}
.legend i.m-done{border-color:var(--done)}.legend i.m-in_progress{border-color:var(--prog)}.legend i.m-blocked{border-color:var(--block)}.legend i.m-cancelled{border-color:var(--gone);background:var(--gone-bg)}
.lg-next{color:var(--accent);font-size:11px}.lg-ring{display:block;width:10px;height:10px;border-radius:999px;border:1.5px dashed var(--warn)}.lg-found{display:block;width:16px;border-top:2px dotted var(--accent)}
.graph-wrap{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow-x:auto;scrollbar-width:thin;padding:0 16px}
.graph{position:relative;margin:0 auto}
.edges{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.edges path{fill:none;stroke:var(--line-2);stroke-width:1.5;vector-effect:non-scaling-stroke}
.edges path.done{stroke:var(--done)}.edges path.found{stroke:var(--accent);stroke-dasharray:2 4;stroke-linecap:round}.edges path.done.found{stroke:var(--done)}
.gn{position:absolute;z-index:1;width:148px;height:56px;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:center;gap:2px;padding:6px 10px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.gn:hover{border-color:var(--accent);background:var(--hover)}
.gn .gt{display:flex;align-items:center;gap:6px;min-width:0}
.sd{flex:none;width:16px;height:16px;border-radius:999px;display:grid;place-items:center;background:var(--panel);border:1.5px solid var(--line-2);color:var(--dim)}.sd svg{width:9px;height:9px}
.st-done .sd{background:var(--done);border-color:var(--done);color:var(--panel)}.st-cancelled .sd{background:var(--gone-bg);border-color:var(--gone);color:var(--gone)}
.st-blocked .sd{background:var(--block-bg);border-color:var(--block);color:var(--block)}.st-in_progress .sd{background:var(--prog-bg);border-color:var(--prog);color:var(--prog)}
.st-done .name{color:var(--mut)}.st-cancelled .name{color:var(--dim);text-decoration:line-through}
.here{font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:4px;padding:1px 6px;white-space:nowrap}
.gn .name{min-width:0;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gn .gm{padding-left:22px;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gn.parent{background:var(--panel-2)}.gn.parent .name{font-weight:650}
.gn.st-in_progress{border-color:var(--prog)}.gn.st-blocked{border-color:var(--block);background:var(--block-bg)}.gn.st-done{border-color:var(--done)}.gn.st-cancelled{border-style:dashed}
.gn.is-next{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}.gn.is-active{box-shadow:0 0 0 3px var(--prog-bg)}
.gn .here{position:absolute;top:-10px;left:10px}
.gm .tira-mark,.gm .wait-ring{display:inline-block;vertical-align:-2px;margin-right:4px}.tira-mark svg{display:block;width:12px;height:12px;color:var(--accent)}
.graph-wrap.canvas{position:relative;overflow:hidden;height:clamp(360px,64vh,760px);padding:0;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;background-image:radial-gradient(circle,var(--line-2) 1px,transparent 1.3px);background-size:var(--gs,24px) var(--gs,24px);background-position:var(--gx,0) var(--gy,0)}
.graph-wrap.canvas.panning{cursor:grabbing}.graph-wrap.canvas:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.canvas .graph{position:absolute;left:0;top:0;margin:0;transform-origin:0 0}
.graph-wrap.full{position:fixed;inset:0;z-index:9;height:auto;border:0;border-radius:0}body:has(.graph-wrap.full){overflow:hidden}
.gn[hidden],.fold[hidden]{display:none}
.gn.folded{box-shadow:4px 4px 0 -1px var(--raised),4px 4px 0 0 var(--line-2)}
.fold{position:absolute;z-index:2;transform:translate(-50%,-50%);min-width:20px;height:20px;padding:0 6px;border:1px solid var(--line-2);border-radius:999px;background:var(--panel);color:var(--mut);font:650 11px/1 var(--sans);font-variant-numeric:tabular-nums;cursor:pointer}
.fold:hover{border-color:var(--accent);color:var(--accent)}.fold.is-folded{color:var(--accent-text);background:var(--accent-bg);border-color:var(--accent)}
.fold.is-folded.has-next{box-shadow:0 0 0 3px var(--accent-bg)}.fold.is-folded.has-blocked{color:var(--block);background:var(--block-bg);border-color:var(--block)}
.canvas-tools{position:absolute;top:10px;right:10px;z-index:3;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:calc(100% - 20px);cursor:default}
.tool-group{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.tool{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;min-width:26px;padding:0 8px;border:0;border-radius:4px;background:none;color:var(--fg);font:550 12.5px var(--sans);white-space:nowrap;cursor:pointer}
.tool:hover{background:var(--hover)}.tool:disabled{color:var(--dim);cursor:default;background:none}.tool[aria-pressed=true]{color:var(--accent-text);background:var(--accent-bg)}
.tool.icon{padding:0 5px}.tool svg{width:15px;height:15px}.tool.zoom{min-width:50px;color:var(--mut);font-variant-numeric:tabular-nums}
.canvas-hint{position:absolute;left:12px;bottom:10px;z-index:3;font-size:11.5px;color:var(--dim);pointer-events:none}
.canvas-flash{position:absolute;left:50%;bottom:12px;z-index:3;transform:translateX(-50%);display:none;max-width:calc(100% - 24px);padding:8px 14px;border-radius:var(--r);font-size:13px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--done);box-shadow:var(--shadow)}
.canvas-flash.no{border-left-color:var(--block)}.full .canvas-flash{display:block}.full .canvas-hint{display:none}
.hide-found .edges path.found{stroke:var(--line-2);stroke-dasharray:none}.hide-found .edges path.done.found{stroke:var(--done)}
.edges path.blocks{stroke:var(--block);stroke-dasharray:7 4;stroke-width:2}.edges path.blocks.done{stroke:var(--done)}.lg-blocks{display:block;width:16px;border-top:2px dashed var(--block)}
.links{display:grid;gap:6px;margin-top:12px}.links p{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0}.links .lk{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--block);min-width:78px}.links a{font-weight:600;color:var(--accent)}.links a:hover{text-decoration:underline}
.att-row .by{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--mut)}.att-row .by a{font-weight:600;color:var(--accent)}.att-row .ready{display:inline;font-size:10.5px}
.chip.blocks{color:var(--block);border-color:var(--block);background:var(--block-bg)}
.blocked-by{display:grid;gap:6px;margin:0 0 10px;font-weight:600;font-size:13px}.blocked-by input{font:500 14px var(--sans);color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r);padding:8px 10px}.blocked-by input:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.your-action .blocked-by+.fills{margin:-2px 0 10px}
.wait-ring{width:12px;height:12px;border-radius:999px;border:1.5px dashed var(--warn);flex:none}
.meter{flex:1;min-width:40px;height:6px;border-radius:3px;background:var(--gone-bg);overflow:hidden;display:flex}.meter i{display:block;height:100%}
.m-done{background:var(--done)}.m-cancelled{background:var(--gone)}.m-in_progress{background:var(--prog)}.m-blocked{background:var(--block)}
.ct{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:start}
.col{background:var(--sunken);border:1px solid var(--line);border-radius:var(--r-lg);padding:8px}
.ch{display:flex;align-items:center;gap:8px;padding:4px 6px 10px;font-weight:650;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
.dot{width:8px;height:8px;border-radius:2px}
.ch .k{margin-left:auto;color:var(--mut);font-weight:600;letter-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:0 7px;font-size:11px}
.card{display:block;background:var(--raised);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;box-shadow:var(--shadow)}
.card:hover{border-color:var(--line-2)}
.card .t{font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
.card .row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;color:var(--mut);font-size:12px}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:0 6px;font-size:11.5px;color:var(--mut);overflow-wrap:anywhere}
.hist{margin-left:auto;display:inline-flex;align-items:center;gap:3px}.hist svg,.chip svg{width:12px;height:12px}
.pin{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:4px;padding:1px 6px;margin-bottom:6px}
.card.is-next{border-left:3px solid var(--accent)}
.card.is-gone .t{text-decoration:line-through;color:var(--dim)}
.empty{color:var(--dim);font-size:13px;padding:6px 4px;margin:0}
.lanes{display:grid;grid-template-columns:minmax(90px,.8fr) repeat(var(--n),minmax(120px,1fr));gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:12px 16px;overflow-x:auto;box-shadow:var(--shadow)}
.lanes-label{margin:20px 0 8px;font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}.lanes-label:first-child{margin-top:4px}
.lanes .lh{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);padding:0 4px 4px}
.lanes .who{font-weight:600;overflow-wrap:anywhere;padding:4px}.lanes .who.old{color:var(--dim);text-decoration:line-through}
.lane{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;border-radius:var(--r);background:var(--panel-2);border:1px solid var(--line);min-height:36px}
.pill{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:4px;background:var(--gone-bg);color:var(--mut);white-space:nowrap}
.pill.go{color:var(--done);background:var(--done-bg)}.pill.work{color:var(--prog);background:var(--prog-bg)}.pill.stop{color:var(--block);background:var(--block-bg)}.pill.wait{color:var(--warn);background:var(--warn-bg)}
.cap{font-size:11.5px;color:var(--mut);display:inline-flex;align-items:center;gap:4px}
.cap .av{width:18px;height:18px;font-size:10px}
.chips2{display:flex;flex-wrap:wrap;gap:6px}
.pairs{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow)}
.pairs li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;color:var(--mut);padding:8px 14px;border-top:1px solid var(--line)}
.pairs li:first-child{border-top:0}.pairs li.waiting{background:var(--warn-bg)}
.pairs .arrow{color:var(--accent);font-weight:700}.pairs code{font-family:var(--mono);font-size:11.5px;color:var(--fg)}
.ready{font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--done);display:block}
.needs{font-size:11px;color:var(--warn);display:block;overflow-wrap:anywhere}
.drawer{position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:24px 16px;visibility:hidden;opacity:0;transition:opacity .15s ease,visibility 0s .15s}
.drawer:target{visibility:visible;opacity:1;transition:opacity .15s ease}
body:has(.drawer:target){overflow:hidden}
.scrim{position:absolute;inset:0;background:rgba(9,30,66,.54);cursor:default}
.modal-box{position:relative;width:min(640px,100%);max-height:min(82vh,760px);overflow-y:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:0 8px 24px rgba(9,30,66,.25);padding:20px 24px 24px;transform:translateY(8px);transition:transform .15s ease}
.drawer:target .modal-box{transform:none}
.drawer .close{position:absolute;right:14px;top:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:var(--r);border:1px solid transparent;color:var(--mut);font-size:18px}
.drawer .close:hover{background:var(--hover);border-color:var(--line);color:var(--fg)}
.drawer h2{margin:4px 0 2px;font-size:18px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere;padding-right:32px}
.path{color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.state{display:inline-block;font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:4px}
.s-unstarted{color:var(--mut);background:var(--gone-bg)}.s-in_progress{color:var(--prog);background:var(--prog-bg)}.s-blocked{color:var(--block);background:var(--block-bg)}
.s-done{color:var(--done);background:var(--done-bg)}.s-cancelled{color:var(--gone);background:var(--gone-bg)}
.mark{font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:4px;background:var(--gone-bg);color:var(--mut)}
.mark.cursor,.mark.tira{color:var(--accent-text);background:var(--accent-bg)}.mark.active{color:var(--prog);background:var(--prog-bg)}.mark.wait{color:var(--warn);background:var(--warn-bg)}
.kids-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px}
.kids-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel-2)}
.kids-list a{font-weight:600;color:var(--accent);overflow-wrap:anywhere}.kids-list a:hover{text-decoration:underline}
.proof{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-top:14px;padding:10px 12px;border:1px solid var(--line);border-left:4px solid var(--done);border-radius:var(--r);background:var(--done-bg)}
.proof-k{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--done)}.proof-v{font-family:var(--mono);font-size:12.5px;color:var(--fg);overflow-wrap:anywhere}
.drawer-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.kids{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--mut);font-size:12.5px}
details.trail{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}
details.trail summary{cursor:pointer;color:var(--mut);font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;min-height:24px}
.feed{list-style:none;margin:8px 0 0;padding:0;position:relative}
.feed::before{content:"";position:absolute;left:11px;top:6px;bottom:6px;width:1px;background:var(--line)}
.ev{position:relative;display:flex;gap:10px;padding:6px 0}
.av{position:relative;z-index:1;flex:none;width:23px;height:23px;border-radius:999px;display:grid;place-items:center;font-size:10.5px;font-weight:650;color:var(--mut);background:var(--panel-2);border:1px solid var(--line-2)}
.ev.tira .av{color:var(--accent-text);background:var(--accent-bg);border-color:transparent}.av svg{width:12px;height:12px}
.ev.refused .av{color:var(--block);background:var(--block-bg);border-color:transparent}
.ev-body{min-width:0;padding-top:2px}
.ev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px}
.ev-what{font-family:var(--mono);font-size:12px}.ev.refused .ev-what{color:var(--block)}
.ev-who{font-weight:600;font-size:13px}.ev-task{font-weight:600;font-size:13px;color:var(--fg)}
.ev-seq{font-family:var(--mono);font-size:11px;color:var(--dim)}
.auto,.legacy{font-size:10px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);border:1px solid currentColor;border-radius:4px;padding:0 5px}.legacy{color:var(--warn)}
.ev-detail{color:var(--mut);font-size:12.5px;overflow-wrap:anywhere;margin-top:1px}
.log{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:4px 16px 16px;box-shadow:var(--shadow)}
.log h3{font-size:11px;color:var(--dim);font-weight:650;letter-spacing:.06em;text-transform:uppercase;margin:16px 0 4px}
.hash{font-family:var(--mono);font-size:12px;color:var(--mut);word-break:break-all}
.others{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.alert{border:1px solid var(--line);border-left:4px solid var(--block);background:var(--block-bg);border-radius:var(--r);padding:8px 12px;margin:12px 0 0;color:var(--block);font-size:13px;font-weight:600}
.packet-page{max-width:1000px}.packet-page>.how{display:inline-block;margin-top:20px}
.packet h1{font-size:20px;font-weight:650;letter-spacing:-.01em;margin:12px 0 16px}
.packet section{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px;margin:0;box-shadow:var(--shadow)}
.packet h2{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 10px}.packet ul{margin:0;padding-left:18px}.packet li{margin:4px 0}
.verdict{margin:12px 0 0;padding:8px 12px;border-radius:var(--r);border-left:4px solid;font-weight:600}.verdict.ok{color:var(--done);background:var(--done-bg)}.verdict.no{color:var(--block);background:var(--block-bg)}
.hint{margin:10px 0 0;font-size:13.5px;color:var(--fg)}.hint b{font-weight:650}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:stretch;margin:0 0 14px}
.brief p{margin:0 0 8px;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}.brief p b{font-weight:650}.brief .verdict{margin-top:10px}
.your-action textarea{display:block;width:100%;min-height:150px;resize:vertical;font:12.5px/1.6 var(--mono);color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r);padding:10px 12px}.your-action textarea:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.cmd-help{margin:8px 0 0;font-size:12px;color:var(--mut)}
.fills{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}.fills span{font-size:12px;color:var(--mut)}
.fill{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px var(--sans);color:var(--fg);background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;cursor:pointer}.fill:hover{border-color:var(--accent);color:var(--accent)}
.run{display:flex;align-items:center;flex-wrap:wrap;gap:12px 16px;margin:0 0 14px}.run .how{margin-left:0}
.act.primary{padding:8px 16px;font-size:13.5px;color:var(--btn-fg);background:var(--btn);border-color:var(--btn)}.act.primary:hover{filter:brightness(1.1)}
button.how{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--accent);cursor:pointer}
.confirm-dialog{width:min(1000px,calc(100vw - 32px));max-height:min(90vh,860px);padding:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--bg);color:var(--fg);box-shadow:0 8px 24px rgba(9,30,66,.25)}
.confirm-dialog::backdrop{background:rgba(9,30,66,.54)}
.confirm-dialog .packet{padding:20px 24px 6px}.confirm-dialog .packet h1{margin-top:0}
.guide p{margin:0 0 12px;color:var(--fg);font-size:13.5px;line-height:1.6}.guide code{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.palette{position:fixed;inset:0;background:rgba(5,12,31,.46);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;z-index:50}
.palette[hidden]{display:none}
.pal-box{width:min(600px,100%);background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 24px 56px rgba(16,24,40,.3);overflow:hidden}
.pal-box input{width:100%;font:500 15px var(--sans);color:var(--fg);background:transparent;border:0;border-bottom:1px solid var(--line);padding:14px 16px;outline:none}
.pal-list{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.pal-list li{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:var(--r);cursor:pointer}
.pal-list li[aria-selected=true]{background:var(--accent-bg)}
.pal-list .pid{font-weight:600}.pal-list .ppath{color:var(--dim);font-size:12px;overflow-wrap:anywhere}.pal-list .pverb{margin-left:auto;font-size:12px;font-weight:600;color:var(--accent)}
.pal-hint{padding:8px 14px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);background:var(--panel-2)}
@media (max-width:720px){.split{grid-template-columns:1fr}}
@media (max-width:640px){
main{padding:0 16px 48px}
.tabs{margin:0;overflow-x:auto}.tabs label{padding:6px 10px}.kbd{min-width:0}.brand{padding-right:0}
.graph-wrap{padding:0 12px}.canvas-hint{display:none}
.canvas-tools{left:8px;right:8px;max-width:none;flex-wrap:nowrap;justify-content:flex-start;overflow-x:auto;scrollbar-width:none}.tool-group{flex:none}
}
@media (max-width:560px){.big{flex:1 1 100%}.lanes{grid-template-columns:1fr;overflow:visible}.lanes .lh{display:none}.lanes .who{padding-top:10px}.lane::before{content:attr(data-region);font-size:11px;color:var(--dim);min-width:52px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}
@media print{body{background:#fff}.top{border-image:none;border-bottom:1px solid var(--line)}.tabs,.kbd,.top .how,.theme{display:none}.view{display:block!important}.drawer{display:none}.board-bar{display:none}.bv{display:block!important}.graph-wrap{overflow:visible}}
`;

const ICON = {
  brand: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="currentColor"/><path d="M10.5 5.5v10a3 3 0 0 0 3 3h2M7 10h8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // tira's mark: a parent tira closed by itself
  auto: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.8L3.6 9h4.1l-.9 5.2L12.4 7H8.3z"/></svg>`,
  history: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.5 2.5v2.4h2.4"/><path d="M8 5.2V8l2 1.3"/></svg>`,
  ban: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>`,
  alert: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>`,
  system: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.8" width="12" height="8.7" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>`,
  sun: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>`,
  moon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z"/></svg>`,
  spark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2v4M8 10v4M2 8h4M10 8h4"/></svg>`,
  kanban: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1"/></svg>`,
  graph: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.8" y="1.8" width="4.4" height="3.4" rx="1"/><rect x="1.5" y="10.8" width="4.4" height="3.4" rx="1"/><rect x="10.1" y="10.8" width="4.4" height="3.4" rx="1"/><path d="M8 5.2v2.6M3.7 10.8V7.8h8.6v3"/></svg>`,
};

// ---------- graph ----------
// The board's other style: every task as a node of a top-down tree, a parent above its
// children, joined by lines that turn green once the child is closed; a dotted line joins a
// task to the one it was found while working on. The places come from layout.mjs, shared
// with the live canvas: a tidy tree, whole pixels from the tree alone, so the bytes still
// depend only on the fold. A rendered file scrolls; live, graph.mjs makes it a canvas you
// pan, zoom and fold. Each node opens its task's dialog and carries the fold's flags: the
// one place on the page they appear, once per task (M1).

interface Placed { row: TreeRow; i: number; parent?: Placed }

// Preorder: the dialog ids (#t<i>) and the graph's left-to-right order.
function indexNodes(roots: TreeRow[]): Placed[] {
  const out: Placed[] = [];
  const walk = (row: TreeRow, parent?: Placed) => {
    const p: Placed = { row, i: out.length, ...(parent ? { parent } : {}) };
    out.push(p);
    row.children.forEach((c) => walk(c, p));
  };
  roots.forEach((r) => walk(r));
  return out;
}

const STOP_GLYPH: Record<string, string> = {
  done: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.8 8.4l2.7 2.7 5.7-6"/></svg>`,
  cancelled: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 11.5l7-7"/></svg>`,
  blocked: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3.8v5M8 12v.2"/></svg>`,
  in_progress: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`,
};
// The board's words for a state, the same as its columns.
const STATE_WORD: Record<string, string> = { unstarted: "to do", in_progress: "in progress", blocked: "blocked", done: "done", cancelled: "dropped" };
const word = (state: string) => STATE_WORD[state] ?? state;

const nodeAttrs = (r: TreeRow, lines: number) =>
  `data-key="${esc(r.key)}" data-state="${esc(r.state)}" data-drained="${r.drained}" data-cursor="${r.cursor}" data-active="${r.active}" data-depth="${r.depth}" data-closed-by-tira="${r.closedByTira}" data-awaiting-close="${r.awaitingClose}" data-history="${lines}"`;

function graphHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links): string {
  const kids = new Map<Placed, Placed[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const L = layout(nodes.map((n) => ({ key: n.row.key, parent: n.parent?.row.key })));
  const at = (n: Placed) => L.at.get(n.row.key) ?? { x: 0, y: 0 };
  const byKey = new Map(nodes.map((n) => [n.row.key, n]));
  const tree = nodes.filter((n) => n.parent).map((n) => {
    const p = n.parent as Placed;
    // the child blocks its parent: the line itself is the blocks link (red); found while
    // working on its own parent: the line itself is dotted
    const blocking = links.blockedBy.get(p.row.key) === n.row.key;
    let style = "";
    if (blocking) style = "blocks";
    else if (n.row.discoveredDuring === p.row.key) style = "found";
    const cls = [CLOSED.has(n.row.state) ? "e done" : "e", style].filter(Boolean).join(" ");
    return `<path class="${cls}" data-from="${esc(p.row.key)}" data-to="${esc(n.row.key)}" d="${treePath(at(p), at(n))}"/>`;
  });
  const found = nodes.filter((n) => n.row.discoveredDuring !== undefined && n.row.discoveredDuring !== n.parent?.row.key && byKey.has(n.row.discoveredDuring)).map((n) => {
    const d = byKey.get(n.row.discoveredDuring as string) as Placed;
    return `<path class="e found" data-from="${esc(d.row.key)}" data-found="${esc(n.row.key)}" d="${foundPath(at(d), at(n))}"/>`;
  });
  // a blocker elsewhere in the tree: a dashed red arc from it to what it blocks
  const blockArcs = [...links.blockedBy].filter(([key, by]) => byKey.get(key)?.parent?.row.key !== by && byKey.get(by)?.parent?.row.key !== key).map(([key, by]) => {
    const [b, k] = [byKey.get(by) as Placed, byKey.get(key) as Placed];
    return `<path class="e blocks${CLOSED.has(b.row.state) ? " done" : ""}" data-from="${esc(by)}" data-blocks="${esc(key)}" d="${foundPath(at(b), at(k))}"/>`;
  });
  const node = (n: Placed) => graphNodeHtml(n, kids.get(n) ?? [], at(n), byKey, links, (trail.get(n.row.key) ?? []).length);
  // Live, graph.mjs turns the box into a canvas (pan, zoom, folds); a rendered file scrolls.
  return `<div class="graph-wrap" data-graph><div class="graph" role="group" aria-label="Tasks as a tree" style="width:${fx(L.width)}px;height:${L.height}px">`
    + `<svg class="edges" viewBox="0 0 ${fx(L.width)} ${L.height}" aria-hidden="true">${tree.join("")}${found.join("")}${blockArcs.join("")}</svg>`
    + `${nodes.map(node).join("")}</div></div>`;
}

// What a graph node says to a screen reader: the task, its state, and its links.
function nodeLabel(n: Placed, ks: Placed[], closed: number, byKey: ReadonlyMap<string, Placed>, links: Links): string {
  const r = n.row;
  const blocks = (links.blocks.get(r.key) ?? []).map((k) => byKey.get(k)?.row.id ?? k);
  const by = links.blockedBy.get(r.key);
  const said = [r.id, word(r.state)];
  if (ks.length > 0) said.push(`${closed} of ${ks.length} subtasks closed`);
  if (by !== undefined) said.push("blocked by " + (byKey.get(by)?.row.id ?? by));
  if (blocks.length > 0) said.push("blocks " + blocks.join(", "));
  if (r.cursor) said.push("next");
  if (r.active) said.push("active");
  return said.join(", ");
}

// One task on the graph: a link to its dialog, carrying the fold's flags (M1).
function graphNodeHtml(n: Placed, ks: Placed[], p: { x: number; y: number }, byKey: ReadonlyMap<string, Placed>, links: Links, history: number): string {
  const r = n.row;
  const closed = ks.filter((c) => CLOSED.has(c.row.state)).length;
  const left = ks.length - closed;
  const cls = [
    "gn", `st-${r.state}`, ks.length > 0 ? "parent" : "",
    r.cursor ? "is-next" : "", r.active ? "is-active" : "",
  ].filter(Boolean).join(" ");
  const tiraMark = r.closedByTira ? `<span class="tira-mark" title="closed by tira">${ICON.auto}</span>` : "";
  const waitRing = r.awaitingClose ? `<span class="wait-ring" title="tira closes it when you move on"></span>` : "";
  const marks = tiraMark + waitRing;
  const leftText = left === 0 ? "" : " · " + left + " left";
  const progress = ks.length === 0 ? word(r.state) : `${closed}/${ks.length} closed` + leftText;
  const meta = progress + (r.discoveredDuring ? " · ✦ found" : "");
  const parentAttr = n.parent ? ` data-parent="${esc(n.parent.row.key)}"` : "";
  const pinWord = r.active ? "now" : "next";
  const pin = r.cursor ? `<span class="here">◆ ${pinWord}</span>` : "";
  return `<a class="${cls}" href="#t${n.i}" style="left:${fx(p.x)}px;top:${p.y}px" aria-label="${esc(nodeLabel(n, ks, closed, byKey, links))}"${parentAttr} ${nodeAttrs(r, history)}>`
    + pin
    + `<span class="gt"><span class="sd">${STOP_GLYPH[r.state] ?? ""}</span><span class="name" title="${esc(r.id)}">${esc(short(r.id))}</span></span>`
    + `<span class="gm">${marks}${meta}</span></a>`;
}

// What the graph's colours and marks mean, beside the switch while the graph shows.
const LEGEND = `<span class="legend" aria-hidden="true"><span><i class="m-done"></i>done</span><span><i class="m-in_progress"></i>in progress</span><span><i class="m-blocked"></i>blocked</span><span><i></i>to do</span><span><i class="m-cancelled"></i>dropped</span>`
  + `<span><b class="lg-next">◆</b>next</span><span>${ICON.auto}closed by tira</span><span><b class="lg-ring"></b>tira closes it when you move on</span><span><b class="lg-found"></b>found while working on</span><span><b class="lg-blocks"></b>blocks</span></span>`;

// The board: one view, two styles, switched in its own bar with CSS alone (radio inputs).
// Kanban by default; live, app.mjs remembers the choice so it survives the reload after
// every action.
function boardView(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links): string {
  const styles: [string, string, string][] = [["kanban", "Kanban", ICON.kanban], ["graph", "Graph", ICON.graph]];
  const radios = styles.map(([s, label]) => `<input class="view-radio" type="radio" name="board-style" id="bv-${s}"${s === "kanban" ? " checked" : ""} aria-label="${label} style" data-board-style="${s}">`).join("");
  const switches = styles.map(([s, label, icon]) => `<label for="bv-${s}">${icon}${label}</label>`).join("");
  return radios
    + `<div class="board-bar"><span class="seg" role="group" aria-label="Board style">${switches}</span>${LEGEND}</div>`
    + `<div class="bv bv-kanban">${boardHtml(nodes, trail, links)}</div><div class="bv bv-graph">${graphHtml(nodes, trail, links)}</div>`;
}

// ---------- history ----------

interface TrailEntry {
  seq: number;
  auto: boolean; // written by a factory transition (fx: event id, B2)
  legacy: boolean; // written before the rules version marker: replayed under the legacy era's rules
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
      add({ seq: e.seq, auto: e.eventId.startsWith("fx:"), legacy: e.metadata.era === undefined, key: `${d.intent.entity.type}:${d.intent.entity.id}`, what: `rejected ${what}`, actor, detail: `${d.reason?.code}: ${d.reason?.detail}`, refused: true });
      continue;
    }
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const type = e.type.slice(0, e.type.indexOf("."));
    const p = d.payload ?? {};
    const detail = actor === MACHINE_ACTOR ? `${String(p.reason ?? "")} · ${cites(p.trigger)}` : describe(p);
    add({ seq: e.seq, auto: e.eventId.startsWith("fx:"), legacy: e.metadata.era === undefined, key: `${type}:${d.entity.id}`, what: e.type, actor, detail, refused: false });
  }
  return { byKey, all };
}

function entryHtml(x: TrailEntry, withTask = false): string {
  const tira = x.actor === MACHINE_ACTOR;
  const avatar = tira ? ICON.auto : x.refused ? "!" : esc(([...x.actor][0] ?? "?").toUpperCase());
  const cls = ["ev", tira ? "tira" : "", x.refused ? "refused" : ""].filter(Boolean).join(" ");
  return `<li class="${cls}"><span class="av" aria-hidden="true">${avatar}</span><div class="ev-body">`
    + `<div class="ev-head">${withTask ? `<span class="ev-task">${esc(bare(x.key))}</span>` : ""}<span class="ev-what">${esc(x.what)}</span><span class="ev-who">${esc(x.actor)}</span>${x.auto ? `<span class="auto" title="written by a factory transition (fx: id)">auto</span>` : ""}${x.legacy ? `<span class="legacy" title="written before the rules version marker: replayed under the legacy rules">legacy</span>` : ""}<span class="ev-seq">seq ${x.seq}</span></div>`
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

// A click outside a dialog closes it: the dimmed page behind the box is a link back to "#_".
const SCRIM = `<a class="scrim" href="#_" tabindex="-1" aria-hidden="true"></a>`;

// The dialog for one task: where the words live. Opens over the page via #t<i> (CSS :target),
// never as a side panel or a new page.
// A done task's proof of work: the evidence its completion carries (the latest completion
// since its last re-open, among the events replay applied).
interface Proof { ref: string; actor: string; seq: number }

// What a task's dialog offers under `tira serve`, by state. Each opens its confirm dialog.
const DIALOG_ACTIONS: Record<string, [string, string][]> = {
  unstarted: [["START", "Start"], ["BLOCK", "Block"], ["ADD_SUBTASK", "Add subtask"], ["CANCEL", "Cancel"]],
  in_progress: [["COMPLETE", "Complete"], ["BLOCK", "Block"], ["ADD_SUBTASK", "Add subtask"], ["CANCEL", "Cancel"]],
  blocked: [["UNBLOCK", "Unblock"], ["ADD_SUBTASK", "Add subtask"], ["CANCEL", "Cancel"]],
  done: [["REOPEN", "Reopen"]],
};

interface DialogContext { indexOf: ReadonlyMap<string, number>; proof: Proof | undefined; live: boolean; links: Links; rowOf: ReadonlyMap<string, TreeRow> }

// A linked task: one click to its dialog, with its state.
const linkTo = (key: string, ctx: Pick<DialogContext, "indexOf" | "rowOf">) => {
  const row = ctx.rowOf.get(key);
  return row ? `<a href="#t${ctx.indexOf.get(key)}">${esc(row.id)}</a>${stateBadge(row.state)}` : "";
};

function marksHtml(r: TreeRow): string {
  return [
    r.cursor ? `<span class="mark cursor">◆ next</span>` : "",
    r.active ? `<span class="mark active">● active</span>` : "",
    r.drained ? `<span class="mark drained">drained</span>` : "",
    r.closedByTira ? `<span class="mark tira">closed by tira</span>` : "",
    r.awaitingClose ? `<span class="mark wait">tira closes it when you move on</span>` : "",
    r.discoveredDuring ? `<span class="mark">found during ${esc(bare(r.discoveredDuring))}</span>` : "",
  ].filter(Boolean).join("");
}

// which subtasks, not just how many: each with its state, one click to its own dialog
function kidsHtml(r: TreeRow, ctx: DialogContext): string {
  if (r.children.length === 0) return "";
  const closedKids = r.children.filter((c) => CLOSED.has(c.state)).length;
  const kidNoun = r.children.length === 1 ? "subtask" : "subtasks";
  const kidsList = r.children.map((c) => `<li><a href="#t${ctx.indexOf.get(c.key)}">${esc(c.id)}</a>${stateBadge(c.state)}</li>`).join("");
  return `<div class="kids">${meter(r.children.map((c) => c.state))}<span>${closedKids} of ${r.children.length} ${kidNoun} closed</span></div><ul class="kids-list" aria-label="Subtasks">${kidsList}</ul>`;
}

function proofHtml(r: TreeRow, ctx: DialogContext): string {
  if (r.state !== "done" || !ctx.proof) return "";
  return `<div class="proof" data-proof><span class="proof-k">Proof of work</span><span class="proof-v">${esc(ctx.proof.ref)}</span><span class="ev-seq">${esc(ctx.proof.actor)} · seq ${ctx.proof.seq}</span></div>`;
}

// the blocks link, both ways: a blocked task names its blocker ticket, the ticket what it blocks
function linksHtml(r: TreeRow, ctx: DialogContext): string {
  const by = ctx.links.blockedBy.get(r.key);
  const blocks = ctx.links.blocks.get(r.key) ?? [];
  const byLine = by === undefined ? "" : `<p><span class="lk">Blocked by</span>${linkTo(by, ctx)}</p>`;
  const blocksLine = blocks.length === 0 ? "" : `<p><span class="lk">Blocks</span>${blocks.map((k) => linkTo(k, ctx)).join("")}</p>`;
  return (byLine + blocksLine) === "" ? "" : `<div class="links" data-links>${byLine}${blocksLine}</div>`;
}

function drawerHtml(n: Placed, lines: TrailEntry[], path: string, ctx: DialogContext): string {
  const r = n.row;
  const verbs = ctx.live ? DIALOG_ACTIONS[r.state] ?? [] : [];
  const acts = verbs.length > 0 ? `<div class="drawer-acts" data-dialog-acts>${verbs.map(([ev, label]) => actLink(r, ev, label)).join("")}</div>` : "";
  return `<section class="drawer" id="t${n.i}" aria-label="${esc(r.id)}" role="dialog" aria-modal="true">${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a>`
    + `<div class="path">${path}</div><h2>${esc(r.id)}</h2><div class="badges">${stateBadge(r.state)}${marksHtml(r)}</div>${linksHtml(r, ctx)}${acts}${proofHtml(r, ctx)}${kidsHtml(r, ctx)}`
    + `<details class="trail" open><summary>history (${lines.length})</summary><ol class="feed">${lines.map((l) => entryHtml(l)).join("")}</ol></details></div></section>`;
}

// ---------- needs attention (the D1 UI brief, 2026-10-19) ----------
// Bounded by attention, not by tree size: what is blocked, grouped by the reason it was
// blocked with, and what is being worked on (the active tasks). Stale work joins once its
// time limit is ruled. States come from the fold; why and since when come from the log.

interface Since { seq: number; reason?: string; blocker?: string } // blocker: the ticket's key, when the block names one

// `skip`: the seqs replay refused (the fold's anomalies): they never happened, so they
// can't start a stretch or give it a reason.
export function attentionSince(events: readonly StoredEvent[], stream: string, skip: ReadonlySet<number> = new Set()): { blocked: Map<string, Since>; working: Map<string, Since> } {
  const blocked = new Map<string, Since>();
  const working = new Map<string, Since>();
  for (const e of events) {
    if (e.stream !== stream || e.type === REJECTED || skip.has(e.seq)) continue;
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const dot = e.type.indexOf(".");
    const key = `${e.type.slice(0, dot)}:${d.entity.id}`;
    const ev = e.type.slice(dot + 1);
    trackBlocked(blocked, key, ev, e.seq, d.payload);
    trackWorking(working, key, ev, e.seq);
  }
  return { blocked, working };
}

// The first event of a stretch counts: a repeated block or start is a no-op.
function trackBlocked(blocked: Map<string, Since>, key: string, ev: string, seq: number, payload: Record<string, unknown> | undefined): void {
  const reason = payload?.reason;
  const by = payload?.blocker;
  const blocker = typeof by === "string" && by.trim() !== "" ? { blocker: `${key.slice(0, key.indexOf(":"))}:${by.trim()}` } : {};
  if (ev === "block" && !blocked.has(key)) blocked.set(key, { seq, ...(typeof reason === "string" ? { reason } : {}), ...blocker });
  if (ev === "unblock" || ev === "cancel") blocked.delete(key);
}

function trackWorking(working: Map<string, Since>, key: string, ev: string, seq: number): void {
  if ((ev === "start" || ev === "unblock" || ev === "reopen") && !working.has(key)) working.set(key, { seq });
  if (ev === "block" || ev === "complete" || ev === "cancel") working.delete(key);
}

// Blocking needs a reason (2026-10-20), but it may be blank.
// Who blocks whom, for the tasks blocked now: a block that names its blocker ticket links the
// two (both on the tree). It lasts while the block does; the history keeps it after.
interface Links { blockedBy: Map<string, string>; blocks: Map<string, string[]> }
function linksOf(blocked: ReadonlyMap<string, Since>, onTree: ReadonlySet<string>): Links {
  const blockedBy = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  for (const [key, since] of blocked) {
    if (since.blocker === undefined || !onTree.has(key) || !onTree.has(since.blocker)) continue;
    blockedBy.set(key, since.blocker);
    blocks.set(since.blocker, [...(blocks.get(since.blocker) ?? []), key]);
  }
  return { blockedBy, blocks };
}

const whyLabel = (reason: string | undefined) => (reason !== undefined && reason.trim() !== "" ? reason : "no reason given");

// Under `tira serve`, each row offers what its state allows. Every action opens the
// confirm page first (what tira will do, then what you fill in): nothing fires from here.
const ROW_ACTIONS: Record<string, [string, string][]> = { blocked: [["UNBLOCK", "Unblock"]], in_progress: [["COMPLETE", "Complete"], ["BLOCK", "Block"]] };
const confirmHref = (r: TreeRow, event: string) => `/confirm?type=${encodeURIComponent(r.type)}&amp;id=${encodeURIComponent(r.id)}&amp;event=${event}`;

const actLink = (r: TreeRow, ev: string, label: string) => `<a class="act" href="${confirmHref(r, ev)}" data-act="${ev}">${label}</a>`;

const sinceText = (since: Since | undefined, verb: string): string => (since === undefined ? "" : verb + " at seq " + since.seq);

function attentionRow(n: Placed, since: Since | undefined, path: string, verb: string, live: boolean, ctx: Pick<DialogContext, "indexOf" | "rowOf">): string {
  const links = (ROW_ACTIONS[n.row.state] ?? []).map(([ev, label]) => actLink(n.row, ev, label)).join("");
  const acts = live ? `<span class="acts">${links}</span>` : "";
  // a block on a ticket: which one, and once it's closed, that the wait looks over
  const blocker = n.row.state === "blocked" && since?.blocker !== undefined ? ctx.rowOf.get(since.blocker) : undefined;
  const ready = blocker !== undefined && CLOSED.has(blocker.state) ? `<span class="ready" data-ready>ready to unblock</span>` : "";
  const waits = blocker === undefined ? "" : `<span class="by" data-blocked-by>waiting on ${linkTo(blocker.key, ctx)}</span>` + ready;
  return `<li class="att-row" data-attention-key="${esc(n.row.key)}" data-state="${esc(n.row.state)}"><a class="name" href="#t${n.i}">${esc(n.row.id)}</a>`
    + `<span class="path">${path}</span>${waits}<span class="since">${sinceText(since, verb)}</span>${acts}</li>`;
}

function attentionHtml(nodes: Placed[], events: readonly StoredEvent[], stream: string, pathOf: (n: Placed) => string, live: boolean, skip: ReadonlySet<number>): string {
  const { blocked, working } = attentionSince(events, stream, skip);
  const ctx = { indexOf: new Map(nodes.map((n) => [n.row.key, n.i])), rowOf: new Map(nodes.map((n) => [n.row.key, n.row])) };
  const stuck = nodes.filter((n) => n.row.state === "blocked");
  // A finished active parent (every child closed) is no decision for a person: tira closes it
  // when work moves on, so it stays in the tree, not in the count (ruling 2026-10-20).
  const busy = nodes.filter((n) => n.row.active && !n.row.awaitingClose);
  const count = stuck.length + busy.length;
  if (count === 0) {
    const next = nodes.find((n) => n.row.cursor);
    const nextLine = next ? `<p>Next up: <a href="#t${next.i}">${esc(next.row.id)}</a></p>` : `<p>No open work left.</p>`;
    return `<section class="attention calm" data-attention-count="0" aria-label="Needs attention"><div class="att-head"><h2>Nothing needs you</h2></div>${nextLine}</section>`;
  }
  // blocked work, grouped by its reason, groups in the order they first blocked
  const groups = new Map<string, Placed[]>();
  const firstSeq = (n: Placed) => blocked.get(n.row.key)?.seq ?? Number.MAX_SAFE_INTEGER;
  for (const n of [...stuck].sort((a, b) => firstSeq(a) - firstSeq(b) || a.i - b.i)) {
    const why = whyLabel(blocked.get(n.row.key)?.reason);
    groups.set(why, [...(groups.get(why) ?? []), n]);
  }
  const blockedHtml = [...groups].map(([why, ns]) =>
    `<div class="att-group blocked" data-group="blocked" data-reason="${esc(why)}"><h3>Blocked <span class="why">${esc(why)}</span><span class="k">${ns.length}</span></h3>`
    + `<ul class="att-list">${ns.map((n) => attentionRow(n, blocked.get(n.row.key), pathOf(n), "blocked", live, ctx)).join("")}</ul></div>`).join("");
  const workingHtml = busy.length === 0 ? "" : `<div class="att-group working" data-group="in_progress"><h3>In progress<span class="k">${busy.length}</span></h3>`
    + `<ul class="att-list">${busy.map((n) => attentionRow(n, working.get(n.row.key), pathOf(n), "started", live, ctx)).join("")}</ul></div>`;
  const sum = [stuck.length > 0 ? `${stuck.length} blocked` : "", busy.length > 0 ? `${busy.length} in progress` : ""].filter(Boolean).join(" · ");
  return `<section class="attention" data-attention-count="${count}" aria-label="Needs attention"><div class="att-head"><h2><b>${count}</b>${count === 1 ? "needs" : "need"} you</h2><span class="sum">${sum}</span></div>${blockedHtml}${workingHtml}</section>`;
}

// ---------- board ----------

// Kanban: every ticket in its status column; each card names its parent. A parent no one has
// acted on (to do, with subtasks: a grouping, like an epic) stays on the Graph; once it is
// started, blocked or closed it is a card too, saying how many of its subtasks are closed. So a
// task blocked on a new ticket keeps its card (in Blocked), beside the ticket's.
function boardHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links): string {
  const idOf = new Map(nodes.map((n) => [n.row.key, n.row.id]));
  const leaves = nodes.filter((n) => n.row.children.length === 0 || n.row.state !== "unstarted");
  const columns: [string, string, string][] = [
    ["unstarted", "To do", "var(--dim)"], ["in_progress", "In progress", "var(--prog)"], ["blocked", "Blocked", "var(--block)"],
    ["done", "Done", "var(--done)"], ["cancelled", "Dropped", "var(--gone)"],
  ];
  const cols = columns.filter(([s]) => s !== "blocked" || leaves.some((n) => n.row.state === s)).map(([s, title, color]) => {
    const here = leaves.filter((n) => n.row.state === s);
    const cards = here.map((n) => {
      const r = n.row;
      const cls = ["card", r.cursor ? "is-next" : "", r.state === "cancelled" ? "is-gone" : ""].filter(Boolean).join(" ");
      const lines = (trail.get(r.key) ?? []).length;
      const parent = n.parent ? `<span class="chip">${esc(n.parent.row.id)}</span>` : "";
      const kids = r.children.length === 0 ? "" : `<span class="chip" data-subtasks>${r.children.filter((c) => CLOSED.has(c.state)).length}/${r.children.length} subtasks</span>`;
      const found = r.discoveredDuring ? `<span class="chip" title="found during ${esc(bare(r.discoveredDuring))}">${ICON.spark}found</span>` : "";
      const blocks = (links.blocks.get(r.key) ?? []).map((k) => idOf.get(k) ?? bare(k));
      const by = links.blockedBy.get(r.key);
      const link = (blocks.length > 0 ? `<span class="chip blocks" data-blocks>${ICON.ban}blocks ${esc(blocks.join(", "))}</span>` : "")
        + (by === undefined ? "" : `<span class="chip blocks">blocked by ${esc(idOf.get(by) ?? bare(by))}</span>`);
      return `<a class="${cls}" href="#t${n.i}">${r.cursor ? `<span class="pin">◆ ${r.active ? "now" : "next"}</span>` : ""}<div class="t">${esc(r.id)}</div>`
        + `<div class="row">${parent}${kids}${found}${link}<span class="hist" title="history">${ICON.history}${lines}</span></div></a>`;
    }).join("");
    return `<div class="col"><div class="ch"><span class="dot" style="background:${color}"></span>${title}<span class="k">${here.length}</span></div>${cards || `<p class="empty">Nothing here</p>`}</div>`;
  }).join("");
  return `<div class="cols">${cols}</div>`;
}

// ---------- lanes (D2: regions composed, handoffs paired) ----------

// The board holds the tree (as Kanban or as a graph); Lanes shows only when the stream has
// something for it (the factory's briefs, other records, handoffs); History is the whole
// log, the audit trail.
const VIEWS: [string, string][] = [["board", "Board"], ["lanes", "Lanes"], ["log", "History"]];

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
  const ready = new Set(r.frontier[stream] ?? []);
  const superseded = (e: EntityState) => e.version !== undefined && inStream.some((x) => x.type === e.type && x.id === e.id && x.version === (e.version as number) + 1);
  const avatar = (who: unknown) => `<span class="av" aria-hidden="true">${esc(([...show(who)][0] ?? "?").toUpperCase())}</span>`;
  const rows = multi.map((e) => {
    const cells = Object.entries(e.regions).map(([region, state]) => {
      const cap = e.context?.[region] ?? {};
      const extra = [
        cap.claimant !== undefined ? `<span class="cap" title="claimed by ${esc(show(cap.claimant))}">${avatar(cap.claimant)}${esc(show(cap.claimant))}</span>` : "",
        cap.block_reason !== undefined ? `<span class="cap">${esc(show(cap.block_reason))}</span>` : "",
      ].join("");
      return `<div class="lane" data-lane="${esc(e.key)}" data-region="${esc(region)}" data-state="${esc(state)}">${pill(state)}${extra}</div>`;
    }).join("");
    const label = `${e.id}${e.version === undefined ? "" : `@${e.version}`}`;
    const needs = (r.derived[stream]?.[e.key]?.waitingOn as string[] | undefined) ?? [];
    const tag = ready.has(e.key) ? `<span class="ready">claimable now</span>` : needs.length > 0 && !superseded(e) ? `<span class="needs">needs ${needs.map(esc).join(", ")}</span>` : "";
    return `<div class="who${superseded(e) ? " old" : ""}" title="${esc(e.key)}${superseded(e) ? " (superseded)" : ""}" data-frontier="${ready.has(e.key)}">${esc(label)}${tag}</div>${cells}`;
  }).join("");
  const regionNames = multi[0] ? Object.keys(multi[0].regions) : [];
  const label = (text: string) => `<h3 class="lanes-label">${text}</h3>`;
  const gridTitle = esc(multi[0]?.type ?? "") + "s, one lane per dial: " + regionNames.map(esc).join(" · ");
  const grid = multi.length === 0 ? "" : `${label(gridTitle)}<div class="lanes" style="--n:${regionNames.length}" aria-label="Regions"><div class="lh"></div>${regionNames.map((n) => `<div class="lh">${esc(n)}</div>`).join("")}${rows}</div>`;
  const singles = inStream.filter((e) => Object.keys(e.regions).length === 1 && !e.tree);
  const chips = singles.length === 0 ? "" : `${label("Sessions, drops and other records")}<div class="chips2">${singles.map((e) => {
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
  const handoffTitle = "Handoffs: " + waiting.length + " waiting, " + pairs.length + " done";
  const handoffs = pairs.length + waiting.length === 0 ? "" : `${label(handoffTitle)}<ul class="pairs" aria-label="Handoffs">${[...waiting, ...pairs].join("")}</ul>`;
  if (!grid && !chips && !handoffs) return ""; // nothing for the Lanes tab: it isn't shown
  return `${grid}${chips}${handoffs}`;
}


// ---------- activity ----------

function logHtml(all: TrailEntry[], anomalies: FoldResult["anomalies"], others: EntityState[], rejections: Rejection[], dumpHash: string): string {
  const alert = anomalies.length === 0 ? "" : `<div class="alert">${anomalies.length} ${anomalies.length === 1 ? "anomaly" : "anomalies"} on replay</div><ol class="feed">${anomalies.map((a) => `<li class="ev refused"><span class="av" aria-hidden="true">!</span><div class="ev-body"><div class="ev-head"><span class="ev-what">${esc(a.type)}</span><span class="ev-seq">seq ${a.seq}</span></div><div class="ev-detail">${esc(a.problem)}</div></div></li>`).join("")}</ol>`;
  const feed = all.length === 0 ? `<p class="empty">No events yet</p>` : `<ol class="feed">${[...all].reverse().map((x) => entryHtml(x, true)).join("")}</ol>`;
  const othersHtml = others.length === 0 ? "" : `<h3>Other entities</h3><div class="others">${others.map((e) => `<span class="chip">${esc(e.key)} · ${esc(Object.values(e.regions).join(" "))}</span>`).join("")}</div>`;
  const legacy = all.filter((x) => x.legacy).length;
  const legacyNote = legacy === 0 ? "" : ` · ${legacy} legacy`;
  return `<div class="log">${alert}<h3>Newest first · ${all.length} events · ${rejections.length} rejected${legacyNote}</h3>${feed}${othersHtml}<h3>Dump hash</h3><div class="hash">sha256:${esc(dumpHash)}</div></div>`;
}

// ---------- page ----------

// How to read the page: one time and on demand (the brief), never on the worksurface.
// Three short paragraphs, opened from the nav and from the hash chip.
function guideHtml(dumpHash: string): string {
  return `<section class="drawer guide" id="guide" aria-label="How to read this page" role="dialog" aria-modal="true" data-guide>${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a><h2>How to read this page</h2>`
    + `<p><b>The board.</b> Kanban puts each task in its status column. Graph shows the whole tree instead: a parent above its children, each coloured by state, and a line turns green once that child is closed; a dotted line joins a task to the one it was found while working on. ◆ marks the next task ("now" once started). "Needs attention" at the top lists what is blocked, and why, and what is being worked on.</p>`
    + `<p><b>By tira.</b> A bolt on a parent means tira closed it: every child was done or cancelled, you moved on, and tira recorded the close under its own name, citing your move. A dashed ring means tira will close it when you move on. Click any task for its full history.</p>`
    + `<p><b>The hash.</b> The chip at the top is a fingerprint of everything on this page: the sha256 of the replayed log. Run <code>tira dump --hash</code> on the same log; the same value means this page shows exactly what the log says. Full value: <code>${esc(dumpHash)}</code></p></div></section>`;
}

// The product mark, on every page's top bar (the confirm page's too).
export const BRAND = `<span class="brand">${ICON.brand}tira</span>`;

// The theme switch, top right on every page: System (the default), Light or Dark. Radio
// inputs before <main> and labels in the top bar, so it works with no script; under
// tira serve, theme.mjs remembers the choice per browser.
const THEMES: [string, string, string][] = [["system", "System", ICON.system], ["light", "Light", ICON.sun], ["dark", "Dark", ICON.moon]];
export const THEME_RADIOS = THEMES.map(([t, label]) => `<input class="view-radio" type="radio" name="theme" id="th-${t}"${t === "system" ? " checked" : ""} aria-label="${label} theme" data-theme-choice="${t}">`).join("");
export const THEME_SWITCH = `<span class="theme" data-theme-switch>${THEMES.map(([t, label, icon]) => `<label for="th-${t}" title="${label}">${icon}</label>`).join("")}</span>`;

// The top bar: views, the search button (live only), the guide link and the hash chip.
// ---------- divergence (B3 watchdog, D3's panel) ----------
// A view of the report `tira divergence --json` emits: the caller runs the one differ
// (src/divergence/divergence.ts) at read time and hands the report here; this section never
// diffs, stores or caches. Three explicit states: divergences (counts + the non-OK rows),
// clean (an explicit "0 divergences"), and UNEVALUABLE when the inputs could not be read or
// the report lacks its coordinates or population — never a blank and never a bare 0, since
// a 0 nobody computed is the stale-0 this panel exists to kill. Warn-only (severity policy
// v1): the panel stops nothing.
export type DivergencePanel = { report: DivergenceReport } | { unevaluable: string };

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

// Why a report cannot be shown as one, or undefined when it can.
export function reportDefect(r: DivergenceReport): string | undefined {
  const f = r?.coordinates?.factory;
  const t = r?.coordinates?.tira;
  if (typeof f?.snapshot !== "string" || f.snapshot === "" || typeof t?.stream !== "string" || t.stream === "" || !isCount(t.atSeq)) return "the report has no coordinates (factory snapshot, tira stream and atSeq)";
  const p = r.population;
  if (!isCount(p?.factoryRecords) || !isCount(p?.tiraFxEvents) || !isCount(p?.ids)) return "the report has no population (factory records, tira fx: events, ids in the union)";
  if (!VERDICTS.every((v) => isCount(r.counts?.[v])) || !Array.isArray(r.findings)) return "the report has no per-verdict counts or findings";
  const total = VERDICTS.reduce((a, v) => a + r.counts[v], 0);
  if (total !== p.ids || total - r.counts.OK !== r.findings.length) return `the report does not add up: ${total} verdict(s), ${p.ids} id(s), ${r.findings.length} finding(s)`;
  return undefined;
}

const unevaluableHtml = (why: string) =>
  `<section class="divergence unevaluable" data-divergence-state="unevaluable" aria-label="Divergence"><div class="att-head"><h2>Divergence UNEVALUABLE</h2>`
  + `<span class="sum">factory vs tira could not be compared, so no count is shown</span></div><p class="why" data-unevaluable-reason>${esc(why)}</p></section>`;

export function divergenceHtml(panel: DivergencePanel): string {
  if ("unevaluable" in panel) return unevaluableHtml(panel.unevaluable);
  const r = panel.report;
  const defect = reportDefect(r);
  if (defect !== undefined) return unevaluableHtml(defect);
  const n = r.findings.length;
  const f = r.coordinates.factory;
  const counts = VERDICTS.map((v) => `<li class="${v !== "OK" && r.counts[v] > 0 ? "hit" : ""}" data-verdict="${v}" data-count="${r.counts[v]}">${v}<b>${r.counts[v]}</b></li>`).join("");
  const head = n === 0 ? `<h2>0 divergences</h2>` : `<h2><b>${n}</b>${n === 1 ? "divergence" : "divergences"}</h2>`;
  const rows = n === 0 ? "" : `<ol class="dv-rows">${r.findings.map((x) =>
    `<li class="dv-row" data-event-id="${esc(x.event_id)}" data-verdict="${esc(x.verdict)}"><span class="v">${esc(x.verdict)}</span><span class="id">${esc(x.event_id)}</span><span class="detail">${esc(x.detail)}</span></li>`).join("")}</ol>`;
  const meta = `<p class="dv-meta" data-factory-snapshot="${esc(f.snapshot)}" data-stream="${esc(r.coordinates.tira.stream)}" data-at-seq="${r.coordinates.tira.atSeq}"`
    + ` data-factory-records="${r.population.factoryRecords}" data-tira-fx-events="${r.population.tiraFxEvents}" data-ids="${r.population.ids}">`
    + `factory ${f.file !== undefined ? `${esc(f.file)} ` : ""}(${esc(f.pin)} <code>${esc(f.snapshot)}</code>) · tira stream ${esc(r.coordinates.tira.stream)} at seq ${r.coordinates.tira.atSeq}<br>`
    + `read ${r.population.factoryRecords} factory record(s) · ${r.population.tiraFxEvents} tira fx: event(s) · ${r.population.ids} event id(s) in the union · severity policy ${esc(r.severityPolicy)}: warn-only, stops nothing</p>`;
  return `<section class="divergence ${n === 0 ? "clean" : "divergent"}" data-divergence-state="${n === 0 ? "clean" : "divergent"}" data-divergence-count="${n}" aria-label="Divergence">`
    + `<div class="att-head">${head}<span class="sum">factory file state vs tira's log, computed at read time</span></div><ul class="dv-counts">${counts}</ul>${rows}${meta}</section>`;
}

function navHtml(dumpHash: string, lastSeq: number, live: boolean, views: [string, string][]): string {
  const shortHash = dumpHash.length > 16 ? `${dumpHash.slice(0, 8)}…${dumpHash.slice(-6)}` : dumpHash;
  const tabs = views.map(([t, label]) => `<label for="v-${t}">${label}</label>`).join("");
  const search = live ? `<button class="kbd" type="button" data-open-palette>Search ⌘K</button>` : "";
  return `<nav class="top">${BRAND}<div class="tabs">${tabs}</div>${search}<a class="how" href="#guide">How to read this page</a>`
    + `<a class="verify" href="#guide" title="sha256:${esc(dumpHash)}: a fingerprint of this page (compare with tira dump --hash)"><span class="vl">fingerprint</span> seq ${lastSeq} · ${esc(shortHash)}</a>${THEME_SWITCH}</nav>`;
}

// The last action's result, under tira serve.
function flashHtml(flash: { ok: boolean; text: string } | undefined): string {
  if (!flash) return "";
  return `<div class="flash ${flash.ok ? "ok" : "no"}" role="status" data-flash>${esc(flash.text)}</div>`;
}

export interface RenderOptions {
  // `tira serve`: rows and task dialogs get actions (each through a confirm dialog), the ⌘K
  // palette loads, and the last action's result shows. A rendered file never carries any of it.
  live?: { flash?: { ok: boolean; text: string } };
  // The divergence report the caller just computed (or why it could not), shown as a section.
  divergence?: DivergencePanel;
}

// Each task's proof of work: the evidence on its latest completion since its last re-open.
export function proofsOf(events: readonly StoredEvent[], stream: string, skip: ReadonlySet<number>): Map<string, Proof> {
  const proofs = new Map<string, Proof>();
  for (const e of events) {
    if (e.stream !== stream || skip.has(e.seq) || e.type === REJECTED) continue; // only what replay applied
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const dot = e.type.indexOf(".");
    const key = `${e.type.slice(0, dot)}:${d.entity.id}`;
    const ev = e.type.slice(dot + 1);
    const ref = d.payload?.evidenceRef;
    if (ev === "reopen") proofs.delete(key);
    if (ev === "complete" && typeof ref === "string" && !proofs.has(key)) proofs.set(key, { ref, actor: e.metadata.actor ?? "no actor", seq: e.seq });
  }
  return proofs;
}

export function renderHtml(r: FoldResult, stream: string, dumpHash: string, events: readonly StoredEvent[] = [], opts: RenderOptions = {}): string {
  const live = opts.live !== undefined;
  const v = streamView(r, stream);
  events = events.filter((e) => e.seq <= r.lastSeq); // render --at N: no history from after N
  const rejections = r.rejections.filter((x) => x.stream === stream);
  const anomalies = r.anomalies.filter((a) => a.stream === stream);
  const rows = flatten(v.roots);
  const mine = r.entities.filter((e) => e.stream === stream);
  const multiNow = mine.filter((e) => Object.keys(e.regions).length > 1 && !(e.version !== undefined && mine.some((x) => x.type === e.type && x.id === e.id && x.version === (e.version as number) + 1)));
  const { byKey: trail, all } = trails(events, stream);
  const nodes = indexNodes(v.roots);
  const pathOf = (n: Placed) => {
    const up: string[] = [];
    for (let p = n.parent; p; p = p.parent) up.unshift(esc(p.row.id));
    return up.length > 0 ? up.join(" › ") : "top level";
  };
  // The header counts what this stream is about: a tree's closed nodes, or (a stream of
  // multi-region entities, like the factory's briefs) the verified ones still current.
  const lanesOnly = v.roots.length === 0 && multiNow.length > 0;
  // A tree's header counts its tasks (the leaves: the board's cards), closed of total.
  const tasks = rows.filter((x) => x.children.length === 0);
  const closed = lanesOnly ? multiNow.filter((e) => e.regions.outcome === "done-verified").length : tasks.filter((x) => CLOSED.has(x.state)).length;
  const total = lanesOnly ? multiNow.length : tasks.length;
  const handoffCount = new Set(events.filter((e) => e.stream === stream && e.metadata.actor === "dispatcher" && e.metadata.correlationId).map((e) => e.metadata.correlationId)).size;
  const stats = [
    ...(lanesOnly
      ? [`<li title="handoff pairs the dispatcher completed"><b>${handoffCount}</b> handoffs</li>`, `<li title="handoffs still waiting"><b>${r.handoffs[stream]?.length ?? 0}</b> waiting</li>`]
      : [`<li title="tasks still open"><b>${total - closed}</b> left</li>`, `<li title="parents closed by tira">${ICON.auto}<b>${rows.filter((x) => x.closedByTira).length}</b> by tira</li>`, `<li title="drained: every child done or cancelled"><b>${rows.filter((x) => x.drained).length}</b> drained</li>`]),
    `<li title="rejected commands">${ICON.ban}<b>${rejections.length}</b> rejected</li>`,
    ...(anomalies.length > 0 ? [`<li class="warn" title="replay anomalies">${ICON.alert}<b>${anomalies.length}</b> anomalies</li>`] : []),
  ];
  // Counted from the fold, independently of the rendered rows: M1 compares the two.
  const foldTreeCount = r.entities.filter((e) => e.stream === stream && e.tree !== undefined).length;
  const lanes = lanesHtml(r, stream, events);
  const views = VIEWS.filter(([t]) => t !== "lanes" || lanes !== "");
  // Open on the view that has something: the tree, else the lanes, else the history.
  const lanesFirst = lanes !== "" && (multiNow.length > 0 || (r.handoffs[stream]?.length ?? 0) > 0);
  let first = "log";
  if (v.roots.length > 0) first = "board";
  else if (lanesFirst) first = "lanes";
  const skip = new Set(anomalies.map((a) => a.seq));
  const proofs = proofsOf(events, stream, skip);
  const indexOf = new Map(nodes.map((n) => [n.row.key, n.i]));
  const rowOf = new Map(nodes.map((n) => [n.row.key, n.row]));
  const links = linksOf(attentionSince(events, stream, skip).blocked, new Set(rowOf.keys()));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tira · ${esc(stream)}</title><style>${CSS}</style></head>
<body>${views.map(([t, label]) => `<input class="view-radio" type="radio" name="view" id="v-${t}"${t === first ? " checked" : ""} aria-label="${label} view">`).join("")}${THEME_RADIOS}
<main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}">
${navHtml(dumpHash, v.lastSeq, live, views)}
${flashHtml(opts.live?.flash)}
<header class="hero"><div class="big" title="${lanesOnly ? "verified briefs, of those current" : "tasks closed, of all tasks"}">${closed}<small>/${total}</small></div><div class="who"><h1>${esc(stream)}</h1><ul class="stats">${stats.join("")}</ul></div></header>
${opts.divergence !== undefined ? divergenceHtml(opts.divergence) : ""}
${v.roots.length > 0 ? attentionHtml(nodes, events, stream, pathOf, live, skip) : ""}
<section class="view view-board" aria-label="Board">${v.roots.length > 0 ? boardView(nodes, trail, links) : `<p class="empty">No tree yet.</p>`}</section>
${lanes === "" ? "" : `<section class="view view-lanes" aria-label="Lanes">${lanes}</section>`}
<section class="view view-log" aria-label="History">${logHtml(all, anomalies, v.others, rejections, dumpHash)}</section>
${nodes.map((n) => drawerHtml(n, trail.get(n.row.key) ?? [], pathOf(n), { indexOf, proof: proofs.get(n.row.key), live, links, rowOf })).join("")}
${guideHtml(dumpHash)}
</main>${live ? `<script type="module" src="/app.mjs"></script>` : ""}</body></html>
`;
}
