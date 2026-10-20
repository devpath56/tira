// D1: the read-only HTML page. Four views of the same fold: progress (every task a stop
// on one line, tira's closes carry its mark), a board (status columns, minimal cards),
// lanes and activity. Words live in a drawer that opens when you click a task: its state,
// marks and full event history. Tabs and drawers are CSS only (radio inputs and
// :target), so the page needs no JS and nothing from the network: re-run `tira render`
// and reload to refresh. The only motion is the drawer sliding in, off for reduced motion.
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
import { show } from "../text.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
const bare = (key: string) => key.replace(/^[^:]+:/, "");
// The node table's closed states (its tree config's terminal list), for progress.
const CLOSED = new Set(["done", "cancelled"]);
const fx = (n: number) => n.toFixed(1);
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
#v-train:checked~main .tabs label[for=v-train],#v-board:checked~main .tabs label[for=v-board],#v-lanes:checked~main .tabs label[for=v-lanes],#v-log:checked~main .tabs label[for=v-log]{color:var(--accent);border-bottom-color:var(--accent)}
#v-train:focus-visible~main .tabs label[for=v-train],#v-board:focus-visible~main .tabs label[for=v-board],#v-lanes:focus-visible~main .tabs label[for=v-lanes],#v-log:focus-visible~main .tabs label[for=v-log]{outline:2px solid var(--accent);outline-offset:-2px}
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
#v-train:checked~main .view-train,#v-board:checked~main .view-board,#v-lanes:checked~main .view-lanes,#v-log:checked~main .view-log{display:block}
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
.act{display:inline-block;font:550 12.5px/1.4 var(--sans);color:var(--fg);background:var(--panel);border:1px solid var(--line-2);border-radius:var(--r);padding:4px 11px;cursor:pointer;box-shadow:var(--shadow)}
.act:hover{background:var(--hover)}
.journey{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px 16px 14px;overflow-x:auto;scrollbar-width:thin;box-shadow:var(--shadow)}
.line{display:flex;align-items:flex-start;width:100%;min-width:max-content;margin:0;padding:0;list-style:none}
.leg{display:flex;flex-direction:column;min-width:0;flex:var(--n) 0 auto}
.leg-name{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);margin:0 8px 20px;padding-left:8px;border-left:2px solid var(--line-2);white-space:nowrap;display:flex;align-items:center;gap:6px}
.leg-name svg{width:12px;height:12px;color:var(--accent)}
.stops{display:flex;flex:1;margin:0;padding:0;list-style:none}
.stop{position:relative;flex:1 0 118px;display:flex;flex-direction:column;align-items:center}
.stop::before,.stop::after{content:"";position:absolute;top:20px;height:2px;width:50%;background:var(--line-2);z-index:0}
.stop::before{left:0}.stop::after{right:0}
.stop.first::before,.stop.last::after{display:none}
.stop.from-closed::before,.stop.closed::after{background:var(--done)}
.stop-link{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:0 6px;border-radius:var(--r)}
.sd{width:22px;height:22px;margin-top:10px;border-radius:999px;display:grid;place-items:center;background:var(--panel);border:2px solid var(--line-2);color:var(--dim)}
.stop-link:hover .sd{border-color:var(--accent)}
.sd svg{width:12px;height:12px}
.st-done .sd{background:var(--done);border-color:var(--done);color:var(--panel)}
.st-cancelled .sd{background:var(--gone-bg);border-color:var(--gone);color:var(--gone)}
.st-blocked .sd{background:var(--block-bg);border-color:var(--block);color:var(--block)}
.st-in_progress .sd{background:var(--prog-bg);border-color:var(--prog);color:var(--prog)}
.stop.is-next .sd{box-shadow:0 0 0 4px var(--accent-bg)}.stop.is-active .sd{box-shadow:0 0 0 4px var(--prog-bg)}
.stop .name{font-size:12px;font-weight:550;text-align:center;max-width:110px;overflow-wrap:anywhere;line-height:1.3;color:var(--fg)}
.st-done .name{color:var(--mut)}.st-cancelled .name{color:var(--dim);text-decoration:line-through}
.marker{position:absolute;top:0;left:50%;transform:translateX(-50%);width:12px;height:8px;color:var(--accent)}
.here{font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-text);background:var(--accent-bg);border-radius:4px;padding:1px 6px}
.routes{display:grid;margin-top:16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow)}
.route{display:grid;grid-template-columns:minmax(140px,1.1fr) minmax(0,2fr) auto;align-items:center;gap:12px;padding:10px 16px 10px calc(16px + (var(--d) - 1) * 20px);border-top:1px solid var(--line)}
.route:first-child{border-top:0}.route:hover{background:var(--hover)}
.route .rn{font-weight:600;display:flex;align-items:center;gap:7px;min-width:0;overflow-wrap:anywhere}
.route .rn svg{width:13px;height:13px;color:var(--accent);flex:none}
.mini{display:flex;align-items:center;min-width:0}
.mini i{display:block;width:10px;height:10px;border-radius:999px;border:2px solid var(--line-2);background:var(--panel);flex:none}
.mini b{display:block;height:2px;flex:1 1 10px;min-width:6px;max-width:44px;background:var(--line-2)}
.mini b.on{background:var(--done)}
.mini i.m-done{background:var(--done);border-color:var(--done)}.mini i.m-cancelled{background:var(--gone-bg);border-color:var(--gone)}
.mini i.m-in_progress{background:var(--prog-bg);border-color:var(--prog)}.mini i.m-blocked{background:var(--block-bg);border-color:var(--block)}
.route .ct{white-space:nowrap}.route .left{color:var(--dim)}
.wait-ring{width:12px;height:12px;border-radius:999px;border:1.5px dashed var(--warn);flex:none}
.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:16px}
.br{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:10px 12px;box-shadow:var(--shadow)}
.br:hover{border-color:var(--line-2);background:var(--hover)}
.br .nm{font-weight:600;overflow-wrap:anywhere}.br svg{width:13px;height:13px;color:var(--accent);flex:none}
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
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--panel);border-left:1px solid var(--line);padding:20px 24px 24px;overflow-y:auto;visibility:hidden;transform:translateX(100%);transition:transform .2s ease,visibility 0s .2s;box-shadow:-12px 0 32px rgba(16,24,40,.14);z-index:10}
.drawer:target{visibility:visible;transform:none;transition:transform .2s ease}
.drawer .close{position:absolute;right:16px;top:14px;width:28px;height:28px;display:grid;place-items:center;border-radius:var(--r);border:1px solid transparent;color:var(--mut);font-size:18px}
.drawer .close:hover{background:var(--hover);border-color:var(--line);color:var(--fg)}
.drawer h2{margin:4px 0 2px;font-size:18px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere;padding-right:32px}
.path{color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.state{display:inline-block;font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:4px}
.s-unstarted{color:var(--mut);background:var(--gone-bg)}.s-in_progress{color:var(--prog);background:var(--prog-bg)}.s-blocked{color:var(--block);background:var(--block-bg)}
.s-done{color:var(--done);background:var(--done-bg)}.s-cancelled{color:var(--gone);background:var(--gone-bg)}
.mark{font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:4px;background:var(--gone-bg);color:var(--mut)}
.mark.cursor,.mark.tira{color:var(--accent-text);background:var(--accent-bg)}.mark.active{color:var(--prog);background:var(--prog-bg)}.mark.wait{color:var(--warn);background:var(--warn-bg)}
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
.auto{font-size:10px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);border:1px solid currentColor;border-radius:4px;padding:0 5px}
.ev-detail{color:var(--mut);font-size:12.5px;overflow-wrap:anywhere;margin-top:1px}
.log{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:4px 16px 16px;box-shadow:var(--shadow)}
.log h3{font-size:11px;color:var(--dim);font-weight:650;letter-spacing:.06em;text-transform:uppercase;margin:16px 0 4px}
.hash{font-family:var(--mono);font-size:12px;color:var(--mut);word-break:break-all}
.others{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.alert{border:1px solid var(--line);border-left:4px solid var(--block);background:var(--block-bg);border-radius:var(--r);padding:8px 12px;margin:12px 0 0;color:var(--block);font-size:13px;font-weight:600}
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
@media (max-width:640px){
main{padding:0 16px 48px}
.tabs{margin:0;overflow-x:auto}.tabs label{padding:6px 10px}.kbd{min-width:0}.brand{padding-right:0}
.journey{overflow:visible;padding:14px 12px}
.line,.stops{flex-direction:column;min-width:0}
.leg-name{margin:6px 0}.leg{flex:none}
.stop{width:auto;flex:none;flex-direction:row;align-items:center;min-height:48px}
.stop::before,.stop::after{top:auto;left:10px;right:auto;width:2px;height:50%}
.stop::before{top:0}.stop::after{bottom:0}
.stop-link{flex-direction:row;gap:12px;padding:0}
.sd{margin-top:0;order:1}.stop .name{text-align:left;max-width:none;order:2}
.marker{order:3;position:static;transform:rotate(90deg);width:10px;height:7px}.here{order:4}
.route{grid-template-columns:1fr auto;padding-left:calc(16px + (var(--d) - 1) * 10px)}
.route .mini{grid-column:1 / -1;order:3}
}
@media (max-width:560px){.big{flex:1 1 100%}.lanes{grid-template-columns:1fr;overflow:visible}.lanes .lh{display:none}.lanes .who{padding-top:10px}.lane::before{content:attr(data-region);font-size:11px;color:var(--dim);min-width:52px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}
@media print{body{background:#fff}.top{border-image:none;border-bottom:1px solid var(--line)}.tabs,.kbd,.top .how,.theme{display:none}.view{display:block!important}.drawer{display:none}.journey{overflow:visible}}
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
};

// ---------- progress line ----------
// The work (leaf tasks) as stops on one line, in tree order: filled stops are closed,
// the marker sits on the cursor (the next task), hollow stops are what's left. Stops
// are grouped under their parent's name. Below, one short line per parent: its
// children as stops, closed / total and what's left.

interface Placed { row: TreeRow; i: number; parent?: Placed }

// Preorder: the drawer ids (#t<i>) and the train's stop order.
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
const NEXT_MARK = `<svg class="marker" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1h10L6 7z" fill="currentColor"/></svg>`;

const nodeAttrs = (r: TreeRow, lines: number) =>
  `data-key="${esc(r.key)}" data-state="${esc(r.state)}" data-drained="${r.drained}" data-cursor="${r.cursor}" data-active="${r.active}" data-depth="${r.depth}" data-closed-by-tira="${r.closedByTira}" data-awaiting-close="${r.awaitingClose}" data-history="${lines}"`;

function trainHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>): string {
  const stops = nodes.filter((n) => n.row.children.length === 0);
  // consecutive stops that share a parent ride the same leg
  const legs: Placed[][] = [];
  for (const s of stops) {
    const leg = legs.at(-1);
    if (leg && leg[0]?.parent === s.parent) leg.push(s);
    else legs.push([s]);
  }
  let k = 0;
  const stop = (n: Placed) => {
    const r = n.row;
    const at = k++;
    const prev = stops[at - 1];
    const cls = [
      "stop", `st-${r.state}`, at === 0 ? "first" : "", at === stops.length - 1 ? "last" : "",
      CLOSED.has(r.state) ? "closed" : "", prev && CLOSED.has(prev.row.state) ? "from-closed" : "",
      r.cursor ? "is-next" : "", r.active ? "is-active" : "",
    ].filter(Boolean).join(" ");
    const lines = trail.get(r.key) ?? [];
    const label = `${r.id}, ${r.state.replace("_", " ")}${r.cursor ? ", next" : ""}${r.active ? ", active" : ""}`;
    return `<li class="${cls}"><a class="stop-link" href="#t${n.i}" aria-label="${esc(label)}" ${nodeAttrs(r, lines.length)}>`
      + `${r.cursor ? NEXT_MARK : ""}<span class="sd">${STOP_GLYPH[r.state] ?? ""}</span><span class="name" title="${esc(r.id)}">${esc(short(r.id))}${r.discoveredDuring ? " ✦" : ""}</span>${r.cursor ? `<span class="here">${r.active ? "on it" : "next"}</span>` : ""}</a></li>`;
  };
  const html = legs.map((leg) => {
    const p = leg[0]?.parent?.row;
    const name = p ? `<span class="leg-name">${p.closedByTira ? ICON.auto : ""}${esc(short(p.id))}</span>` : `<span class="leg-name">top level</span>`;
    return `<li class="leg" style="--n:${leg.length}">${name}<ol class="stops">${leg.map(stop).join("")}</ol></li>`;
  }).join("");
  return `<div class="journey"><ol class="line" aria-label="Tasks in order">${html}</ol></div>`;
}

function routesHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>): string {
  const parents = nodes.filter((n) => n.row.children.length > 0);
  if (parents.length === 0) return "";
  return `<div class="routes">${parents.map((n) => {
    const r = n.row;
    const kids = r.children;
    const closed = kids.filter((c) => CLOSED.has(c.state)).length;
    const mini = kids.map((c, j) => `${j > 0 ? `<b class="${CLOSED.has(kids[j - 1]?.state ?? "") ? "on" : ""}"></b>` : ""}<i class="m-${esc(c.state)}" title="${esc(c.id)}: ${esc(c.state.replace("_", " "))}"></i>`).join("");
    const marks = `${r.closedByTira ? `<span class="tira-mark" title="closed by tira">${ICON.auto}</span>` : ""}${r.awaitingClose ? `<span class="wait-ring" title="tira closes it when you move on"></span>` : ""}`;
    const left = kids.length - closed;
    const noun = kids.length === 1 ? "task" : "tasks";
    const leftText = left === 0 ? "· all closed" : "· " + left + " left";
    return `<a class="route" href="#t${n.i}" style="--d:${r.depth}" aria-label="${esc(`${r.id}: ${closed} of ${kids.length} closed`)}" ${nodeAttrs(r, (trail.get(r.key) ?? []).length)}>`
      + `<span class="rn">${marks}${esc(short(r.id))}</span><span class="mini" aria-hidden="true">${mini}</span>`
      + `<span class="ct">${closed} of ${kids.length} ${noun} closed <span class="left">${leftText}</span></span></a>`;
  }).join("")}</div>`;
}

// ---------- history ----------

interface TrailEntry {
  seq: number;
  auto: boolean; // written by a factory transition (fx: event id, B2)
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
      add({ seq: e.seq, auto: e.eventId.startsWith("fx:"), key: `${d.intent.entity.type}:${d.intent.entity.id}`, what: `rejected ${what}`, actor, detail: `${d.reason?.code}: ${d.reason?.detail}`, refused: true });
      continue;
    }
    const d = e.data as unknown as EventData;
    if (!d?.entity) continue;
    const type = e.type.slice(0, e.type.indexOf("."));
    const p = d.payload ?? {};
    const detail = actor === MACHINE_ACTOR ? `${String(p.reason ?? "")} · ${cites(p.trigger)}` : describe(p);
    add({ seq: e.seq, auto: e.eventId.startsWith("fx:"), key: `${type}:${d.entity.id}`, what: e.type, actor, detail, refused: false });
  }
  return { byKey, all };
}

