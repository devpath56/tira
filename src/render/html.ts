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
import { esc } from "./escape.ts";
import { foundPath, fx, layout, tint, treePath } from "../serve/layout.mjs";
import { IDEA, OPEN_STAGES, TASK, ideaRows, stageWord, type IdeaRow } from "../fold/ideas.ts";
import { linksOf as taskLinksOf, workspaceOf, type TaskLinks, type WorkspaceLink } from "../fold/workspace.ts";
import { LINK_TYPES } from "../tables/links.ts";

const bare = (key: string) => key.replace(/^[^:]+:/, "");
// The node table's closed states (its tree config's terminal list), for progress.
const CLOSED = new Set(["done", "cancelled"]);
// A graph box shows a task's name in words (underscores as spaces) on up to two lines; the
// box's title, aria-label and dialog keep the exact id.
const spaced = (id: string) => id.replaceAll("_", " ");
// A card's title wraps after an underscore, never inside a word (the text stays the exact id).
const wraps = (id: string) => esc(id).replaceAll("_", "_<wbr>");

// Jira's palette (Atlassian's design tokens), in both themes: white or near-black surfaces, the
// sidebar a shade off, Jira blue as the one accent, Jira's status lozenges (grey to do, blue in
// progress, green done, red blocked). The finish is Apple's (the HIG): rounded corners, capsule
// buttons, soft shadows, the system font for labels, motion that eases and gives on a press, a type
// scale of 11 12 13 14 15 17 20 22 24 28 (nothing under 11), spacing on a 4-point rhythm, icons with
// even rounded strokes like Apple's symbols, and 44-point touch targets on a touch screen. The theme follows the system unless the
// switch picks one (radio inputs, so it is CSS only); print is always light.
const LIGHT = `--bg:#ffffff;--side-bg:#f8f8f8;--panel:#ffffff;--panel-2:#f7f8f9;--sunken:#f7f8f9;--raised:#ffffff;--hover:#f0f1f2;--line:#dcdfe4;--line-2:#b7bcc4;--fg:#292a2e;--mut:#505258;--dim:#6b6e76;
--accent:#1868db;--accent-bg:#e9f2fe;--accent-text:#1558bc;--btn:#1868db;--btn-fg:#ffffff;
--prog:#1558bc;--prog-bg:#e9f2fe;--block:#ae2e24;--block-bg:#ffeceb;--done:#216e4e;--done-bg:#dcfff1;--gone:#6b6e76;--gone-bg:#f0f1f2;--warn:#a54800;--warn-bg:#fff7d6;
--loz-todo:#dddee1;--loz-todo-fg:#292a2e;--loz-prog:#8fb8f6;--loz-prog-fg:#1c2b42;--loz-done:#b3df72;--loz-done-fg:#1e2e0c;--loz-block:#fd9891;--loz-block-fg:#42221f;
--shadow:0 1px 2px rgba(30,31,33,.06),0 0 1px rgba(30,31,33,.2);--shadow-raised:0 10px 30px rgba(30,31,33,.12),0 0 1px rgba(30,31,33,.25);--brand:#1868db`;
const DARK = `--bg:#1f1f21;--side-bg:#1a1a1c;--panel:#242528;--panel-2:#2b2c2f;--sunken:#1a1a1c;--raised:#2b2c2f;--hover:#303134;--line:#3b3d42;--line-2:#56585e;--fg:#cecfd2;--mut:#a9abaf;--dim:#96999e;
--accent:#669df1;--accent-bg:#1c2b42;--accent-text:#8fb8f6;--btn:#669df1;--btn-fg:#1f1f21;
--prog:#8fb8f6;--prog-bg:#1c2b42;--block:#fd9891;--block-bg:#42221f;--done:#7ee2b8;--done-bg:#1c3329;--gone:#96999e;--gone-bg:#2b2c2f;--warn:#f5cd47;--warn-bg:#3a2f12;
--loz-todo:#4b4d51;--loz-todo-fg:#cecfd2;--loz-prog:#1558bc;--loz-prog-fg:#e9f2fe;--loz-done:#4c6b1f;--loz-done-fg:#efffd6;--loz-block:#ae2e24;--loz-block-fg:#ffeceb;
--shadow:none;--shadow-raised:0 12px 32px rgba(1,4,4,.45),0 0 0 1px rgba(255,255,255,.06);--brand:#669df1`;
export const CSS = `
:root{color-scheme:light dark;${LIGHT};--r-lg:12px;--r:8px;--ease:cubic-bezier(.25,.1,.25,1);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--serif:ui-serif,"New York","Iowan Old Style",Palatino,Georgia,serif}
@media screen and (prefers-contrast:more){:root{--line:#8e8e93}}
@media screen and (prefers-color-scheme:dark){:root{${DARK}}}
:root:has(#th-light:checked){color-scheme:light;${LIGHT}}
@media screen{:root:has(#th-dark:checked){color-scheme:dark;${DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--fg);font:14px/1.5 var(--sans);background:var(--bg);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
main{max-width:1240px;margin:0 auto;padding:0 28px 72px;position:relative}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;min-height:56px;padding:8px 0;border-image:linear-gradient(to top,var(--line) 1px,var(--bg) 1px) fill 0/0/0 100vmax}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:650;font-size:17px;letter-spacing:-.01em;color:var(--fg);padding-right:8px}
.brand svg{width:24px;height:24px;color:var(--brand)}a.brand{border-radius:var(--r)}a.brand:hover{opacity:.8}
.ws{position:relative}.ws>summary{list-style:none;display:inline-flex;align-items:center;gap:6px;max-width:240px;height:32px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r);background:var(--panel);font-weight:600;font-size:13px;cursor:pointer}
.ws>summary::-webkit-details-marker{display:none}.ws>summary:hover{background:var(--hover)}.ws>summary svg{flex:none;width:13px;height:13px;color:var(--dim)}.ws[open]>summary svg{transform:rotate(180deg)}
.ws-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:30;width:min(320px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;padding:6px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-raised)}
.ws-head{margin:0;padding:6px 10px 4px;font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim)}
.ws-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--r);color:var(--fg);transition:background .15s var(--ease)}.ws-item[hidden]{display:none}.ws-item:hover,.ws-item:focus-visible{background:var(--hover)}
.ws-item[aria-current=page]{background:var(--accent-bg)}.ws-item .ws-t{min-width:0;flex:1;display:grid;gap:1px}.ws-item b{font-weight:600;overflow-wrap:anywhere}.ws-item small{font-size:12px;color:var(--mut)}
.ws-item .ws-n{flex:none;min-width:22px;height:20px;padding:0 6px;display:grid;place-items:center;border-radius:999px;font-size:12px;font-weight:650;color:var(--btn-fg);background:var(--btn)}
.ws-item .ws-n.calm{color:var(--mut);background:var(--panel-2);border:1px solid var(--line)}.ws-note{margin:0;padding:8px 10px;color:var(--dim);font-size:13px}
.tabs{display:flex;align-self:stretch;margin:-8px 0}
.tabs label{display:flex;align-items:center;cursor:pointer;font-weight:550;font-size:14px;padding:0 10px;color:var(--mut);border-top:2px solid transparent;border-bottom:2px solid transparent}
.tabs label:hover{color:var(--fg)}
.view-radio{position:absolute;opacity:0;pointer-events:none}
#v-board:checked~main .tabs label[for=v-board],#v-lanes:checked~main .tabs label[for=v-lanes]{color:var(--accent);border-bottom-color:var(--accent)}
#v-board:focus-visible~main .tabs label[for=v-board],#v-lanes:focus-visible~main .tabs label[for=v-lanes]{outline:2px solid var(--accent);outline-offset:-2px}
.proj-search{margin-left:auto;min-width:190px;display:flex;align-items:center;gap:8px;padding:0 10px;height:32px;color:var(--dim);background:var(--panel);border:1px solid var(--line-2);border-radius:var(--r);cursor:text;transition:border-color .18s var(--ease),box-shadow .18s var(--ease)}
.proj-search svg{flex:none;width:14px;height:14px}.proj-search input{flex:1;min-width:0;border:0;background:none;outline:0;font:500 13px var(--sans);color:var(--fg)}.proj-search input::placeholder{color:var(--dim)}
.proj-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.side-link{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--r);font-size:14px;color:var(--mut);transition:background .15s var(--ease),color .15s var(--ease)}.side-link:hover{background:var(--hover);color:var(--fg)}.side-link svg{width:15px;height:15px}
.find{order:-1;flex:1 1 220px;max-width:440px;margin-right:24px;align-self:flex-end;display:flex;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;font:500 13px var(--sans);color:var(--dim);text-align:left;background:var(--panel-2);border:1px solid var(--line);border-radius:999px;cursor:pointer;transition:background .18s var(--ease),border-color .18s var(--ease),transform .1s var(--ease)}
.find:hover{background:var(--hover);border-color:var(--line-2)}.find svg{flex:none;width:15px;height:15px}.find span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.find kbd{flex:none;font:500 11px var(--sans);color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.help{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--mut);border-radius:var(--r);padding:4px 8px}.help:hover{color:var(--fg);background:var(--hover)}.help svg{width:16px;height:16px}
.side-foot{display:flex;align-items:center;gap:8px;margin-left:auto}
.pav{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;font:650 11px/1 var(--sans);color:#fff;background:var(--t)}
.t0{--t:#5e6ad2}.t1{--t:#0f7b6c}.t2{--t:#b4426b}.t3{--t:#8a5a00}.t4{--t:#2f6fb0}.t5{--t:#7a4fc9}.t6{--t:#3d7a2e}.t7{--t:#b04a2a}
.me .av{width:22px;height:22px;font-size:11px}.me>summary{gap:8px}
.me-menu .ws-item{flex-direction:column;align-items:flex-start;gap:1px;width:100%;font:inherit;font-size:13px;text-align:left;background:none;border:0;cursor:pointer}.me-menu form{margin:0}
.new-project{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--r);font-size:13px;color:var(--mut);transition:background .15s var(--ease),color .15s var(--ease)}.new-project:hover{background:var(--hover);color:var(--fg)}.new-project svg{width:14px;height:14px}
.log-top{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin:16px 0 4px}.log-top h3{margin:0}
.how{margin-left:auto;font-size:13px;color:var(--accent)}.how:hover{text-decoration:underline}.kbd~.how{margin-left:0}
.verify{font-family:var(--mono);font-size:12px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r);padding:4px 10px;white-space:nowrap}
a.verify:hover{color:var(--fg);border-color:var(--line-2)}.verify .vl{font-family:var(--sans);font-weight:600;color:var(--fg);margin-right:4px}
.theme{display:inline-flex;gap:2px;padding:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:999px}.brand+.theme{margin-left:auto}
.theme label{display:grid;place-items:center;width:28px;height:24px;border-radius:999px;color:var(--dim);cursor:pointer;transition:background .18s var(--ease),color .18s var(--ease)}
.theme label:hover{color:var(--fg)}.theme svg{width:15px;height:15px}
#th-system:checked~main .theme label[for=th-system],#th-light:checked~main .theme label[for=th-light],#th-dark:checked~main .theme label[for=th-dark]{color:var(--accent-text);background:var(--accent-bg)}
#th-system:focus-visible~main .theme label[for=th-system],#th-light:focus-visible~main .theme label[for=th-light],#th-dark:focus-visible~main .theme label[for=th-dark]{outline:2px solid var(--accent);outline-offset:1px}
.flash{margin:16px 0 0;padding:10px 16px;border-radius:var(--r-lg);font-size:13px;color:var(--fg);background:var(--panel);border:1px solid var(--line)}
.flash.ok{border-color:color-mix(in srgb,var(--done) 30%,transparent);background:var(--done-bg)}.flash.no{border-color:color-mix(in srgb,var(--block) 30%,transparent);background:var(--block-bg)}
.hero{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px 0;margin:36px 0 26px}
.hero .who{display:contents}
.hero h1{font-size:28px;font-weight:650;letter-spacing:-.02em;line-height:1.15;overflow-wrap:anywhere}
.hero h1{display:flex;align-items:center;gap:12px;margin:0}.hero h1 .pav{width:30px;height:30px;border-radius:9px;font-size:15px}
.hero .title{order:-2;flex:1 1 100%;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 16px;justify-items:start}.hero .title>h1,.hero .title>.title-acts{grid-column:1}
.proj-links{grid-column:2;grid-row:1;justify-self:end;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}
.pl{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:13px;font-weight:600;color:var(--fg);transition:background .15s var(--ease),border-color .15s var(--ease)}.pl:hover{background:var(--hover);border-color:var(--line-2)}
.pl svg,.proj-links .act svg{width:15px;height:15px;flex:none}.ico-jira{color:#2684ff}.act.primary .ico-jira{color:inherit}
.title-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:42px}
@keyframes beat{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 55%,transparent)}70%,100%{box-shadow:0 0 0 7px transparent}}
.hero{position:relative;isolation:isolate}.hero::before{content:"";position:absolute;z-index:-1;left:-80px;right:-80px;top:-96px;height:280px;pointer-events:none;background:radial-gradient(560px 220px at 12% 35%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%),radial-gradient(460px 200px at 88% 0%,color-mix(in srgb,#7c3aed 13%,transparent),transparent 70%)}
.mover{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:999px;font:650 11px/1 var(--sans);color:#fff;background:var(--t)}.mover svg{width:11px;height:11px}
.mover.agent{color:#fff;background:linear-gradient(135deg,#7c3aed,#2563eb 60%,#06b6d4);box-shadow:0 0 0 2px color-mix(in srgb,#7c3aed 22%,transparent)}
.card .mover{margin-left:auto}.card .mover+.hist{margin-left:4px}
@property --spin{syntax:"<angle>";inherits:false;initial-value:0deg}
.card[data-state="in_progress"]{border-color:transparent;background:linear-gradient(var(--raised),var(--raised)) padding-box,conic-gradient(from var(--spin),var(--prog),#7c3aed,#06b6d4,var(--prog)) border-box;animation:spin 4s linear infinite}
@keyframes spin{to{--spin:360deg}}
.dot.pulse{color:var(--prog);animation:beat 2s var(--ease) infinite;border-radius:999px}
.history-btn{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border:0;border-radius:999px;font-size:13px;font-weight:600;color:var(--mut);background:var(--panel-2);transition:background .18s var(--ease),color .18s var(--ease),transform .1s var(--ease)}
.history-btn:hover{color:var(--fg);background:var(--hover)}.history-btn:active{transform:scale(.97)}.history-btn svg{width:14px;height:14px}
.history-btn .k{min-width:22px;padding:0 6px;border-radius:999px;font:600 11px/18px var(--sans);font-variant-numeric:tabular-nums;text-align:center;color:var(--mut);background:var(--bg)}
.drawer.log-dialog .modal-box{width:min(880px,100%)}.drawer.log-dialog .log{border:0;box-shadow:none;padding:0}.drawer.log-dialog .divergence{margin-top:12px}
.big{flex:none;font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}
.big small{font-size:.66em;font-weight:500;letter-spacing:0;color:var(--dim)}
.big::before{content:attr(title);display:block;margin-bottom:6px}
.big::before,.stats li{font:600 11px/1.3 var(--sans);letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}
.stats{display:flex;flex:0 1 auto;min-width:0;flex-wrap:wrap;gap:12px 0;margin:0;padding:0;list-style:none}
.stats li{display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:6px;margin-left:22px;padding-left:22px;border-left:1px solid var(--line)}
.stats b{font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1.15;text-transform:none;color:var(--fg);font-variant-numeric:tabular-nums}
.stats svg{display:none}
.stats .warn,.stats .warn b{color:var(--block)}
.view{display:none;margin-top:16px}
#v-board:checked~main .view-board,#v-lanes:checked~main .view-lanes{display:block}
.attention{margin:0 0 16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.att-head{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;padding:12px 16px}
.att-head h2{margin:0;font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px}
.att-head h2 b{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 6px;border-radius:999px;font-size:12px;font-weight:650;color:var(--btn-fg);background:var(--btn);font-variant-numeric:tabular-nums}
.att-head .sum{color:var(--mut);font-size:13px}
.att-fold>summary{list-style:none;cursor:pointer;transition:background .15s var(--ease)}.att-fold>summary::-webkit-details-marker{display:none}.att-fold>summary:hover{background:var(--hover)}
.att-chev{flex:none;margin-left:auto;width:8px;height:8px;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(45deg);transition:transform .2s var(--ease)}.att-fold:not([open]) .att-chev{transform:rotate(-45deg)}
.att-group h3{margin:0;padding:8px 16px 8px 33px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--panel-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
.att-group.blocked h3{color:var(--block)}.att-group.working h3{color:var(--prog)}
.att-group h3 .why{text-transform:none;letter-spacing:0;font-weight:600;font-size:13px;color:var(--fg);overflow-wrap:anywhere}
.att-group h3 .k,.att-group summary .k{display:inline-grid;place-items:center;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--mut);font:600 11px var(--sans);letter-spacing:0}
details.att-group>summary{list-style:none;display:flex;align-items:center;gap:10px;min-height:40px;padding:8px 16px;border-top:1px solid var(--line);cursor:pointer;font-size:13px}
details.att-group>summary::-webkit-details-marker{display:none}details.att-group>summary:hover{background:var(--hover)}
details.att-group>summary::before{content:"";flex:none;width:7px;height:7px;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(-45deg);transition:transform .15s ease}
details.att-group[open]>summary::before{transform:rotate(45deg)}details.att-group[open]>summary{background:var(--panel-2);border-bottom:1px solid var(--line)}
details.att-group .kind{flex:none;font:700 11px/16px var(--sans);letter-spacing:.02em;text-transform:uppercase;padding:0 6px;border-radius:5px;color:var(--loz-block-fg);background:var(--loz-block)}
details.att-group .why{flex:none;max-width:45%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.att-group .names{min-width:0;flex:1;order:3;color:var(--mut);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}details.att-group>summary .k{order:2}
.att-list{list-style:none;margin:0;padding:0}
.att-row{display:flex;align-items:center;gap:6px 14px;padding:8px 16px 8px 33px;min-height:44px;border-top:1px solid var(--line)}
.att-row:first-child{border-top:0}.att-row:hover{background:var(--hover)}
.att-row .name{flex:0 0 190px;min-width:0;font-weight:600;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.att-row .name:hover{text-decoration:underline}
.att-row .path{flex:1 1 0;min-width:0;color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.att-row .since{flex:none;margin-left:auto;color:var(--dim);font-size:12px;white-space:nowrap}
.att-row .acts{flex:0 0 168px;display:flex;justify-content:flex-end;gap:6px}.att-row .by{flex:none}
.attention.calm .att-head h2{color:var(--done)}
.attention.calm p{margin:0;padding:0 16px 12px;color:var(--mut);font-size:13px}.attention.calm p a{color:var(--accent);font-weight:600}
#v-lanes:checked~main .attention{display:none}
.divergence{margin:0 0 16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.divergence .att-head h2 b{background:var(--warn)}
.divergence.clean .att-head h2{color:var(--done)}.divergence.unevaluable .att-head h2{color:var(--block)}
.dv-counts{list-style:none;margin:0;padding:0 16px 10px;display:flex;flex-wrap:wrap;gap:6px}
.dv-counts li{font-size:12px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:1px 10px}
.dv-counts li b{color:var(--fg);font-variant-numeric:tabular-nums;margin-left:4px}.dv-counts li.hit{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.dv-rows{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.dv-row{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;padding:8px 16px;border-top:1px solid var(--line)}.dv-row:first-child{border-top:0}
.dv-row .v{font-size:11px;font-weight:650;letter-spacing:.04em;color:var(--warn)}.dv-row .id{font-family:var(--mono);font-size:12px;color:var(--mut);overflow-wrap:anywhere}
.dv-row .detail{grid-column:1/-1;font-size:13px;overflow-wrap:anywhere}
.dv-meta{margin:0;padding:8px 16px 12px;color:var(--dim);font-size:12px;overflow-wrap:anywhere;border-top:1px solid var(--line)}.dv-meta code{font-family:var(--mono);font-size:12px}
.divergence.unevaluable .att-head{padding:10px 16px}.divergence.unevaluable h2{font-size:13px}.divergence.unevaluable .why{color:var(--fg);overflow-wrap:anywhere}
.act{display:inline-flex;align-items:center;gap:6px;font:600 13px/1.4 var(--sans);color:var(--fg);background:var(--hover);border:1px solid transparent;border-radius:999px;padding:6px 12px;cursor:pointer;transition:background .18s var(--ease),box-shadow .18s var(--ease),filter .18s var(--ease),transform .1s var(--ease)}.act svg{width:14px;height:14px}
.act:hover{background:var(--line);box-shadow:0 0 0 1px var(--line-2) inset}.act:active,.find:active,.seg label:active{transform:scale(.97)}.act:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.board-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}
.seg{display:inline-flex;gap:2px;padding:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:999px}
.seg label{display:inline-flex;align-items:center;gap:6px;padding:4px 14px;border-radius:999px;transition:background .18s var(--ease),color .18s var(--ease),transform .1s var(--ease);font-weight:550;font-size:13px;color:var(--mut);cursor:pointer}
.seg label:hover{color:var(--fg)}.seg svg{width:14px;height:14px}
#bv-kanban:checked~.board-bar label[for=bv-kanban],#bv-graph:checked~.board-bar label[for=bv-graph]{color:var(--accent-text);background:var(--accent-bg)}
#bv-kanban:focus-visible~.board-bar label[for=bv-kanban],#bv-graph:focus-visible~.board-bar label[for=bv-graph]{outline:2px solid var(--accent);outline-offset:1px}
.bv{display:none}
#bv-kanban:checked~.bv-kanban,#bv-graph:checked~.bv-graph{display:block}
.legend{display:none;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--mut)}#bv-graph:checked~.board-bar .legend{display:flex}
.legend>span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.legend svg{width:12px;height:12px;color:var(--accent)}
.legend i{display:block;width:10px;height:10px;border-radius:999px;border:2px solid var(--line-2);background:var(--panel)}
.legend i.m-done{border-color:var(--done)}.legend i.m-in_progress{border-color:var(--prog)}.legend i.m-blocked{border-color:var(--block)}.legend i.m-cancelled{border-color:var(--gone);background:var(--gone-bg)}
.lg-next{color:var(--accent);font-size:11px}.lg-ring{display:block;width:10px;height:10px;border-radius:999px;border:1.5px dashed var(--warn)}.lg-found{display:block;width:16px;border-top:2px dotted var(--accent)}
.graph-wrap{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow-x:auto;scrollbar-width:thin;padding:0 16px}
.graph{position:relative;margin:0 auto}
.edges{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.edges path{fill:none;stroke:var(--line-2);stroke-width:1.5;vector-effect:non-scaling-stroke}
.edges path.done{stroke:var(--done)}.edges path.found{stroke:var(--accent);stroke-dasharray:2 4;stroke-linecap:round}.edges path.done.found{stroke:var(--done)}
.gn{position:absolute;z-index:1;width:148px;height:56px;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 10px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.gn:hover{border-color:var(--accent);background:var(--hover)}
.gn .gt{display:flex;align-items:flex-start;gap:6px;min-width:0}
.sd{flex:none;width:15px;height:15px;margin-top:0;border-radius:999px;display:grid;place-items:center;background:var(--panel);border:1.5px solid var(--line-2);color:var(--dim)}.sd svg{width:9px;height:9px}
.st-done .sd{background:var(--done);border-color:var(--done);color:var(--panel)}.st-cancelled .sd{background:var(--gone-bg);border-color:var(--gone);color:var(--gone)}
.st-blocked .sd{background:var(--block-bg);border-color:var(--block);color:var(--block)}.st-in_progress .sd{background:var(--prog-bg);border-color:var(--prog);color:var(--prog)}
.st-done .name{color:var(--mut)}.st-cancelled .name{color:var(--dim);text-decoration:line-through}
.here{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:6px;padding:1px 6px;white-space:nowrap}
.gn .name,.ghost .name{min-width:0;font-size:12px;line-height:1.22;font-weight:600;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.gn .gm{padding-left:21px;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.tool-group{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow)}
.tool{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;min-width:26px;padding:0 8px;border:0;border-radius:7px;background:none;color:var(--fg);font:550 13px var(--sans);white-space:nowrap;cursor:pointer}
.tool:hover{background:var(--hover)}.tool:disabled{color:var(--dim);cursor:default;background:none}.tool[aria-pressed=true]{color:var(--accent-text);background:var(--accent-bg)}
.tool.icon{padding:0 6px}.tool svg{width:15px;height:15px}.tool.zoom{min-width:50px;color:var(--mut);font-variant-numeric:tabular-nums}
.canvas-hint{position:absolute;left:12px;bottom:10px;z-index:3;font-size:12px;color:var(--dim);pointer-events:none}
.canvas-flash{position:absolute;left:50%;bottom:12px;z-index:3;transform:translateX(-50%);display:none;max-width:calc(100% - 24px);padding:8px 14px;border-radius:var(--r);font-size:13px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--done);box-shadow:var(--shadow)}
.canvas-flash.no{border-left-color:var(--block)}.full .canvas-flash{display:block}.full .canvas-hint{display:none}
.far .gn>*,.far .ghost>*,.far .fold{visibility:hidden}
.far .gn{background:var(--line);border-color:var(--line-2);box-shadow:none}.far .gn.st-done{background:color-mix(in srgb,var(--done) 50%,var(--panel));border-color:transparent}
.far .gn.st-in_progress{background:var(--prog);border-color:var(--prog)}.far .gn.st-blocked{background:var(--block);border-color:var(--block)}.far .gn.st-cancelled{background:var(--gone-bg)}
.far .gn.is-next{box-shadow:0 0 0 calc(5px * var(--inv,1)) var(--accent)}.far .ghost{background:var(--accent-bg);border-color:transparent}
.branch-label{position:absolute;z-index:4;display:none;transform:translate(-50%,-50%);max-width:var(--w);padding:calc(2px * var(--inv,1)) calc(8px * var(--inv,1));border:calc(1px * var(--inv,1)) solid var(--line-2);border-radius:calc(6px * var(--inv,1));background:var(--panel);box-shadow:var(--shadow);font:650 calc(13px * var(--inv,1))/1.3 var(--sans);color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.far .branch-label.fits{display:block}
.minimap{position:absolute;right:10px;bottom:10px;z-index:3;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);cursor:crosshair;touch-action:none}
.minimap svg{display:block}.minimap rect{fill:var(--line-2)}.minimap .mm-done{fill:color-mix(in srgb,var(--done) 55%,var(--panel))}.minimap .mm-in_progress{fill:var(--prog)}.minimap .mm-blocked{fill:var(--block)}.minimap .mm-cancelled{fill:var(--gone-bg)}.minimap .mm-idea{fill:var(--accent)}
.minimap .mm-view{fill:color-mix(in srgb,var(--accent) 10%,transparent);stroke:var(--accent);stroke-width:1.5;vector-effect:non-scaling-stroke}
.gn.pulse,.ghost.pulse{animation:changed 1.1s cubic-bezier(.2,.7,.2,1) 2;outline:2px solid var(--accent);outline-offset:3px}
.ghost{position:absolute;z-index:1;width:148px;height:56px;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 10px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--r-lg);color:var(--fg);box-shadow:var(--shadow)}
.ghost:hover{border-color:var(--accent);background:var(--hover)}.ghost[hidden]{display:none}
.ghost .gt{display:flex;align-items:flex-start;gap:6px;min-width:0}
.ghost .gm{padding-left:21px;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ghost .tag,.card .tag,.lg-idea{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:6px;padding:1px 6px;white-space:nowrap}
.ghost .tag{position:absolute;top:-10px;left:10px}.card .tag{display:inline-block;margin-bottom:6px}
.edges path.idea{stroke:var(--line-2);stroke-dasharray:5 4}
.chip.stage{color:var(--accent-text);border-color:var(--accent)}.chip.stage.loose{color:var(--warn);border-color:var(--warn);background:var(--warn-bg)}
.s-idea{color:var(--accent-text);background:var(--accent-bg)}.idea-file{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:14px 0 0;font-size:14px}.idea-file dt{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);padding-top:2px}.idea-file dd{margin:0;overflow-wrap:anywhere}
.task-links{display:grid;gap:6px;margin-top:12px}.task-links p{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0}.task-links .lk{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);min-width:78px}.task-links a{font-weight:600;color:var(--accent)}.task-links a:hover{text-decoration:underline}
.pill.merged{color:var(--done);background:var(--done-bg)}.pill.open{color:var(--prog);background:var(--prog-bg)}.pill.closed{color:var(--mut);background:var(--gone-bg)}
.chip.jira{font-family:var(--mono);font-size:11px}
form.inline{display:inline}.who-chip{font-size:13px;font-weight:600;color:var(--accent-text);background:var(--accent-bg);border-radius:999px;padding:4px 10px}
.int-head h1{font-size:28px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}.int-head p{display:flex;align-items:center;gap:8px;margin:0 0 24px;color:var(--mut);font-size:14px}.int-head p b{color:var(--fg);font-weight:600}
.settings-page{display:grid;grid-template-columns:232px minmax(0,1fr) 340px;min-height:100vh;max-width:none;margin:0;padding:0}
.set-nav{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;padding:14px 10px 12px;background:var(--side-bg);border-right:1px solid var(--line);overflow-y:auto}
.set-nav .brand{padding:2px 8px 12px}.set-k{margin:4px 10px 4px;font:600 11px var(--sans);letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}
.set-proj{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:6px 10px;font-weight:600;font-size:13px}
.set-link{padding:6px 10px;border-radius:var(--r);font-size:14px;color:var(--mut)}.set-link:hover{background:var(--hover);color:var(--fg)}
.set-nav .side-foot{margin:auto 0 0;padding-top:10px;border-top:1px solid var(--line)}
.set-main{min-width:0;padding:32px 48px 80px}.set-main>.flash{margin:0 0 24px}
.set-help{position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 16px;background:var(--side-bg);border-left:1px solid var(--line)}
.set-help[data-help]{padding:0;background:var(--panel);scrollbar-width:thin}
.help-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;margin:0;padding:18px 18px 20px;list-style:none;cursor:pointer;color:var(--btn-fg);background:linear-gradient(150deg,var(--btn),color-mix(in srgb,var(--btn) 72%,#0b1e40))}
.help-head::-webkit-details-marker{display:none}.help-head:hover .hc-fold{opacity:1}
.help-head b{display:block;font-size:15px;font-weight:650;letter-spacing:-.01em}.help-head small{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.88}.hc-t{flex:1;min-width:0}
.hc-on{flex:none;width:7px;height:7px;border-radius:999px;background:#4bce97;box-shadow:0 0 0 2px color-mix(in srgb,#4bce97 35%,transparent)}
.hc-fold{flex:none;width:8px;height:8px;margin-right:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.75;transform:rotate(-45deg)}.hc:not([open]) .hc-fold{transform:rotate(135deg)}
.settings-page:has(.hc:not([open])){grid-template-columns:232px minmax(0,1fr) 56px}.set-help:has(.hc:not([open])){padding:12px 8px;background:var(--side-bg)}
.hc:not([open]) .help-head{position:static;flex-direction:column;gap:12px;padding:12px 4px 16px;border-radius:14px}.hc:not([open]) .hc-t{writing-mode:vertical-rl;transform:rotate(180deg)}.hc:not([open]) .hc-t small{display:none}.hc:not([open]) .hc-fold{display:none}
.av.tira{width:28px;height:28px;color:var(--btn-fg);background:var(--brand);border:0;font-size:13px}.help-head .av.tira{width:34px;height:34px;font-size:15px;color:var(--btn);background:var(--btn-fg)}
.hc-body{display:flex;flex-direction:column;min-height:calc(100vh - 76px)}
.hc-log{display:flex;flex-direction:column;gap:14px;padding:18px 16px 12px}
.msg{display:flex;align-items:flex-end;gap:8px;scroll-margin:88px 0 120px;animation:msg-in .28s var(--ease) both}.msg .av.tira{width:26px;height:26px;font-size:12px}
.msg-b{display:grid;gap:4px;min-width:0;max-width:86%}.msg.from-you{justify-content:flex-end}.msg.from-you .msg-b{justify-items:end}
.bubble{margin:0;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
.from-tira .bubble{justify-self:start;color:var(--fg);background:var(--hover)}.from-tira .bubble:last-of-type{border-bottom-left-radius:6px}
.from-you .bubble{color:var(--btn-fg);background:var(--btn);border-bottom-right-radius:6px}
.bubble code{font:12px var(--mono);padding:1px 4px;border-radius:5px;background:color-mix(in srgb,var(--fg) 8%,transparent)}.msg-meta{padding:0 6px;font-size:11px;color:var(--dim)}
.typing{display:inline-flex;gap:4px;padding:14px 14px}.typing i{width:6px;height:6px;border-radius:999px;background:var(--dim);animation:typing 1.2s ease-in-out infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes typing{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}
@keyframes msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.hc-suggest{flex:1;display:flex;flex-direction:column;align-items:flex-end;gap:6px;padding:2px 16px 16px}.hc-suggest[hidden]{display:none}.hc-sk{margin:0 0 2px;font-size:12px;color:var(--dim)}
.hc-qa{max-width:92%;display:grid;justify-items:end;gap:8px}.hc-qa[hidden]{display:none}
.hc-chip{list-style:none;cursor:pointer;padding:8px 14px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--panel);color:var(--accent-text);font-size:13px;font-weight:600;text-align:right;transition:background .18s var(--ease),border-color .18s var(--ease),transform .1s var(--ease)}
.hc-chip::-webkit-details-marker{display:none}.hc-chip:hover{background:var(--accent-bg);border-color:var(--accent)}.hc-chip:active{transform:scale(.97)}
.hc-qa[open]>.hc-chip{color:var(--btn-fg);background:var(--btn);border-color:var(--btn)}.hc-qa>.bubble{justify-self:start;text-align:left;background:var(--hover);border-bottom-left-radius:6px}
.hc-bottom{position:sticky;bottom:0;z-index:2;padding:10px 12px 8px;background:var(--panel);border-top:1px solid var(--line)}.hc-bottom[hidden]{display:none}
.hc-compose{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 14px;border:1px solid var(--line-2);border-radius:999px;background:var(--panel);transition:border-color .18s var(--ease),box-shadow .18s var(--ease)}
.hc-compose:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}.hc-compose input{flex:1;min-width:0;height:32px;border:0;background:none;outline:0;font:14px var(--sans);color:var(--fg)}
.hc-send{flex:none;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:999px;color:var(--btn-fg);background:var(--btn);cursor:pointer;transition:opacity .18s var(--ease),transform .1s var(--ease)}.hc-send svg{width:16px;height:16px}
.hc-send:disabled{opacity:.35;cursor:default}.hc-send:not(:disabled):active{transform:scale(.92)}.hc-foot{margin:6px 0 0;text-align:center;font-size:11px;color:var(--dim)}
.profile{display:flex;align-items:center;gap:14px;padding:14px 16px}.av.av-lg{width:52px;height:52px;font-size:20px}.pf-who{display:grid;gap:2px;min-width:0}.pf-who b{font-size:17px}.pf-who span{color:var(--mut);font-size:13px}.pf-out{margin-left:auto}
.grp-desc{margin:8px 0 12px;color:var(--mut);font-size:13px}
.appear{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.look{display:grid;gap:2px;padding:10px 10px 12px;background:var(--panel);border:1.5px solid var(--line);border-radius:var(--r-lg);cursor:pointer;transition:border-color .18s var(--ease),box-shadow .18s var(--ease),transform .1s var(--ease)}.look:hover{border-color:var(--line-2)}.look:active{transform:scale(.98)}
.look b{font-size:14px}.look small{font-size:12px;color:var(--mut)}
.look-pic{display:block;height:72px;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid #dcdfe4;background:#f7f8f9}.look-dark .look-pic{border-color:#3b3d42;background:#1f1f21}.look-system .look-pic{background:linear-gradient(135deg,#f7f8f9 50%,#1f1f21 50%)}
.look-pic i{display:block;height:7px;width:44%;margin:0 0 8px;border-radius:4px;background:#1868db}.look-pic i+i{width:72%;background:#b7bcc4}.look-pic i+i+i{width:58%}.look-dark .look-pic i{background:#669df1}.look-dark .look-pic i+i{background:#56585e}
#th-system:checked~main .look-system,#th-light:checked~main .look-light,#th-dark:checked~main .look-dark{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
#th-system:focus-visible~main .look-system,#th-light:focus-visible~main .look-light,#th-dark:focus-visible~main .look-dark{outline:2px solid var(--accent);outline-offset:2px}
.grp.danger .grp-h{color:var(--block)}.grp.danger .grp-list{border-color:color-mix(in srgb,var(--block) 45%,var(--line))}.grp.danger .grp-k b{font-family:var(--mono);font-size:13px}
.act.danger{color:var(--btn-fg);background:var(--block)}.act.danger:hover{filter:brightness(1.08);background:var(--block)}
.np-steps{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:2px}.np-steps li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--r);font-size:14px;color:var(--mut)}
.np-steps li.on{color:var(--fg);font-weight:600;background:var(--hover)}.np-n{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:999px;font:650 11px/1 var(--sans);color:var(--mut);background:var(--panel);border:1px solid var(--line-2)}
.np-steps li.on .np-n{color:var(--btn-fg);background:var(--btn);border-color:var(--btn)}
.np-page .set-main>*{max-width:780px}.np-page .flash{margin:0 0 16px}
.np-form .grp-row{padding:12px 16px}.np-form .grp-k{flex:0 0 230px;display:grid;gap:2px;font-weight:600}.np-form .grp-k small{font-weight:400;font-size:12px;line-height:1.4;color:var(--mut)}
.np-form input{height:36px;transition:box-shadow .18s var(--ease)}.np-form input:focus{outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}.np-form input[aria-invalid=true]{box-shadow:0 0 0 2px var(--block)}
.np-acts{justify-content:flex-end;gap:8px}.np-jira{display:contents}.np-jira>.grp-row,.np-jira+.grp-row{border-top:1px solid var(--line)}.np-field>.how{margin-left:0}.np-form select{flex:1 1 240px;height:36px}
.np-side{padding:24px 20px}.np-k{margin:0 0 10px;font:600 11px var(--sans);letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}
.np-card{margin:0 0 28px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.np-who{display:flex;align-items:center;gap:12px;margin:0}.np-who .pav{width:40px;height:40px;border-radius:11px;font-size:20px;transition:background .25s var(--ease)}
.np-who>span{display:grid;min-width:0}.np-who b{font-size:15px;overflow-wrap:anywhere}.np-who small{color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.np-next{margin:0;padding-left:20px;display:grid;gap:8px;font-size:13px;color:var(--mut)}.np-next code{font:12px var(--mono);color:var(--fg)}
@media (max-width:760px){.np-form .grp-k{flex-basis:100%}.np-steps{display:none}}
@media (max-width:1180px){.settings-page{grid-template-columns:220px minmax(0,1fr)}.set-help{grid-column:2;position:static;height:auto;border-left:0;border-top:1px solid var(--line);padding:24px 48px}.settings-page:has(.hc:not([open])){grid-template-columns:220px minmax(0,1fr)}.hc:not([open]) .help-head{flex-direction:row}.hc:not([open]) .hc-t{writing-mode:horizontal-tb;transform:none}.set-help[data-help]{padding:0}.help-head{position:static}.hc-body{min-height:0}.hc-log{min-height:160px}}
@media (max-width:760px){.settings-page{display:block}.set-nav{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;border-right:0;border-bottom:1px solid var(--line)}.set-nav .side-foot{margin:0 0 0 auto;border:0;padding:0}.set-k,.set-proj{display:none}.set-main{padding:20px 16px 48px}.set-help{padding:20px 16px}}
.grp{display:block;margin:0 0 36px;scroll-margin-top:24px}.grp-h{display:block;margin:0;padding:0 0 8px;font-size:17px;font-weight:600;letter-spacing:-.01em;text-transform:none;color:var(--fg);border-bottom:1px solid var(--line)}
details.grp>summary{cursor:pointer;list-style:none}details.grp>summary::-webkit-details-marker{display:none}details.grp>summary::after{content:" ›"}details.grp[open]>summary::after{content:" ⌄"}
.grp-list{display:block;margin:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.grp-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-height:44px;margin:0;padding:8px 16px;font-size:14px}
.grp-row+.grp-row,.profile+.grp-row{border-top:1px solid var(--line)}
.grp-k{flex:1;min-width:90px;color:var(--fg)}.grp-k.no{color:var(--block)}.grp-sub,.grp-v{color:var(--mut);font-weight:400}
.grp-row select,.grp-row input{flex:1 1 200px;font:14px var(--sans);color:var(--fg);background:var(--panel-2);border:0;border-radius:8px;padding:8px 10px;min-width:0}.grp-row input:focus,.grp-row select:focus{outline:2px solid var(--accent);outline-offset:0}
.grp-foot{margin:6px 16px 0;font-size:12px;color:var(--mut)}.grp-foot details{margin:0 0 6px}.grp-foot summary{cursor:pointer;color:var(--accent-text)}
.int-cmd{margin:0;font-size:12px;color:var(--mut)}.int-cmd summary{cursor:pointer;color:var(--accent-text)}.int-cmd code{display:block;margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--fg);background:var(--panel);border-radius:8px;padding:8px 10px;overflow-wrap:anywhere}
.int-steps{margin:6px 0;padding-left:18px}.int-steps li{margin:4px 0}.int-steps code{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.signin-code{font:650 22px var(--mono);letter-spacing:.08em;color:var(--fg);background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r);padding:4px 12px}
.hide-found .edges path.found{stroke:var(--line-2);stroke-dasharray:none}.hide-found .edges path.done.found{stroke:var(--done)}
.edges path.blocks{stroke:var(--block);stroke-dasharray:7 4;stroke-width:2}.edges path.blocks.done{stroke:var(--done)}.lg-blocks{display:block;width:16px;border-top:2px dashed var(--block)}
.links{display:grid;gap:6px;margin-top:12px}.links p{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0}.links .lk{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--block);min-width:78px}.links a{font-weight:600;color:var(--accent)}.links a:hover{text-decoration:underline}
.att-row .by{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--mut)}.att-row .by a{font-weight:600;color:var(--accent)}.att-row .ready{display:inline;font-size:11px}
.chip.blocks{color:var(--block);border-color:var(--block);background:var(--block-bg)}
.blocked-by{display:grid;gap:6px;margin:0 0 10px;font-weight:600;font-size:13px}.blocked-by input{font:500 14px var(--sans);color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r);padding:8px 10px}.blocked-by input:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.your-action .blocked-by+.fills{margin:-2px 0 10px}
.wait-ring{width:12px;height:12px;border-radius:999px;border:1.5px dashed var(--warn);flex:none}
.meter{flex:1;min-width:40px;height:6px;border-radius:3px;background:var(--gone-bg);overflow:hidden;display:flex}.meter i{display:block;height:100%}
.m-done{background:var(--done)}.m-cancelled{background:var(--gone)}.m-in_progress{background:var(--prog)}.m-blocked{background:var(--block)}
.ct{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(172px,1fr);gap:12px;align-items:start;overflow-x:auto;scrollbar-width:thin;padding-bottom:6px}
.col{min-width:0;background:var(--sunken);border:1px solid var(--line);border-radius:14px;padding:8px}
.ch{display:flex;align-items:center;gap:8px;padding:4px 6px 10px;font-weight:650;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
.dot{width:8px;height:8px;border-radius:2px}
.ch .k{margin-left:auto;color:var(--mut);font-weight:600;letter-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:11px}
.card{display:block;background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px;box-shadow:var(--shadow)}
.more-tog{position:absolute;opacity:0;pointer-events:none}.more-cards{display:none}.more-tog:checked~.more-cards{display:block}
.more-btn{display:block;cursor:pointer;margin:2px 0 8px;padding:8px 10px;border:1px dashed var(--line-2);border-radius:var(--r);font-size:13px;font-weight:600;color:var(--accent-text);text-align:center;transition:background .15s var(--ease)}.more-btn:hover{background:var(--hover)}
.more-btn .m-hide,.more-tog:checked~.more-btn .m-show{display:none}.more-tog:checked~.more-btn .m-hide{display:inline}.more-tog:focus-visible~.more-btn{outline:2px solid var(--accent);outline-offset:2px}
.card{transition:transform .2s var(--ease),box-shadow .2s var(--ease),border-color .2s var(--ease)}.card:hover{border-color:var(--line-2);box-shadow:var(--shadow-raised);transform:translateY(-1px)}
.card .t{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.card .row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;color:var(--mut);font-size:12px}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:12px;color:var(--mut);overflow-wrap:anywhere}
.hist{margin-left:auto;display:inline-flex;align-items:center;gap:4px}.hist svg,.chip svg{width:12px;height:12px}
.pin{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:6px;padding:1px 6px;margin-bottom:6px}
.card.is-next{border-left:3px solid var(--accent)}
.card.is-gone .t{text-decoration:line-through;color:var(--dim)}
.changed{animation:changed 1.1s cubic-bezier(.2,.7,.2,1) 2}.att-row.changed{animation-name:changed-row}
@keyframes changed{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
@keyframes changed-row{0%{background:var(--accent-bg)}100%{background:transparent}}
@media (prefers-reduced-motion:reduce){.changed{outline:2px solid var(--accent);outline-offset:2px}}
.empty{color:var(--dim);font-size:13px;padding:6px 4px;margin:0}.board-empty{padding:24px;text-align:center;border:1px dashed var(--line-2);border-radius:var(--r-lg)}.board-empty code{font:12px var(--mono)}
.lanes{display:grid;grid-template-columns:minmax(90px,.8fr) repeat(var(--n),minmax(120px,1fr));gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:12px 16px;overflow-x:auto;box-shadow:var(--shadow)}
.lanes-label{margin:20px 0 8px;font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}.lanes-label:first-child{margin-top:4px}
.lanes .lh{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);padding:0 4px 4px}
.lanes .who{font-weight:600;overflow-wrap:anywhere;padding:4px}.lanes .who.old{color:var(--dim);text-decoration:line-through}
.lane{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--r);background:var(--panel-2);border:1px solid var(--line);min-height:36px}
.pill{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--gone-bg);color:var(--mut);white-space:nowrap}
.pill.go{color:var(--done);background:var(--done-bg)}.pill.work{color:var(--prog);background:var(--prog-bg)}.pill.stop{color:var(--block);background:var(--block-bg)}.pill.wait{color:var(--warn);background:var(--warn-bg)}
.cap{font-size:12px;color:var(--mut);display:inline-flex;align-items:center;gap:4px}
.cap .av{width:18px;height:18px;font-size:11px}
.chips2{display:flex;flex-wrap:wrap;gap:6px}
.pairs{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow)}
.pairs li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;color:var(--mut);padding:8px 14px;border-top:1px solid var(--line)}
.pairs li:first-child{border-top:0}.pairs li.waiting{background:var(--warn-bg)}
.pairs .arrow{color:var(--accent);font-weight:700}.pairs code{font-family:var(--mono);font-size:12px;color:var(--fg)}
.ready{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--done);display:block}
.needs{font-size:11px;color:var(--warn);display:block;overflow-wrap:anywhere}
.drawer{position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:24px 16px;visibility:hidden;opacity:0;transition:opacity .22s var(--ease),visibility 0s .22s}
.drawer:target{visibility:visible;opacity:1;transition:opacity .22s var(--ease)}
body:has(.drawer:target){overflow:hidden}
.scrim{position:absolute;inset:0;background:rgba(9,30,66,.4);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);cursor:default}
.modal-box{position:relative;width:min(640px,100%);max-height:min(82vh,760px);overflow-y:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-raised);padding:20px 24px 24px;transform:translateY(12px) scale(.98);transition:transform .28s var(--ease)}
.drawer:target .modal-box{transform:none}
.drawer .close{position:absolute;right:14px;top:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:999px;border:1px solid transparent;color:var(--mut);font-size:20px}
.drawer .close:hover{background:var(--hover);border-color:var(--line);color:var(--fg)}
.drawer h2{margin:4px 0 2px;font-size:20px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere;padding-right:32px}
.path{color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}
.locate{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font:550 13px var(--sans);color:var(--accent-text);background:none;border:1px solid transparent;border-radius:var(--r);padding:2px 8px;cursor:pointer}.locate:hover{background:var(--accent-bg)}.locate svg{width:14px;height:14px}
.state{display:inline-block;font:700 11px/16px var(--sans);letter-spacing:.02em;text-transform:uppercase;padding:0 6px;border-radius:5px;white-space:nowrap}
.s-unstarted,.s-cancelled{color:var(--loz-todo-fg);background:var(--loz-todo)}.s-in_progress{color:var(--loz-prog-fg);background:var(--loz-prog)}.s-blocked{color:var(--loz-block-fg);background:var(--loz-block)}
.s-done{color:var(--loz-done-fg);background:var(--loz-done)}
.mark{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--gone-bg);color:var(--mut)}
.mark.cursor,.mark.tira{color:var(--accent-text);background:var(--accent-bg)}.mark.active{color:var(--prog);background:var(--prog-bg)}.mark.wait{color:var(--warn);background:var(--warn-bg)}
.kids-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px}
.kids-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel-2)}
.kids-list a{font-weight:600;color:var(--accent);overflow-wrap:anywhere}.kids-list a:hover{text-decoration:underline}
.proof{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-top:14px;padding:10px 12px;border:1px solid var(--line);border-left:4px solid var(--done);border-radius:var(--r);background:var(--done-bg)}
.proof-k{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--done)}.proof-v{font-family:var(--mono);font-size:13px;color:var(--fg);overflow-wrap:anywhere}
.drawer-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.kids{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--mut);font-size:13px}
details.trail{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}
details.trail summary{cursor:pointer;color:var(--mut);font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;min-height:24px}
.feed{list-style:none;margin:8px 0 0;padding:0;position:relative}
.feed::before{content:"";position:absolute;left:11px;top:6px;bottom:6px;width:1px;background:var(--line)}
.ev{position:relative;display:flex;gap:10px;padding:6px 0}
.av{position:relative;z-index:1;flex:none;width:23px;height:23px;border-radius:999px;display:grid;place-items:center;font-size:11px;font-weight:650;color:var(--mut);background:var(--panel-2);border:1px solid var(--line-2)}
.ev.tira .av{color:var(--accent-text);background:var(--accent-bg);border-color:transparent}.av svg{width:12px;height:12px}
.ev.refused .av{color:var(--block);background:var(--block-bg);border-color:transparent}
.ev-body{min-width:0;padding-top:2px}
.ev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.ev-what{font-family:var(--mono);font-size:12px}.ev.refused .ev-what{color:var(--block)}
.ev-who{font-weight:600;font-size:13px}.ev-task{font-weight:600;font-size:13px;color:var(--fg)}
.ev-seq{font-family:var(--mono);font-size:11px;color:var(--dim)}
.auto,.legacy{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);border:1px solid currentColor;border-radius:999px;padding:0 6px}.legacy{color:var(--warn)}
.ev-detail{color:var(--mut);font-size:13px;overflow-wrap:anywhere;margin-top:1px}
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
.hint{margin:10px 0 0;font-size:14px;color:var(--fg)}.hint b{font-weight:650}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:stretch;margin:0 0 14px}
.brief p{margin:0 0 8px;font-size:14px;line-height:1.55;overflow-wrap:anywhere}.brief p b{font-weight:650}
.brief .nutshell{font-size:15px;line-height:1.5;margin-bottom:10px}.brief .nutshell b{display:block;font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);margin-bottom:2px}
.brief .verdict{margin:0 0 10px}.brief .hint{margin:0 0 10px}
.brief details.why{margin-top:6px;border-top:1px solid var(--line);padding-top:8px}.brief details.why>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--accent-text);min-height:24px}.brief details.why[open]>summary{margin-bottom:8px}
.your-action textarea{display:block;width:100%;min-height:150px;resize:vertical;font:13px/1.6 var(--mono);color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r);padding:10px 12px}.your-action textarea:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.cmd-help{margin:8px 0 0;font-size:12px;color:var(--mut)}
.fills{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}.fills span{font-size:12px;color:var(--mut)}
.fill{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px var(--sans);color:var(--fg);background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:4px 10px;cursor:pointer}.fill:hover{border-color:var(--accent);color:var(--accent)}
.run{display:flex;align-items:center;flex-wrap:wrap;gap:12px 16px;margin:0 0 14px}.run .how{margin-left:0}
.act.primary{padding:8px 18px;font-weight:600;color:var(--btn-fg);background:var(--btn)}.act.primary:hover{filter:brightness(1.08);background:var(--btn)}
button.how{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--accent);cursor:pointer}
.confirm-dialog{width:min(1000px,calc(100vw - 32px));max-height:min(90vh,860px);padding:0;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow-raised)}
.confirm-dialog::backdrop{background:rgba(9,30,66,.54)}
.confirm-dialog .packet{padding:20px 24px 6px}.confirm-dialog .packet h1{margin-top:0}
.guide p{margin:0 0 12px;color:var(--fg);font-size:14px;line-height:1.6}.guide code{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.palette{position:fixed;inset:0;background:rgba(5,12,31,.36);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;z-index:50}
.palette[hidden]{display:none}
.pal-box{width:min(600px,100%);background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-raised);overflow:hidden}
.pal-box input{width:100%;font:500 15px var(--sans);color:var(--fg);background:transparent;border:0;border-bottom:1px solid var(--line);padding:14px 16px;outline:none}
.pal-list{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.pal-list li{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:var(--r);cursor:pointer}
.pal-list li[aria-selected=true]{background:var(--accent-bg)}
.pal-list .pid{font-weight:600}.pal-list .ppath{color:var(--dim);font-size:12px;overflow-wrap:anywhere}.pal-list .pverb{margin-left:auto;font-size:12px;font-weight:600;color:var(--accent)}
.pal-hint{padding:8px 14px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);background:var(--panel-2)}
@media screen and (min-width:900px){
:root{--side:236px}
main[data-stream]{max-width:none;margin:0;padding:0 40px 72px calc(var(--side) + 40px)}
main[data-stream]>.top{position:fixed;z-index:6;left:0;top:0;bottom:0;width:var(--side);flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:2px;min-height:0;padding:14px 10px 12px;background:var(--side-bg);border-right:1px solid var(--line);border-image:none;overflow-y:auto}
main[data-stream]>.top .brand{padding:2px 8px 12px}
main[data-stream]>.top .proj-search{margin:0 0 10px;min-width:0}main[data-stream]>.top .side-link{margin:-10px 0 14px}
main[data-stream]>.top .tabs{flex-direction:column;align-self:stretch;margin:0 0 14px;gap:1px}
main[data-stream]>.top .tabs label{padding:6px 10px;border:0;border-radius:var(--r);font-size:14px;color:var(--mut)}
main[data-stream]>.top .tabs label:hover{background:var(--hover)}
#v-board:checked~main[data-stream] .tabs label[for=v-board],#v-lanes:checked~main[data-stream] .tabs label[for=v-lanes]{color:var(--fg);background:var(--hover)}
main[data-stream]>.top .projects>summary{height:auto;max-width:none;padding:6px 10px;border:0;background:none;font-size:12px;font-weight:600;color:var(--dim)}main[data-stream]>.top .projects>summary{font:600 11px var(--sans);letter-spacing:.03em;text-transform:uppercase}
main[data-stream]>.top .projects>summary svg{width:11px;height:11px}.projects:not([open])>summary svg{transform:rotate(-90deg)}
main[data-stream]>.top .projects .ws-menu{position:static;width:auto;max-height:none;padding:0;border:0;box-shadow:none;background:none}
main[data-stream]>.top .projects .ws-item{padding:6px 10px;gap:10px}.projects .ws-item small{font-size:12px}
main[data-stream]>.top .projects .ws-head{display:none}
main[data-stream]>.top .side-foot{margin:auto 0 0;padding-top:10px;border-top:1px solid var(--line);flex-direction:column;align-items:stretch;gap:6px}
main[data-stream]>.top .side-foot .theme{align-self:flex-start}
main[data-stream]>.top .me>summary{max-width:none;width:100%;border:0;background:none;padding:0 8px}
main[data-stream]>.top .me-menu{top:auto;bottom:calc(100% + 6px)}
main[data-stream]>.side-toggle{display:grid;left:calc(var(--side) - 42px)}
:root:has(#side-shut:checked){--side:28px}
#side-shut:checked~main[data-stream]>.top{display:none}
#side-shut:checked~main[data-stream]>.side-toggle{left:14px}
}
.side-toggle{display:none;position:fixed;z-index:7;top:13px;place-items:center;width:30px;height:30px;border-radius:var(--r);color:var(--mut);cursor:pointer;transition:background .15s var(--ease),color .15s var(--ease)}
.side-toggle:hover{background:var(--hover);color:var(--fg)}.side-toggle svg{width:16px;height:16px}#side-shut:focus-visible~main .side-toggle{outline:2px solid var(--accent);outline-offset:-2px}
@media (max-width:720px){.split{grid-template-columns:1fr}}
@media (max-width:640px){
main{padding:0 16px 48px}.hero .title{grid-template-columns:minmax(0,1fr)}.proj-links{grid-column:1;grid-row:auto;justify-self:start;justify-content:flex-start}
.tabs{margin:0;overflow-x:auto}.tabs label{padding:6px 10px}.proj-search{min-width:0;flex:1 1 140px}.find{margin-right:0;max-width:none}.brand{padding-right:0}
.graph-wrap{padding:0 12px}.canvas-hint{display:none}
.cols{grid-auto-columns:minmax(78vw,1fr);scroll-snap-type:x mandatory}.col{scroll-snap-align:start}
.att-row{flex-wrap:wrap;padding-left:16px}.att-row .name{flex-basis:auto}.att-row .acts{flex-basis:auto;margin-left:auto}
.ws-menu{position:fixed;left:16px;right:16px;top:52px;width:auto}
.canvas-tools{left:8px;right:8px;max-width:none;flex-wrap:nowrap;justify-content:flex-start;overflow-x:auto;scrollbar-width:none}.tool-group{flex:none}
}
@media (max-width:560px){.hero h1{flex-basis:100%;font-size:28px}.big{flex-basis:100%}.stats li{margin:0 14px 0 0;padding:0 14px 0 0;border-left:0;border-right:1px solid var(--line)}.stats li:last-child{border-right:0}.lanes{grid-template-columns:1fr;overflow:visible}.lanes .lh{display:none}.lanes .who{padding-top:10px}.lane::before{content:attr(data-region);font-size:11px;color:var(--dim);min-width:52px}}
@media (pointer:coarse){.act,.tool,.seg label,.theme label,.ws-item,.side-link,.set-link,.tabs label,.new-project,.help,.find,.proj-search,.hc-chip,.history-btn,.more-btn,details.att-group>summary,.fill,.locate,.look,.np-steps li{min-height:44px}.set-link,.fill{display:flex;align-items:center}.tool,.theme label,.drawer .close{min-width:44px;min-height:44px}.hc-send{width:44px;height:44px}.hc-compose input{height:40px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
@media print{body{background:#fff}.hero::before{display:none}.top{border-image:none;border-bottom:1px solid var(--line)}.tabs,.proj-search,.side-link,.find,.top .how,.theme{display:none}.view{display:block!important}.drawer{display:none}.board-bar{display:none}.bv{display:block!important}.graph-wrap{overflow:visible}.cols{grid-auto-flow:row;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));overflow:visible}}
`;