function entryHtml(x: TrailEntry, withTask = false): string {
  const tira = x.actor === MACHINE_ACTOR;
  const avatar = tira ? ICON.auto : x.refused ? "!" : esc(([...x.actor][0] ?? "?").toUpperCase());
  const cls = ["ev", tira ? "tira" : "", x.refused ? "refused" : ""].filter(Boolean).join(" ");
  return `<li class="${cls}"><span class="av" aria-hidden="true">${avatar}</span><div class="ev-body">`
    + `<div class="ev-head">${withTask ? `<span class="ev-task">${esc(bare(x.key))}</span>` : ""}<span class="ev-what">${esc(x.what)}</span><span class="ev-who">${esc(x.actor)}</span>${x.auto ? `<span class="auto" title="written by a factory transition (fx: id)">auto</span>` : ""}<span class="ev-seq">seq ${x.seq}</span></div>`
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
  const kidNoun = r.children.length === 1 ? "child" : "children";
  const kids = r.children.length > 0
    ? `<div class="kids">${meter(r.children.map((c) => c.state))}<span>${closedKids} of ${r.children.length} ${kidNoun} closed</span></div>`
    : "";
  return `<section class="drawer" id="t${n.i}" aria-label="${esc(r.id)}"><a class="close" href="#_" aria-label="Close">×</a>`
    + `<div class="path">${path}</div><h2>${esc(r.id)}</h2><div class="badges">${stateBadge(r.state)}${marks}</div>${kids}`
    + `<details class="trail" open><summary>history (${lines.length})</summary><ol class="feed">${lines.map((l) => entryHtml(l)).join("")}</ol></details></section>`;
}

// ---------- needs attention (the D1 UI brief, 2026-10-19) ----------
// Bounded by attention, not by tree size: what is blocked, grouped by the reason it was
// blocked with, and what is being worked on (the active tasks). Stale work joins once its
// time limit is ruled. States come from the fold; why and since when come from the log.

interface Since { seq: number; reason?: string }

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
    trackBlocked(blocked, key, ev, e.seq, d.payload?.reason);
    trackWorking(working, key, ev, e.seq);
  }
  return { blocked, working };
}

// The first event of a stretch counts: a repeated block or start is a no-op.
function trackBlocked(blocked: Map<string, Since>, key: string, ev: string, seq: number, reason: unknown): void {
  if (ev === "block" && !blocked.has(key)) blocked.set(key, { seq, ...(typeof reason === "string" ? { reason } : {}) });
  if (ev === "unblock" || ev === "cancel") blocked.delete(key);
}

function trackWorking(working: Map<string, Since>, key: string, ev: string, seq: number): void {
  if ((ev === "start" || ev === "unblock" || ev === "reopen") && !working.has(key)) working.set(key, { seq });
  if (ev === "block" || ev === "complete" || ev === "cancel") working.delete(key);
}

// Blocking needs a reason (2026-10-20), but it may be blank.
const whyLabel = (reason: string | undefined) => (reason !== undefined && reason.trim() !== "" ? reason : "no reason given");