const ICON = {
  brand: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="currentColor"/><path d="M10.5 5.5v10a3 3 0 0 0 3 3h2M7 10h8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // tira's mark: a parent tira closed by itself
  auto: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.8L3.6 9h4.1l-.9 5.2L12.4 7H8.3z"/></svg>`,
  history: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.5 2.5v2.4h2.4"/><path d="M8 5.2V8l2 1.3"/></svg>`,
  ban: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>`,
  alert: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>`,
  system: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.8" width="12" height="8.7" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>`,
  sun: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>`,
  moon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z"/></svg>`,
  help: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.6M8 11.4v.1"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`,
  github: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  jira: `<svg class="ico-jira" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z"/></svg>`,
  search: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>`,
  sliders: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>`,
  menu: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>`,
  chev: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>`,
  spark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M8 10v4M2 8h4M10 8h4"/></svg>`,
  kanban: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="2" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1"/></svg>`,
  graph: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.8" y="1.8" width="4.4" height="3.4" rx="1"/><rect x="1.5" y="10.8" width="4.4" height="3.4" rx="1"/><rect x="10.1" y="10.8" width="4.4" height="3.4" rx="1"/><path d="M8 5.2v2.6M3.7 10.8V7.8h8.6v3"/></svg>`,
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

function graphHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links, ghosts: Ghost[], changed: ReadonlySet<string>): string {
  const kids = new Map<Placed, Placed[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  // ideas after the tree, each under its proposed parent (layout.mjs: a parent before its children)
  const L = layout([...nodes.map((n) => ({ key: n.row.key, parent: n.parent?.row.key })), ...ghosts.map((g) => ({ key: g.idea.key, parent: g.parent }))]);
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
  const node = (n: Placed) => graphNodeHtml(n, kids.get(n) ?? [], at(n), byKey, links, (trail.get(n.row.key) ?? []).length, changed.has(n.row.key));
  const ghostAt = (key: string) => L.at.get(key) ?? { x: 0, y: 0 };
  const ideaLines = ghosts.filter((g) => g.parent !== undefined).map((g) =>
    `<path class="e idea" data-from="${esc(g.parent as string)}" data-to="${esc(g.idea.key)}" d="${treePath(ghostAt(g.parent as string), ghostAt(g.idea.key))}"/>`);
  // Live, graph.mjs turns the box into a canvas (pan, zoom, folds); a rendered file scrolls.
  return `<div class="graph-wrap" data-graph><div class="graph" role="group" aria-label="Tasks as a tree" style="width:${fx(L.width)}px;height:${L.height}px">`
    + `<svg class="edges" viewBox="0 0 ${fx(L.width)} ${L.height}" aria-hidden="true">${tree.join("")}${found.join("")}${blockArcs.join("")}${ideaLines.join("")}</svg>`
    + `${nodes.map(node).join("")}${ghosts.map((g) => ghostHtml(g, ghostAt(g.idea.key), (trail.get(g.idea.key) ?? []).length, changed.has(g.idea.key))).join("")}</div></div>`;
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

// Where a box sits on the graph (layout.mjs), in whole pixels.
const placedAt = (p: { x: number; y: number }) => `style="left:${fx(p.x)}px;top:${p.y}px"`;

// One task on the graph: a link to its dialog, carrying the fold's flags (M1).
function graphNodeHtml(n: Placed, ks: Placed[], p: { x: number; y: number }, byKey: ReadonlyMap<string, Placed>, links: Links, history: number, changed: boolean): string {
  const r = n.row;
  const closed = ks.filter((c) => CLOSED.has(c.row.state)).length;
  const left = ks.length - closed;
  const cls = [
    "gn", `st-${r.state}`, ks.length > 0 ? "parent" : "",
    r.cursor ? "is-next" : "", r.active ? "is-active" : "", changed ? "changed" : "",
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
  return `<a class="${cls}" href="#t${n.i}" ${placedAt(p)} aria-label="${esc(nodeLabel(n, ks, closed, byKey, links))}"${parentAttr} ${nodeAttrs(r, history)}>`
    + pin
    + `<span class="gt"><span class="sd">${STOP_GLYPH[r.state] ?? ""}</span><span class="name" title="${esc(r.id)}">${esc(spaced(r.id))}</span></span>`
    + `<span class="gm">${marks}${meta}</span></a>`;
}

// ---------- ideas (D5, the vapor catch) ----------
// An open idea is on the board too, never as a task: a card tagged IDEA in the Ideas column, and on
// the Graph a box tagged IDEA under the task tira proposed for it. One tira hasn't placed yet (its file
// isn't approved), or one waiting for a person to pick its parent, sits on the top row. Each opens
// its own dialog (#i<n>). Ghosts carry data-idea, never data-key: the M1 count is the tree's alone.
interface Ghost { idea: IdeaRow; i: number; parent?: string } // parent: the proposed parent's key, on the tree

function ghostsOf(ideas: IdeaRow[], onTree: ReadonlySet<string>): Ghost[] {
  return ideas.map((idea, i) => {
    const p = idea.proposal?.parent === undefined ? undefined : `${TASK}:${idea.proposal.parent}`;
    return { idea, i, ...(p !== undefined && onTree.has(p) ? { parent: p } : {}) };
  });
}

// waiting for a person to pick its parent
const loose = (i: IdeaRow) => i.stage === "node_pending" && i.proposal?.parent === undefined;

function ghostHtml(g: Ghost, p: { x: number; y: number }, history: number, changed: boolean): string {
  const i = g.idea;
  let where = "not placed yet";
  if (g.parent !== undefined) where = `proposed under ${bare(g.parent)}`;
  else if (loose(i)) where = "needs a parent";
  const said = i.summary ? `: ${i.summary}` : "";
  const label = `idea ${i.id}${said}, ${stageWord(i)}, ${where}`;
  const parentAttr = g.parent === undefined ? "" : ` data-parent="${esc(g.parent)}"`;
  return `<a class="ghost${loose(i) ? " loose" : ""}${changed ? " changed" : ""}" href="#i${g.i}" ${placedAt(p)} aria-label="${esc(label)}"${parentAttr} data-idea="${esc(i.key)}" data-stage="${esc(i.stage)}" data-history="${history}">`
    + `<span class="tag">idea</span><span class="gt"><span class="sd">${ICON.spark}</span><span class="name" title="${esc(i.summary ?? i.id)}">${esc(spaced(i.id))}</span></span>`
    + `<span class="gm">${esc(stageWord(i))}</span></a>`;
}

// The Ideas column: first on the board, while any idea is open.
function ideasColumn(ghosts: Ghost[], trail: Map<string, TrailEntry[]>, changed: ReadonlySet<string>): string {
  if (ghosts.length === 0) return "";
  const cards = ghosts.map((g) => {
    const i = g.idea;
    const under = i.proposal?.parent === undefined ? "" : `<span class="chip">under ${esc(i.proposal.parent)}</span>`;
    return `<a class="card idea${changed.has(i.key) ? " changed" : ""}" href="#i${g.i}" data-idea-card="${esc(i.key)}" data-stage="${esc(i.stage)}"><span class="tag">idea</span><div class="t">${esc(i.summary ?? i.id)}</div>`
      + `<div class="row"><span class="chip stage${loose(i) ? " loose" : ""}">${esc(stageWord(i))}</span>${under}<span class="hist" title="history">${ICON.history}${(trail.get(i.key) ?? []).length}</span></div></a>`;
  }).join("");
  return `<div class="col"><div class="ch"><span class="dot" style="background:var(--accent)"></span>Ideas<span class="k">${ghosts.length}</span></div>${cards}</div>`;
}

// What an idea's dialog offers under `tira serve`, by stage: a person's two approvals. Between
// them tira works (it drafts the file, then proposes the parent), so those stages offer nothing.
const IDEA_ACTIONS: Record<string, [string, string][]> = {
  file_pending: [["APPROVE_FILE", "Approve file"], ["REJECT_FILE", "Reject file"]],
  node_pending: [["APPROVE_NODE", "Approve placement"], ["REJECT_NODE", "Reject placement"]],
};

// what happens next, in a sentence
function ideaNext(i: IdeaRow): string {
  if (i.stage === "declared") return i.summary ? "tira drafts its file from what it says." : "Its file is drafted by hand: tira send idea " + i.id + " DRAFT_FILE summary=\"…\" why=\"…\".";
  if (i.stage === "file_pending") return "Approve the file if it's worth doing; then tira proposes where it goes, and you approve that.";
  if (i.stage === "filed") return i.summary ? "tira proposes where it goes." : "Its placement is proposed by hand: tira send idea " + i.id + " PROPOSE_NODE.";
  if (loose(i)) return "Pick its parent when you approve the placement; then it becomes a task.";
  return `Approve the placement (you can change the parent), and it becomes the task ${i.id}.`;
}

function ideaDrawerHtml(g: Ghost, lines: TrailEntry[], live: boolean, q: string): string {
  const i = g.idea;
  const verbs = live ? IDEA_ACTIONS[i.stage] ?? [] : [];
  const acts = verbs.length > 0 ? `<div class="drawer-acts" data-dialog-acts>${verbs.map(([ev, label]) => actLink({ type: IDEA, id: i.id }, ev, label, q)).join("")}</div>` : "";
  const p = i.proposal;
  let goes = "not proposed yet: tira proposes it once the file is approved" + (i.under === undefined ? "" : ` (declared under ${i.under})`);
  if (p?.parent !== undefined) goes = `${p.parent}: ${p.basis} (tira's proposal, seq ${p.seq})`;
  else if (p !== undefined) goes = p.basis + (p.candidates.length > 0 ? ` (candidates: ${p.candidates.join(", ")})` : "");
  const file: [string, string][] = [["Why", i.why ?? "not given"], ["Goes under", goes], ["Next", ideaNext(i)]];
  const by = i.declaredBy === undefined ? "" : ` by ${i.declaredBy}`;
  const fileHtml = file.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  return `<section class="drawer" id="i${g.i}" aria-label="idea ${esc(i.id)}" role="dialog" aria-modal="true" data-idea-dialog="${esc(i.key)}">${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a>`
    + `<div class="path">idea ${esc(i.id)} · declared${esc(by)} at seq ${i.declaredSeq}</div><h2>${esc(i.summary ?? i.id)}</h2><div class="badges"><span class="state s-idea">${esc(stageWord(i))}</span><span class="mark">not a task yet</span>${locate(i.key, live)}</div>`
    + `<dl class="idea-file">${fileHtml}</dl>${acts}`
    + `<details class="trail" open><summary>history (${lines.length})</summary><ol class="feed">${lines.map((l) => entryHtml(l)).join("")}</ol></details></div></section>`;
}

// What the graph's colours and marks mean, beside the switch while the graph shows.
const LEGEND = `<span class="legend" aria-hidden="true"><span><i class="m-done"></i>done</span><span><i class="m-in_progress"></i>in progress</span><span><i class="m-blocked"></i>blocked</span><span><i></i>to do</span><span><i class="m-cancelled"></i>dropped</span>`
  + `<span><b class="lg-next">◆</b>next</span><span>${ICON.auto}closed by tira</span><span><b class="lg-ring"></b>tira closes it when you move on</span><span><b class="lg-found"></b>found while working on</span><span><b class="lg-blocks"></b>blocks</span><span><b class="lg-idea">idea</b>not a task yet</span></span>`;

// The board: one view, two styles, switched in its own bar with CSS alone (radio inputs).
// Kanban by default; live, app.mjs remembers the choice so it survives the reload after
// every action.
function boardView(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links, ghosts: Ghost[], changed: ReadonlySet<string>, ext: Ext): string {
  const styles: [string, string, string][] = [["kanban", "Kanban", ICON.kanban], ["graph", "Graph", ICON.graph]];
  const radios = styles.map(([s, label]) => `<input class="view-radio" type="radio" name="board-style" id="bv-${s}"${s === "kanban" ? " checked" : ""} aria-label="${label} style" data-board-style="${s}">`).join("");
  const switches = styles.map(([s, label, icon]) => `<label for="bv-${s}">${icon}${label}</label>`).join("");
  return radios
    + `<div class="board-bar"><span class="seg" role="group" aria-label="Board style">${switches}</span>${LEGEND}</div>`
    + `<div class="bv bv-kanban">${boardHtml(nodes, trail, links, ghosts, changed, ext)}</div><div class="bv bv-graph">${graphHtml(nodes, trail, links, ghosts, changed)}</div>`;
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
function describeValue(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.map(show).join(", ") || "none";
  return JSON.stringify(val);
}

function describe(p: Record<string, unknown>): string {
  const words: Record<string, string> = { parent_id: "under", discovered_during: "found during", evidenceRef: "evidence", reason: "reason", blocker: "blocked by" };
  return Object.entries(p)
    .filter(([k, val]) => !(k === "kind" && (val === "discovered" || val === "planned")))
    .map(([k, val]) => `${words[k] ?? k} ${describeValue(val)}`)
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

// Agents: who acts on a board besides people (an AI coding agent, a factory session, tira itself, the
// sync), told apart from a person's moves at a glance: a spark on a gradient. A guess by name, from
// the names agents run under; a person's name never looks like one.
export const AGENT = /^(?:claude|codex|gpt|gemini|cursor|copilot|devin|aider|agent|bot|orchestrator|dispatcher|factory|sync)(?:$|[-_.:\d])|[-_](?:agent|bot)$|^s\d+$/i;
export const isAgent = (actor: string): boolean => actor === MACHINE_ACTOR || AGENT.test(actor);
const whoBadge = (actor: string): string => (isAgent(actor)
  ? `<span class="mover agent" title="${esc(actor)}, an agent">${actor === MACHINE_ACTOR ? ICON.auto : ICON.spark}</span>`
  : `<span class="mover t${tint(actor)}" title="${esc(actor)}">${esc(([...actor][0] ?? "?").toUpperCase())}</span>`);


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

interface DialogContext { indexOf: ReadonlyMap<string, number>; proof: Proof | undefined; live: boolean; q: string; links: Links; rowOf: ReadonlyMap<string, TreeRow>; ext: Ext }

// A linked task: one click to its dialog, with its state.
const linkTo = (key: string, ctx: Pick<DialogContext, "indexOf" | "rowOf">) => {
  const row = ctx.rowOf.get(key);
  return row ? `<a href="#t${ctx.indexOf.get(key)}">${esc(row.id)}</a>${stateBadge(row.state)}` : "";
};

function marksHtml(r: TreeRow): string {
  return [
    r.cursor ? `<span class="mark cursor">◆ next</span>` : "",
    r.active ? `<span class="mark active">● active</span>` : "",
    r.drained ? `<span class="mark drained">all subtasks closed</span>` : "",
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

// Live, a dialog can take you to its task (or idea) on the Graph: folds open, the view moves there.
const ICON_LOCATE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg>`;
const locate = (key: string, live: boolean) => (live ? `<button type="button" class="locate" data-show-on-graph="${esc(key)}">${ICON_LOCATE}Show on graph</button>` : "");

// ---------- workspace links (src/tables/links.ts) ----------
// The workspace's repo and Jira project, in a bar under the header; each task's Jira issue and
// pull requests in its dialog, and its Jira key on its card. Live, the bar offers Sync, Link
// and Connect Jira, each through its own decision.
interface Ext { links: ReadonlyMap<string, TaskLinks>; ws: WorkspaceLink | undefined }

const jiraUrl = (ext: Ext, key: string) => (ext.ws?.jira_site ? `${ext.ws.jira_site}/browse/${encodeURIComponent(key)}` : undefined);

function jiraChip(ext: Ext, task: string): string {
  const key = ext.links.get(task)?.jira?.key;
  return key === undefined ? "" : `<span class="chip jira" data-jira-key="${esc(key)}">${esc(key)}</span>`;
}

function taskLinksHtml(ext: Ext, task: string): string {
  const l = ext.links.get(task);
  if (!l || (!l.jira && l.prs.length === 0)) return "";
  const j = l.jira;
  const url = j ? jiraUrl(ext, j.key) : undefined;
  const jiraLine = !j ? "" : `<p><span class="lk">Jira</span>${url ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(j.key)}</a>` : esc(j.key)}${j.status ? `<span class="pill">${esc(j.status)}</span>` : ""}</p>`;
  const prLines = l.prs.map((p) => `<p><span class="lk">Pull request</span><a href="${esc(p.url)}" rel="noopener noreferrer">#${p.number}</a><span class="pill ${esc(p.state)}">${esc(p.state)}</span><span>${esc(p.title)}</span></p>`).join("");
  return `<div class="task-links" data-task-links>${jiraLine}${prLines}</div>`;
}

// The project's links, on the right of its name: its GitHub repo and its Jira project, each with
// its mark, one click out. Under tira serve: Sync once something is linked, Add Jira or Add GitHub
// for what's missing, and, while nothing is, one way in: Connect GitHub and Jira (to Project
// settings). A rendered file shows the links and none of the actions. (q: the project, as the
// server's links carry it.)
function projectLinksHtml(ext: Ext, live: RenderOptions["live"], q: string): string {
  const ws = ext.ws;
  const repo = ws?.repo ? `<a class="pl" href="https://github.com/${esc(ws.repo)}" rel="noopener noreferrer" title="GitHub: ${esc(ws.repo)}" data-link-repo>${ICON.github}<span>${esc(ws.repo)}</span></a>` : "";
  // the Jira project by its name, as Jira shows it ("Tira Board"), its key ("KAN") in the tooltip;
  // by its key alone when no name was saved (linked before tira kept names: until the project is
  // picked again in Project settings, or someone syncs)
  const jiraTitle = ws?.jira_name ? `${ws.jira_name} (${ws.jira_project})` : ws?.jira_project;
  const jira = ws?.jira_project && ws.jira_site ? `<a class="pl jira" href="${esc(`${ws.jira_site}/browse/${ws.jira_project}`)}" rel="noopener noreferrer" title="Jira: ${esc(jiraTitle ?? "")}" data-link-jira>${ICON.jira}<span>${esc(ws.jira_name ?? ws.jira_project)}</span></a>` : "";
  const box = (inner: string) => `<div class="proj-links" data-workspace aria-label="Linked to">${inner}</div>`;
  if (repo === "" && jira === "") return live ? box(`<a class="act primary" href="${esc(withQ("/integrations", q))}" data-integrations>${ICON.github}${ICON.jira}Connect GitHub and Jira</a>`) : "";
  if (!live) return box(repo + jira);
  const settings = esc(withQ("/integrations", q));
  const add = (ws?.jira_project ? "" : `<a class="act" href="${settings}#jira" data-add-jira>${ICON.jira}Add Jira</a>`) + (ws?.repo ? "" : `<a class="act" href="${settings}#github" data-add-repo>${ICON.github}Add GitHub</a>`);
  const sync = live.token ? `<form method="post" action="${esc(withQ("/sync", q))}" class="inline"><input type="hidden" name="token" value="${esc(live.token)}"><button class="act" type="submit" data-sync>Sync</button></form>` : "";
  return box(repo + jira + add + sync);
}

function drawerHtml(n: Placed, lines: TrailEntry[], path: string, ctx: DialogContext): string {
  const r = n.row;
  const verbs = ctx.live ? DIALOG_ACTIONS[r.state] ?? [] : [];
  const acts = verbs.length > 0 ? `<div class="drawer-acts" data-dialog-acts>${verbs.map(([ev, label]) => actLink(r, ev, label, ctx.q)).join("")}</div>` : "";
  return `<section class="drawer" id="t${n.i}" aria-label="${esc(r.id)}" role="dialog" aria-modal="true">${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a>`
    + `<div class="path">${path}</div><h2>${esc(r.id)}</h2><div class="badges">${stateBadge(r.state)}${marksHtml(r)}${locate(r.key, ctx.live)}</div>${linksHtml(r, ctx)}${taskLinksHtml(ctx.ext, r.id)}${acts}${proofHtml(r, ctx)}${kidsHtml(r, ctx)}`
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
// q: the workspace, as the server's links carry it ("w=…"), or "" for the one it started on
const confirmHref = (r: { type: string; id: string }, event: string, q: string) => esc(`/confirm?type=${encodeURIComponent(r.type)}&id=${encodeURIComponent(r.id)}&event=${event}${q ? `&${q}` : ""}`);

const actLink = (r: { type: string; id: string }, ev: string, label: string, q: string, primary = false) => `<a class="act${primary ? " primary" : ""}" href="${confirmHref(r, ev, q)}" data-act="${ev}">${label}</a>`;

const sinceText = (since: Since | undefined, verb: string): string => (since === undefined ? "" : verb + " at seq " + since.seq);

function attentionRow(n: Placed, since: Since | undefined, path: string, verb: string, live: boolean, ctx: Pick<DialogContext, "indexOf" | "rowOf" | "q">, changed: ReadonlySet<string>): string {
  const links = (ROW_ACTIONS[n.row.state] ?? []).map(([ev, label]) => actLink(n.row, ev, label, ctx.q)).join("");
  const acts = live ? `<span class="acts">${links}</span>` : "";
  // a block on a ticket: which one, and once it's closed, that the wait looks over
  const blocker = n.row.state === "blocked" && since?.blocker !== undefined ? ctx.rowOf.get(since.blocker) : undefined;
  const ready = blocker !== undefined && CLOSED.has(blocker.state) ? `<span class="ready" data-ready>ready to unblock</span>` : "";
  const waits = blocker === undefined ? "" : `<span class="by" data-blocked-by>waiting on ${linkTo(blocker.key, ctx)}</span>` + ready;
  return `<li class="att-row${changed.has(n.row.key) ? " changed" : ""}" data-attention-key="${esc(n.row.key)}" data-state="${esc(n.row.state)}"><a class="name" href="#t${n.i}">${esc(n.row.id)}</a>`
    + `<span class="path">${path}</span>${waits}<span class="since">${sinceText(since, verb)}</span>${acts}</li>`;
}

// More than FOLD_AT tasks needing you: each blocked group folds to one line (its reason, the
// tasks' names, how many), so the board stays near the top; a click opens it. The task being
// worked on never folds.
const FOLD_AT = 3;

function attentionHtml(nodes: Placed[], events: readonly StoredEvent[], stream: string, pathOf: (n: Placed) => string, live: boolean, skip: ReadonlySet<number>, changed: ReadonlySet<string>, q: string): string {
  const { blocked, working } = attentionSince(events, stream, skip);
  const ctx = { indexOf: new Map(nodes.map((n) => [n.row.key, n.i])), rowOf: new Map(nodes.map((n) => [n.row.key, n.row])), q };
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
  const folds = count > FOLD_AT;
  const blockedHtml = [...groups].map(([why, ns]) => {
    const rows = `<ul class="att-list">${ns.map((n) => attentionRow(n, blocked.get(n.row.key), pathOf(n), "blocked", live, ctx, changed)).join("")}</ul>`;
    if (!folds) return `<div class="att-group blocked" data-group="blocked" data-reason="${esc(why)}"><h3>Blocked <span class="why">${esc(why)}</span><span class="k">${ns.length}</span></h3>${rows}</div>`;
    const open = ns.some((n) => changed.has(n.row.key)) ? " open" : "";
    return `<details class="att-group blocked" data-group="blocked" data-reason="${esc(why)}"${open}><summary><span class="kind">Blocked</span><span class="why">${esc(why)}</span>`
      + `<span class="names">${ns.map((n) => esc(n.row.id)).join(", ")}</span><span class="k">${ns.length}</span></summary>${rows}</details>`;
  }).join("");
  const workingHtml = busy.length === 0 ? "" : `<div class="att-group working" data-group="in_progress"><h3>In progress<span class="k">${busy.length}</span></h3>`
    + `<ul class="att-list">${busy.map((n) => attentionRow(n, working.get(n.row.key), pathOf(n), "started", live, ctx, changed)).join("")}</ul></div>`;
  const sum = [stuck.length > 0 ? `${stuck.length} blocked` : "", busy.length > 0 ? `${busy.length} in progress` : ""].filter(Boolean).join(" · ");
  // the whole panel folds to its header line (open or shut as you left it, per browser: theme.mjs)
  return `<section class="attention" data-attention-count="${count}" aria-label="Needs attention"><details class="att-fold" open data-remember="tira-needs-you"><summary class="att-head" title="Needs you: open or fold"><h2><b>${count}</b>${count === 1 ? "needs" : "need"} you</h2><span class="sum">${sum}</span><span class="att-chev" aria-hidden="true"></span></summary>${blockedHtml}${workingHtml}</details></section>`;
}

// ---------- board ----------

// Kanban: every ticket in its status column; each card names its parent. A parent no one has
// acted on (to do, with subtasks: a grouping, like an epic) stays on the Graph; once it is
// started, blocked or closed it is a card too, saying how many of its subtasks are closed. So a
// task blocked on a new ticket keeps its card (in Blocked), beside the ticket's.
function boardHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>, links: Links, ghosts: Ghost[], changed: ReadonlySet<string>, ext: Ext): string {
  const idOf = new Map(nodes.map((n) => [n.row.key, n.row.id]));
  // when a closed task last moved (its newest entry that wasn't refused): Done and Dropped are newest first
  const movedAt = (n: Placed) => (trail.get(n.row.key) ?? []).filter((x) => !x.refused).at(-1)?.seq ?? 0;
  const leaves = nodes.filter((n) => n.row.children.length === 0 || n.row.state !== "unstarted");
  const columns: [string, string, string][] = [
    ["unstarted", "To do", "var(--dim)"], ["in_progress", "In progress", "var(--prog)"], ["blocked", "Blocked", "var(--block)"],
    ["done", "Done", "var(--done)"], ["cancelled", "Dropped", "var(--gone)"],
  ];
  const cols = columns.filter(([s]) => s !== "blocked" || leaves.some((n) => n.row.state === s)).map(([s, title, color]) => {
    const here = leaves.filter((n) => n.row.state === s);
    if (CLOSED.has(s)) here.sort((a, b) => movedAt(b) - movedAt(a) || a.i - b.i);
    const cards = here.map((n) => {
      const r = n.row;
      const cls = ["card", r.cursor ? "is-next" : "", r.state === "cancelled" ? "is-gone" : "", changed.has(r.key) ? "changed" : ""].filter(Boolean).join(" ");
      const lines = (trail.get(r.key) ?? []).length;
      const parent = n.parent ? `<span class="chip">${esc(n.parent.row.id)}</span>` : "";
      const kids = r.children.length === 0 ? "" : `<span class="chip" data-subtasks>${r.children.filter((c) => CLOSED.has(c.state)).length}/${r.children.length} subtasks</span>`;
      const found = r.discoveredDuring ? `<span class="chip" title="found during ${esc(bare(r.discoveredDuring))}">${ICON.spark}found</span>` : "";
      const blocks = (links.blocks.get(r.key) ?? []).map((k) => idOf.get(k) ?? bare(k));
      const by = links.blockedBy.get(r.key);
      const link = (blocks.length > 0 ? `<span class="chip blocks" data-blocks>${ICON.ban}blocks ${esc(blocks.join(", "))}</span>` : "")
        + (by === undefined ? "" : `<span class="chip blocks">blocked by ${esc(idOf.get(by) ?? bare(by))}</span>`);
      const last = (trail.get(r.key) ?? []).filter((x) => !x.refused).at(-1)?.actor;
      return `<a class="${cls}" href="#t${n.i}" data-card-key="${esc(r.key)}" data-state="${esc(r.state)}">${r.cursor ? `<span class="pin">◆ ${r.active ? "now" : "next"}</span>` : ""}<div class="t">${wraps(r.id)}</div>`
        + `<div class="row">${parent}${kids}${found}${link}${jiraChip(ext, r.id)}${last ? whoBadge(last) : ""}<span class="hist" title="history">${ICON.history}${lines}</span></div></a>`;
    });
    return `<div class="col"><div class="ch"><span class="dot${s === "in_progress" && here.length > 0 ? " pulse" : ""}" style="background:${color}"></span>${title}<span class="k">${here.length}</span></div>${capped(s, cards) || `<p class="empty">Nothing here</p>`}</div>`;
  }).join("");
  return `<div class="cols">${ideasColumn(ghosts, trail, changed)}${cols}</div>`;
}

// Done and Dropped only grow: past SHOWN cards, the newest stay and the rest wait behind
// "Show N more" (a checkbox and its label, so it opens with no script). Opened, the older cards
// show and "Show fewer" sits after them, at the foot of the column, not in among the cards.
// The work columns show everything.
const SHOWN = 8;
function capped(state: string, cards: string[]): string {
  if (!CLOSED.has(state) || cards.length <= SHOWN) return cards.join("");
  const rest = cards.length - SHOWN;
  return cards.slice(0, SHOWN).join("")
    + `<div class="more" data-more="${rest}"><input type="checkbox" class="more-tog" id="more-${state}"><div class="more-cards">${cards.slice(SHOWN).join("")}</div>`
    + `<label class="more-btn" for="more-${state}"><span class="m-show">Show ${rest} more</span><span class="m-hide">Show fewer</span></label></div>`;
}

// ---------- lanes (D2: regions composed, handoffs paired) ----------

// The board holds the tree (as Kanban or as a graph); Lanes shows only when the stream has
// something for it (the factory's briefs, other records, handoffs); History is the whole
// log, the audit trail.
const VIEWS: [string, string][] = [["board", "Board"], ["lanes", "Lanes"]];

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
  const singles = inStream.filter((e) => Object.keys(e.regions).length === 1 && !e.tree && !LINK_TYPES.has(e.type)); // links show on their tasks
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
// History: the project's whole log (the audit trail: every event, newest first, the rejections,
// the fingerprint, the divergence check), in a dialog opened from under the project's name, so
// the board stays the page.
const historyButton = (events: number) =>
  `<a class="history-btn" href="#history" data-open-log>${ICON.history}History<span class="k">${events}</span></a>`;
const historyHtml = (body: string) =>
  `<section class="drawer log-dialog" id="history" aria-label="History" role="dialog" aria-modal="true" data-log>${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a><h2>History</h2>${body}</div></section>`;

function logHtml(all: TrailEntry[], anomalies: FoldResult["anomalies"], others: EntityState[], rejections: Rejection[], dumpHash: string, chip: string): string {
  const alert = anomalies.length === 0 ? "" : `<div class="alert">${anomalies.length} ${anomalies.length === 1 ? "anomaly" : "anomalies"} on replay</div><ol class="feed">${anomalies.map((a) => `<li class="ev refused"><span class="av" aria-hidden="true">!</span><div class="ev-body"><div class="ev-head"><span class="ev-what">${esc(a.type)}</span><span class="ev-seq">seq ${a.seq}</span></div><div class="ev-detail">${esc(a.problem)}</div></div></li>`).join("")}</ol>`;
  const feed = all.length === 0 ? `<p class="empty">No events yet</p>` : `<ol class="feed">${[...all].reverse().map((x) => entryHtml(x, true)).join("")}</ol>`;
  const othersHtml = others.length === 0 ? "" : `<h3>Other entities</h3><div class="others">${others.map((e) => `<span class="chip">${esc(e.key)} · ${esc(Object.values(e.regions).join(" "))}</span>`).join("")}</div>`;
  const legacy = all.filter((x) => x.legacy).length;
  const legacyNote = legacy === 0 ? "" : ` · ${legacy} legacy`;
  return `<div class="log"><div class="log-top"><h3>Newest first · ${all.length} events · ${rejections.length} rejected${legacyNote}</h3>${chip}</div>${alert}${feed}${othersHtml}<h3>Dump hash</h3><div class="hash">sha256:${esc(dumpHash)}</div></div>`;
}

// ---------- page ----------

// How to read the page: one time and on demand (the brief), never on the worksurface.
// Three short paragraphs, opened from the nav and from the hash chip.
function guideHtml(dumpHash: string): string {
  return `<section class="drawer guide" id="guide" aria-label="How to read this page" role="dialog" aria-modal="true" data-guide>${SCRIM}<div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a><h2>How to read this page</h2>`
    + `<p><b>The board.</b> Kanban puts each task in its status column. Graph shows the whole tree instead: a parent above its children, each coloured by state, and a line turns green once that child is closed; a dotted line joins a task to the one it was found while working on. ◆ marks the next task ("now" once started). "Needs attention" at the top lists what is blocked, and why, and what is being worked on. A card tagged IDEA is an idea, not a task yet: it waits in the Ideas column and, on the Graph, under the task tira proposes for it; approve its file, then where it goes, and it becomes a task.</p>`
    + `<p><b>By tira.</b> A bolt on a parent means tira closed it: every child was done or cancelled, you moved on, and tira recorded the close under its own name, citing your move. A dashed ring means tira will close it when you move on. Click any task for its full history.</p>`
    + `<p><b>The fingerprint.</b> The chip at the top of History is a fingerprint of everything on this page: the sha256 of the replayed log. Run <code>tira dump --hash</code> on the same log; the same value means this page shows exactly what the log says. Full value: <code>${esc(dumpHash)}</code></p></div></section>`;
}

// The product mark, on every page's top bar (the confirm page's too): a link home, to the
// workspace's board (in a rendered file, the top of the page).
export const brand = (href: string) => `<a class="brand" href="${esc(href)}" title="Home: the board" data-home>${ICON.brand}tira</a>`;
export const BRAND = brand("/");
export const BRAND_MARK = ICON.brand;

// A project's mark: the first letter of its name (as people see it: renamed, its new one) on a
// colour picked from the name it was made with (so a rename keeps its colour, the same everywhere).
const initial = (name: string) => esc(([...name][0] ?? "?").toUpperCase());
export const projectMark = (stream: string, name = stream) => `<span class="pav t${tint(stream)}" aria-hidden="true">${initial(name)}</span>`;

// Live, every project in the store, in the sidebar (like Linear's teams): the one you're in
// first, the rest when app.mjs has read /api/workspaces, each one click away.
// "+ New project" opens its own page (new-project.ts): its name and GitHub repo, then its board.
const projectsHtml = (stream: string, home: string, q: string, name = stream) =>
  `<details class="ws projects" data-workspaces open><summary title="Your projects">Projects${ICON.chev}</summary>`
  + `<div class="ws-menu" data-ws-menu><a class="ws-item" href="${esc(home)}" aria-current="page" data-stream="${esc(stream)}">${projectMark(stream, name)}<span class="ws-t"><b>${esc(name)}</b></span></a></div>`
  + `<a class="new-project" href="${esc(withQ("/projects/new", q))}" data-new-project>${ICON.plus}New project</a></details>`;

// Live, you (your name is on the button already): your Profile settings (yours in every project:
// your accounts, how tira looks, who may sign in) and, signed in, a way out.
// (shown by the name they chose in Profile settings, if they chose one)
const profileHtml = (me: string, live: NonNullable<RenderOptions["live"]>, q: string, shown = live.name ?? me) =>
  `<details class="ws me" data-profile><summary title="You: ${esc(shown)}"${live.user ? " data-user" : ""}><span class="av">${initial(shown)}</span><span class="ws-name">${esc(shown)}</span>${ICON.chev}</summary>`
  + `<div class="ws-menu me-menu" data-me-menu>`
  + `<a class="ws-item" href="${esc(withQ("/settings", q))}" data-integrations-nav>Profile settings<small>Accounts, appearance, people</small></a>`
  + (live.user && live.token ? `<form method="post" action="/signout"><input type="hidden" name="token" value="${esc(live.token)}"><button class="ws-item" type="submit" data-signout>Sign out</button></form>` : "")
  + `</div></details>`;
// a path with the project's query on it
const withQ = (path: string, q: string) => (q === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${q}`);

// The theme switch, on every page: System (the default), Light or Dark. Radio
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

// One line: the state and why, so a missing factory file never pushes the board down.
const unevaluableHtml = (why: string) =>
  `<section class="divergence unevaluable" data-divergence-state="unevaluable" aria-label="Divergence"><div class="att-head" title="factory vs tira could not be compared, so no count is shown"><h2>Divergence UNEVALUABLE</h2>`
  + `<span class="sum why" data-unevaluable-reason>${esc(why)}</span></div></section>`;

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

// The sidebar hides and comes back with ☰ (wide screens only: a narrow one has the top bar). A
// checkbox before <main> and its label, so it works with no script; under tira serve, theme.mjs
// remembers it per browser. The label sits outside the sidebar, so it stays when the sidebar goes.
const SIDE_SHUT = `<input class="view-radio" type="checkbox" id="side-shut" aria-label="Hide the sidebar" data-remember="tira-side-shut">`;
const SIDE_TOGGLE = `<label class="side-toggle" for="side-shut" title="Hide or show the sidebar" data-side-toggle>${ICON.menu}</label>`;

// The sidebar (after Linear; a top bar on a narrow screen): the mark (home), the views, live a
// search for projects by name, this project's settings, the projects and you; then help. The theme
// is chosen in Profile settings (the rendered file, which has none, keeps its switch here).
function navHtml(live: RenderOptions["live"], views: [string, string][], home: string, stream: string, name = stream): string {
  const tabs = views.map(([t, label]) => `<label for="v-${t}">${label}</label>`).join("");
  const q = live?.query ?? "";
  const search = live ? `<label class="proj-search">${ICON.search}<input type="search" placeholder="Search projects" aria-label="Search projects by name" autocomplete="off" spellcheck="false" data-project-search></label>` : "";
  const settings = live ? `<a class="side-link" href="${esc(withQ("/integrations", q))}" data-project-settings>${ICON.sliders}Project settings</a>` : "";
  const me = live?.user ?? live?.actor; // who is signed in with GitHub, else who the page acts as
  return `${SIDE_TOGGLE}<nav class="top" aria-label="tira">${brand(home)}${search}<div class="tabs">${tabs}</div>${settings}${live ? projectsHtml(stream, home, q, name) : ""}`
    + `<div class="side-foot"><a class="help" href="#guide" title="How to read this page">${ICON.help}<span>Help</span></a>${live ? "" : THEME_SWITCH}${live && me !== undefined ? profileHtml(me, live, q) : ""}</div></nav>`;
}

// The History view's fingerprint: the sha256 of the replayed log, for whoever checks the page
// against tira dump --hash (an audit, not a daily read).
function fingerprintHtml(dumpHash: string, lastSeq: number): string {
  const shortHash = dumpHash.length > 16 ? `${dumpHash.slice(0, 8)}…${dumpHash.slice(-6)}` : dumpHash;
  return `<a class="verify" href="#guide" title="sha256:${esc(dumpHash)}: a fingerprint of this page (compare with tira dump --hash)"><span class="vl">fingerprint</span> seq ${lastSeq} · ${esc(shortHash)}</a>`;
}

// The last action's result, under tira serve.
function flashHtml(flash: { ok: boolean; text: string } | undefined): string {
  if (!flash) return "";
  return `<div class="flash ${flash.ok ? "ok" : "no"}" role="status" data-flash>${esc(flash.text)}</div>`;
}

export interface RenderOptions {
  // `tira serve`: rows and task dialogs get actions (each through a confirm dialog), the ⌘K
  // palette loads, and the last action's result shows. A rendered file never carries any of it.
  // `changed`: the keys the last action wrote to; their cards and boxes glow once.
  // `query`: the project ("w=…") when it isn't the one the server started on, kept on every link.
  // `actor`: who the page acts as; `user`: who is signed in with GitHub (shown in their place);
  // `token`: the page's own, for its forms.
  live?: { flash?: { ok: boolean; text: string; changed?: string[] }; query?: string; actor?: string; user?: string; name?: string; token?: string };
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
  const changed = new Set(opts.live?.flash?.changed ?? []);
  // the workspace on every link back to the server; home is its board (in a rendered file, the top)
  const q = opts.live?.query ?? "";
  const home = live ? withQ("/", q) : "#";
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
  // only what's worth a glance: a count that is zero stays out (but "left")
  const counted = (n: number, li: (n: number) => string) => (n > 0 ? [li(n)] : []);
  const stats = [
    ...(lanesOnly
      ? [`<li title="handoff pairs the dispatcher completed"><b>${handoffCount}</b> handoffs</li>`, `<li title="handoffs still waiting"><b>${r.handoffs[stream]?.length ?? 0}</b> waiting</li>`]
      : [`<li title="tasks still open"><b>${total - closed}</b> left</li>`, ...counted(rows.filter((x) => x.closedByTira).length, (n) => `<li title="parents tira closed by itself">${ICON.auto}<b>${n}</b> closed by tira</li>`), ...counted(rows.filter((x) => x.drained).length, (n) => `<li title="parents whose every subtask is done or dropped"><b>${n}</b> parents finished</li>`)]),
    ...counted(rejections.length, (n) => `<li title="rejected commands">${ICON.ban}<b>${n}</b> rejected</li>`),
    ...(anomalies.length > 0 ? [`<li class="warn" title="replay anomalies">${ICON.alert}<b>${anomalies.length}</b> anomalies</li>`] : []),
  ];
  // Counted from the fold, independently of the rendered rows: M1 compares the two.
  const foldTreeCount = r.entities.filter((e) => e.stream === stream && e.tree !== undefined).length;
  const lanes = lanesHtml(r, stream, events);
  const views = VIEWS.filter(([t]) => t !== "lanes" || lanes !== "");
  // Open on the view that has something: the tree, else the lanes, else the history.
  const lanesFirst = lanes !== "" && (multiNow.length > 0 || (r.handoffs[stream]?.length ?? 0) > 0);
  const skip = new Set(anomalies.map((a) => a.seq));
  const proofs = proofsOf(events, stream, skip);
  const indexOf = new Map(nodes.map((n) => [n.row.key, n.i]));
  const rowOf = new Map(nodes.map((n) => [n.row.key, n.row]));
  const links = linksOf(attentionSince(events, stream, skip).blocked, new Set(rowOf.keys()));
  const ghosts = ghostsOf(ideaRows(r, events, stream).filter((i) => OPEN_STAGES.has(i.stage)), new Set(rowOf.keys()));
  const board = v.roots.length > 0 || ghosts.length > 0;
  const ext: Ext = { links: taskLinksOf(r, stream), ws: workspaceOf(r, stream) };
  const name = ext.ws?.title ?? stream; // as people see it (renamed in Project settings)
  const first = !board && lanesFirst ? "lanes" : "board";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tira · ${esc(name)}</title><style>${CSS}</style></head>
<body>${views.map(([t, label]) => `<input class="view-radio" type="radio" name="view" id="v-${t}"${t === first ? " checked" : ""} aria-label="${label} view">`).join("")}${THEME_RADIOS}${SIDE_SHUT}
<main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}"${q === "" ? "" : ` data-q="${esc(q)}"`}>
${navHtml(opts.live, views, home, stream, name)}
${flashHtml(opts.live?.flash)}
<header class="hero"><div class="big" title="${lanesOnly ? "verified briefs, of those current" : "tasks closed, of all tasks"}">${closed}<small>/${total}</small></div><div class="who"><div class="title"><h1>${projectMark(stream, name)}${esc(name)}</h1>${board || ext.ws ? projectLinksHtml(ext, opts.live, q) : ""}<div class="title-acts">${historyButton(all.length)}</div></div><ul class="stats">${stats.join("")}</ul></div>${live ? `<button class="find" type="button" data-open-palette>${ICON.search}<span>Search tasks in ${esc(name)}</span><kbd>⌘K</kbd></button>` : ""}</header>
${v.roots.length > 0 ? attentionHtml(nodes, events, stream, pathOf, live, skip, changed, q) : ""}
<section class="view view-board" aria-label="Board">${board ? boardView(nodes, trail, links, ghosts, changed, ext) : `<p class="empty board-empty">No tasks yet. Add the first with <code>tira create</code>; Sync then mirrors them to Jira and links their pull requests.</p>`}</section>
${lanes === "" ? "" : `<section class="view view-lanes" aria-label="Lanes">${lanes}</section>`}
${nodes.map((n) => drawerHtml(n, trail.get(n.row.key) ?? [], pathOf(n), { indexOf, proof: proofs.get(n.row.key), live, q, links, rowOf, ext })).join("")}
${ghosts.map((g) => ideaDrawerHtml(g, trail.get(g.idea.key) ?? [], live, q)).join("")}
${historyHtml(`${opts.divergence !== undefined ? divergenceHtml(opts.divergence) : ""}${logHtml(all, anomalies, v.others, rejections, dumpHash, fingerprintHtml(dumpHash, v.lastSeq))}`)}
${guideHtml(dumpHash)}
</main>${live ? `<script type="module" src="/app.mjs"></script>` : ""}</body></html>
`;
}