// Under `tira serve`, each row offers what its state allows. Every action opens the
// confirm page first (what tira will do, then what you fill in): nothing fires from here.
const ROW_ACTIONS: Record<string, [string, string][]> = { blocked: [["UNBLOCK", "Unblock"]], in_progress: [["COMPLETE", "Complete"], ["BLOCK", "Block"]] };
const confirmHref = (r: TreeRow, event: string) => `/confirm?type=${encodeURIComponent(r.type)}&amp;id=${encodeURIComponent(r.id)}&amp;event=${event}`;

const actLink = (r: TreeRow, ev: string, label: string) => `<a class="act" href="${confirmHref(r, ev)}" data-act="${ev}">${label}</a>`;

function sinceText(r: TreeRow, since: Since | undefined, verb: string): string {
  if (r.awaitingClose) return "finished: tira closes it when you move on";
  return since === undefined ? "" : verb + " at seq " + since.seq;
}

function attentionRow(n: Placed, since: Since | undefined, path: string, verb: string, live: boolean): string {
  const links = (ROW_ACTIONS[n.row.state] ?? []).map(([ev, label]) => actLink(n.row, ev, label)).join("");
  const acts = live ? `<span class="acts">${links}</span>` : "";
  return `<li class="att-row" data-attention-key="${esc(n.row.key)}" data-state="${esc(n.row.state)}"><a class="name" href="#t${n.i}">${esc(n.row.id)}</a>`
    + `<span class="path">${path}</span><span class="since">${sinceText(n.row, since, verb)}</span>${acts}</li>`;
}

function attentionHtml(nodes: Placed[], events: readonly StoredEvent[], stream: string, pathOf: (n: Placed) => string, live: boolean, skip: ReadonlySet<number>): string {
  const { blocked, working } = attentionSince(events, stream, skip);
  const stuck = nodes.filter((n) => n.row.state === "blocked");
  const busy = nodes.filter((n) => n.row.active);
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
    + `<ul class="att-list">${ns.map((n) => attentionRow(n, blocked.get(n.row.key), pathOf(n), "blocked", live)).join("")}</ul></div>`).join("");
  const workingHtml = busy.length === 0 ? "" : `<div class="att-group working" data-group="in_progress"><h3>In progress<span class="k">${busy.length}</span></h3>`
    + `<ul class="att-list">${busy.map((n) => attentionRow(n, working.get(n.row.key), pathOf(n), "started", live)).join("")}</ul></div>`;
  const sum = [stuck.length > 0 ? `${stuck.length} blocked` : "", busy.length > 0 ? `${busy.length} in progress` : ""].filter(Boolean).join(" · ");
  return `<section class="attention" data-attention-count="${count}" aria-label="Needs attention"><div class="att-head"><h2><b>${count}</b>${count === 1 ? "needs" : "need"} you</h2><span class="sum">${sum}</span></div>${blockedHtml}${workingHtml}</section>`;
}

// ---------- board ----------

function boardHtml(nodes: Placed[], trail: Map<string, TrailEntry[]>): string {
  const parents = nodes.filter((n) => n.row.children.length > 0);
  const strip = parents.length === 0 ? "" : `<div class="strip">${parents.map((n) => {
    const r = n.row;
    const closedKids = r.children.filter((c) => CLOSED.has(c.state)).length;
    return `<a class="br" href="#t${n.i}">${r.closedByTira ? ICON.auto : ""}<span class="nm">${esc(r.id)}</span>${meter(r.children.map((c) => c.state))}<span class="ct">${closedKids}/${r.children.length}</span></a>`;
  }).join("")}</div>`;
  const leaves = nodes.filter((n) => n.row.children.length === 0);
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
      const found = r.discoveredDuring ? `<span class="chip" title="found during ${esc(bare(r.discoveredDuring))}">${ICON.spark}found</span>` : "";
      return `<a class="${cls}" href="#t${n.i}">${r.cursor ? `<span class="pin">◆ ${r.active ? "now" : "next"}</span>` : ""}<div class="t">${esc(r.id)}</div>`
        + `<div class="row">${parent}${found}<span class="hist" title="history">${ICON.history}${lines}</span></div></a>`;
    }).join("");
    return `<div class="col"><div class="ch"><span class="dot" style="background:${color}"></span>${title}<span class="k">${here.length}</span></div>${cards || `<p class="empty">Nothing here</p>`}</div>`;
  }).join("");
  return `${strip}<div class="cols">${cols}</div>`;
}

// ---------- lanes (D2: regions composed, handoffs paired) ----------

const VIEWS: [string, string][] = [["train", "Progress"], ["board", "Board"], ["lanes", "Lanes"], ["log", "Activity"]];

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

// How to read the page: one time and on demand (the brief), never on the worksurface.
// Three short paragraphs, opened from the nav and from the hash chip.
function guideHtml(dumpHash: string): string {
  return `<section class="drawer guide" id="guide" aria-label="How to read this page" data-guide><a class="close" href="#_" aria-label="Close">×</a><h2>How to read this page</h2>`
    + `<p><b>The progress line.</b> Every task is a stop, in tree order. Filled stops are done (crossed out: dropped), the blue marker sits on the next task ("on it" once started), and hollow stops are what's left. "Needs attention" at the top lists what is blocked, and why, and what is being worked on.</p>`
    + `<p><b>By tira.</b> A bolt on a parent means tira closed it: every child was done or cancelled, you moved on, and tira recorded the close under its own name, citing your move. A dashed ring means tira will close it when you move on. Click any task for its full history.</p>`
    + `<p><b>The hash.</b> The chip at the top is a fingerprint of everything on this page: the sha256 of the replayed log. Run <code>tira dump --hash</code> on the same log; the same value means this page shows exactly what the log says. Full value: <code>${esc(dumpHash)}</code></p></section>`;
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
function navHtml(dumpHash: string, lastSeq: number, live: boolean): string {
  const shortHash = dumpHash.length > 16 ? `${dumpHash.slice(0, 8)}…${dumpHash.slice(-6)}` : dumpHash;
  const tabs = VIEWS.map(([t, label]) => `<label for="v-${t}">${label}</label>`).join("");
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
  // `tira serve`: rows get actions (each through a confirm page), the ⌘K palette loads,
  // and the last action's result shows. A rendered file never carries any of it.
  live?: { flash?: { ok: boolean; text: string } };
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
  // A tree's header counts its tasks (the train's stops: the leaves), closed of total.
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
  const trainView = v.roots.length > 0 ? `${trainHtml(nodes, trail)}${routesHtml(nodes, trail)}` : `<p class="empty">No tree yet.</p>`;
  // Open on the view that has something: the tree, else the lanes, else the activity.
  const first = v.roots.length > 0 ? "train" : multiNow.length > 0 || (r.handoffs[stream]?.length ?? 0) > 0 ? "lanes" : "log";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tira · ${esc(stream)}</title><style>${CSS}</style></head>
<body>${VIEWS.map(([t, label]) => `<input class="view-radio" type="radio" name="view" id="v-${t}"${t === first ? " checked" : ""} aria-label="${label} view">`).join("")}${THEME_RADIOS}
<main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}">
${navHtml(dumpHash, v.lastSeq, live)}
${flashHtml(opts.live?.flash)}
<header class="hero"><div class="big" title="${lanesOnly ? "verified briefs, of those current" : "tasks closed, of all tasks"}">${closed}<small>/${total}</small></div><div class="who"><h1>${esc(stream)}</h1><ul class="stats">${stats.join("")}</ul></div></header>
${v.roots.length > 0 ? attentionHtml(nodes, events, stream, pathOf, live, new Set(anomalies.map((a) => a.seq))) : ""}
<section class="view view-train" aria-label="Progress">${trainView}</section>
<section class="view view-board" aria-label="Board">${v.roots.length > 0 ? boardHtml(nodes, trail) : `<p class="empty">No tree yet.</p>`}</section>
<section class="view view-lanes" aria-label="Lanes">${lanesHtml(r, stream, events)}</section>
<section class="view view-log" aria-label="Activity">${logHtml(all, anomalies, v.others, rejections, dumpHash)}</section>
${nodes.map((n) => drawerHtml(n, trail.get(n.row.key) ?? [], pathOf(n))).join("")}
${guideHtml(dumpHash)}
</main>${live ? `<script type="module" src="/app.mjs"></script>` : ""}</body></html>
`;
}
