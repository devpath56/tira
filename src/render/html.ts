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
import { show } from "../text.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
const bare = (key: string) => key.replace(/^[^:]+:/, "");
// The node table's closed states (its tree config's terminal list), for progress.
const CLOSED = new Set(["done", "cancelled"]);
const fx = (n: number) => n.toFixed(1);
// Tree labels stay inside their column; the SVG title, aria-label and drawer keep the full id.
const MAX_LABEL = 22;
const short = (id: string) => ([...id].length > MAX_LABEL ? `${[...id].slice(0, MAX_LABEL - 1).join("")}…` : id);

// Palette from Sylva (moss, petal, pollen) with GSAP's lime as the one accent.
export const CSS = `
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
#v-train:checked~main .tabs label[for=v-train],#v-board:checked~main .tabs label[for=v-board],#v-lanes:checked~main .tabs label[for=v-lanes],#v-log:checked~main .tabs label[for=v-log]{background:var(--panel);color:var(--fg);box-shadow:0 1px 0 var(--line)}
#v-train:focus-visible~main .tabs label[for=v-train],#v-board:focus-visible~main .tabs label[for=v-board],#v-lanes:focus-visible~main .tabs label[for=v-lanes],#v-log:focus-visible~main .tabs label[for=v-log]{outline:2px solid var(--lime);outline-offset:1px}
.verify{margin-left:0;font-family:var(--mono);font-size:11.5px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:var(--panel-2);white-space:nowrap}
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
#v-train:checked~main .view-train,#v-board:checked~main .view-board,#v-lanes:checked~main .view-lanes,#v-log:checked~main .view-log{display:block}
.lanes{display:grid;grid-template-columns:minmax(90px,.8fr) repeat(var(--n),minmax(120px,1fr));gap:10px;align-items:center;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px;overflow-x:auto}
.lanes-label{margin:18px 0 8px;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}.lanes-label:first-child{margin-top:4px}
.lanes .lh{font-size:11.5px;font-weight:650;color:var(--dim);padding:0 4px 4px}
.lanes .who{font-weight:650;overflow-wrap:anywhere;padding:4px}.lanes .who.old{color:var(--dim);text-decoration:line-through}
.lane{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 12px;border-radius:10px;background:var(--panel);border:1px solid var(--line);min-height:36px;animation:fade .45s var(--ease) both}
.pill{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--panel-2);color:var(--mut);white-space:nowrap}
.pill.go{color:var(--done);background:var(--done-bg)}.pill.work{color:var(--prog);background:var(--prog-bg)}.pill.stop{color:var(--block);background:var(--block-bg)}.pill.wait{color:var(--pollen);background:transparent;box-shadow:inset 0 0 0 1px var(--pollen)}
.cap{font-size:11.5px;color:var(--mut);display:inline-flex;align-items:center;gap:4px}
.cap .av{width:18px;height:18px;font-size:10px}
.chips2{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0}
.pairs{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}
.pairs li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:7px 10px}
.pairs .arrow{color:var(--lime);font-weight:700}.pairs code{font-family:var(--mono);font-size:11.5px;color:var(--fg)}
.pairs li.waiting{border-style:dashed}
.ready{font-size:10.5px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--lime);display:block}
.needs{font-size:11px;color:var(--pollen);display:block;overflow-wrap:anywhere}
@keyframes fade{from{opacity:.3;transform:translateY(6px)}}
.journey{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:18px 16px 14px;overflow-x:auto;scrollbar-width:thin}
.line{display:flex;align-items:flex-start;width:100%;min-width:max-content;margin:0;padding:0;list-style:none}
.leg{display:flex;flex-direction:column;min-width:0;flex:var(--n) 0 auto}
.leg-name{font-size:11.5px;font-weight:650;color:var(--dim);margin:0 8px 26px;padding-left:8px;border-left:2px solid var(--line);white-space:nowrap;display:flex;align-items:center;gap:6px}
.leg-name svg{width:13px;height:13px;color:var(--lime)}
.stops{display:flex;flex:1;margin:0;padding:0;list-style:none}
.stop{position:relative;flex:1 0 118px;display:flex;flex-direction:column;align-items:center;animation:fade .45s var(--ease) both;animation-delay:calc(min(var(--k),30) * 35ms)}
.stop::before,.stop::after{content:"";position:absolute;top:21px;height:4px;width:50%;background:var(--line);z-index:0}
.stop::before{left:0}.stop::after{right:0}
.stop.first::before,.stop.last::after{display:none}
.stop.from-closed::before,.stop.closed::after{background:var(--done)}
.stop-link{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:7px;padding:0 6px;border-radius:12px;color:inherit}
.stop-link:focus-visible{outline:2px solid var(--lime);outline-offset:3px}
.sd{width:26px;height:26px;margin-top:10px;border-radius:999px;display:grid;place-items:center;background:var(--panel);border:2.5px solid var(--moss-2);transition:transform .25s var(--ease)}
.stop-link:hover .sd{transform:scale(1.12)}
.sd svg{width:14px;height:14px}
.st-done .sd{background:var(--done);border-color:var(--done);color:var(--panel)}
.st-cancelled .sd{background:var(--panel-2);border-color:var(--gone);color:var(--gone)}
.st-blocked .sd{border-color:var(--block);color:var(--block)}
.st-in_progress .sd{border-color:var(--prog);background:var(--prog-bg);color:var(--prog)}
.stop.is-active .sd{box-shadow:0 0 0 0 var(--prog-bg);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 8px var(--prog-bg)}}
.name{font-size:12.5px;font-weight:600;text-align:center;max-width:110px;overflow-wrap:anywhere;line-height:1.3;color:var(--fg)}
.st-done .name{color:var(--mut)}.st-cancelled .name{color:var(--dim);text-decoration:line-through}
.train{position:absolute;top:-22px;left:50%;transform:translateX(-50%);width:34px;height:22px;color:var(--lime);animation:bob 2.2s ease-in-out infinite;z-index:2}
@keyframes bob{50%{transform:translate(-50%,-3px)}}
.here{font-size:10.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:var(--lime)}
.routes{display:grid;gap:8px;margin-top:14px}
.route{display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(0,2fr) auto;align-items:center;gap:12px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-left:calc((var(--d) - 1) * 18px);transition:transform .25s var(--ease),border-color .2s}
.route:hover{transform:translateY(-1px);border-color:var(--moss-2)}
.route:focus-visible{outline:2px solid var(--lime);outline-offset:2px}
.route .rn{font-weight:650;display:flex;align-items:center;gap:7px;min-width:0;overflow-wrap:anywhere}
.route .rn svg{width:14px;height:14px;color:var(--lime);flex:none}
.mini{display:flex;align-items:center;min-width:0}
.mini i{display:block;width:14px;height:14px;border-radius:999px;border:2px solid var(--moss-2);background:var(--panel);flex:none}
.mini b{display:block;height:3px;flex:1 1 10px;min-width:6px;max-width:44px;background:var(--line)}
.mini b.on{background:var(--done)}
.mini i.m-done{background:var(--done);border-color:var(--done)}.mini i.m-cancelled{background:var(--panel-2);border-color:var(--gone)}
.mini i.m-in_progress{background:var(--prog-bg);border-color:var(--prog)}.mini i.m-blocked{border-color:var(--block)}
.route .ct{white-space:nowrap}.route .left{color:var(--dim)}
.wait-ring{width:13px;height:13px;border-radius:999px;border:1.6px dashed var(--pollen);flex:none}
@media (max-width:640px){
.journey{overflow:visible;padding:14px 12px}
.line,.stops{flex-direction:column;min-width:0}
.leg-name{margin:6px 0 6px 0}.leg{flex:none}
.stop{width:auto;flex:none;flex-direction:row;align-items:center;min-height:52px}
.stop::before,.stop::after{top:auto;left:21px;right:auto;width:4px;height:50%}
.stop::before{top:0}.stop::after{bottom:0}
.stop-link{flex-direction:row;gap:12px;padding:0}
.sd{margin-top:0}
.name{text-align:left;max-width:none}
.sd{order:1}.name{order:2}.train{order:3;position:static;transform:none;animation:none;width:30px;height:20px}.here{order:4}
.route{grid-template-columns:1fr auto;margin-left:calc((var(--d) - 1) * 10px)}
.route .mini{grid-column:1 / -1;order:3}
}
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
.attention{margin:14px 0 18px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px}
.att-head{display:flex;align-items:baseline;gap:6px 12px;flex-wrap:wrap}
.att-head h2{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em}
.att-head h2 b{font-size:26px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;margin-right:4px}
.att-head .sum{color:var(--mut);font-size:13px}
.att-group{margin-top:12px}
.att-group h3{margin:0 0 6px;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.att-group.blocked h3{color:var(--block)}.att-group.working h3{color:var(--prog)}
.att-group h3 .why{text-transform:none;letter-spacing:0;font-weight:600;font-size:13px;color:var(--fg);overflow-wrap:anywhere}
.att-group h3 .k{color:var(--mut);font-weight:600}
.att-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.att-row{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.att-row .name{font-weight:650;overflow-wrap:anywhere}.att-row .name:hover{text-decoration:underline}
.att-row .path{color:var(--dim);font-size:12px;overflow-wrap:anywhere}
.att-row .since{margin-left:auto;color:var(--mut);font-family:var(--mono);font-size:11.5px;white-space:nowrap}
.attention.calm .att-head h2{color:var(--done)}
.attention.calm p{margin:6px 0 0;color:var(--mut);font-size:13px}.attention.calm p a{color:var(--fg);font-weight:650;text-decoration:underline}
#v-lanes:checked~main .attention,#v-log:checked~main .attention{display:none}
.att-row .acts{display:flex;gap:6px}
.act{font:600 12px var(--sans);color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.act:hover,.act:focus-visible{border-color:var(--moss-2);outline:none}
.how{margin-left:auto;font-size:12px;color:var(--mut);text-decoration:underline;text-underline-offset:3px}.kbd~.how{margin-left:0}
a.verify:hover,a.verify:focus-visible{border-color:var(--moss-2);color:var(--fg);outline:none}.verify .vl{font-family:var(--sans);font-weight:600;color:var(--fg);margin-right:4px}
.guide p{margin:0 0 10px;color:var(--fg);font-size:13.5px;line-height:1.55}.guide code{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.flash{margin:12px 0 0;padding:9px 12px;border-radius:10px;font-size:13px;border:1px solid var(--line);background:var(--panel)}
.flash.ok{border-color:var(--done);color:var(--done)}.flash.no{border-color:var(--block);color:var(--block)}
.kbd{margin-left:auto;font:600 12px var(--sans);color:var(--mut);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.palette{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;z-index:50}
.palette[hidden]{display:none}
.pal-box{width:min(560px,100%);background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.25);overflow:hidden}
.pal-box input{width:100%;font:500 16px var(--sans);color:var(--fg);background:transparent;border:0;border-bottom:1px solid var(--line);padding:14px 16px;outline:none}
.pal-list{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.pal-list li{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:9px;cursor:pointer}
.pal-list li[aria-selected=true]{background:var(--panel-2);box-shadow:inset 0 0 0 1px var(--line)}
.pal-list .pid{font-weight:650}.pal-list .ppath{color:var(--dim);font-size:12px;overflow-wrap:anywhere}.pal-list .pverb{margin-left:auto;font-size:12px;color:var(--prog)}
.pal-hint{padding:8px 14px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
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
.auto{font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--lime);border:1px solid var(--lime);border-radius:999px;padding:0 6px}
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

// ---------- progress train ----------
// The work (leaf tasks) as stops on one line, in tree order: filled stops are closed,
// the train sits on the cursor (the next task), hollow stops are what's left. Stops
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
const TRAIN = `<svg class="train" viewBox="0 0 34 22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="22" height="11" rx="3.5"/><path d="M25 7h3.5a2.5 2.5 0 0 1 2.5 2.5V15H25"/><path d="M8 4V1.5h5V4"/><circle cx="9" cy="18" r="2.3"/><circle cx="20" cy="18" r="2.3"/><path d="M7 8.5h4M15 8.5h4"/></svg>`;

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
    return `<li class="${cls}" style="--k:${at}"><a class="stop-link" href="#t${n.i}" aria-label="${esc(label)}" ${nodeAttrs(r, lines.length)}>`
      + `${r.cursor ? TRAIN : ""}<span class="sd">${STOP_GLYPH[r.state] ?? ""}</span><span class="name" title="${esc(r.id)}">${esc(short(r.id))}${r.discoveredDuring ? " ✦" : ""}</span>${r.cursor ? `<span class="here">${r.active ? "on it" : "next"}</span>` : ""}</a></li>`;
  };
  const html = legs.map((leg) => {
    const p = leg[0]?.parent?.row;
    const name = p ? `<span class="leg-name">${p.closedByTira ? ICON.leaf : ""}${esc(short(p.id))}</span>` : `<span class="leg-name">top level</span>`;
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
    const marks = `${r.closedByTira ? `<span class="tira-mark" title="closed by tira">${ICON.leaf}</span>` : ""}${r.awaitingClose ? `<span class="wait-ring" title="tira closes it when you move on"></span>` : ""}`;
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
  const avatar = tira ? ICON.leaf : x.refused ? "!" : esc(([...x.actor][0] ?? "?").toUpperCase());
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
  const rows = multi.map((e, k) => {
    const cells = Object.entries(e.regions).map(([region, state]) => {
      const cap = e.context?.[region] ?? {};
      const extra = [
        cap.claimant !== undefined ? `<span class="cap" title="claimed by ${esc(show(cap.claimant))}">${avatar(cap.claimant)}${esc(show(cap.claimant))}</span>` : "",
        cap.block_reason !== undefined ? `<span class="cap">${esc(show(cap.block_reason))}</span>` : "",
      ].join("");
      return `<div class="lane" style="animation-delay:${fx(0.04 * k)}s" data-lane="${esc(e.key)}" data-region="${esc(region)}" data-state="${esc(state)}">${pill(state)}${extra}</div>`;
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
    + `<p><b>The train.</b> Every task is a stop, in tree order. Filled stops are done (crossed out: dropped), the train sits on the next task ("on it" once started), and hollow stops are what's left. "Needs attention" at the top lists what is blocked, and why, and what is being worked on.</p>`
    + `<p><b>By tira.</b> A leaf on a parent means tira closed it: every child was done or cancelled, you moved on, and tira recorded the close under its own name, citing your move. A dashed ring means tira will close it when you move on. Click any task for its full history.</p>`
    + `<p><b>The hash.</b> The chip at the top is a fingerprint of everything on this page: the sha256 of the replayed log. Run <code>tira dump --hash</code> on the same log; the same value means this page shows exactly what the log says. Full value: <code>${esc(dumpHash)}</code></p></section>`;
}

// The top bar: views, the search button (live only), the guide link and the hash chip.
function navHtml(dumpHash: string, lastSeq: number, live: boolean): string {
  const shortHash = dumpHash.length > 16 ? `${dumpHash.slice(0, 8)}…${dumpHash.slice(-6)}` : dumpHash;
  const tabs = VIEWS.map(([t, label]) => `<label for="v-${t}">${label}</label>`).join("");
  const search = live ? `<button class="kbd" type="button" data-open-palette>Search ⌘K</button>` : "";
  return `<nav class="top"><span class="brand">${ICON.brand}tira</span><div class="tabs">${tabs}</div>${search}<a class="how" href="#guide">How to read this page</a>`
    + `<a class="verify" href="#guide" title="sha256:${esc(dumpHash)}: a fingerprint of this page (compare with tira dump --hash)"><span class="vl">fingerprint</span> seq ${lastSeq} · ${esc(shortHash)}</a></nav>`;
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
      : [`<li title="tasks still open"><b>${total - closed}</b> left</li>`, `<li title="parents closed by tira">${ICON.leaf}<b>${rows.filter((x) => x.closedByTira).length}</b> by tira</li>`, `<li title="drained: every child done or cancelled"><b>${rows.filter((x) => x.drained).length}</b> drained</li>`]),
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
<body>${VIEWS.map(([t, label]) => `<input class="view-radio" type="radio" name="view" id="v-${t}"${t === first ? " checked" : ""} aria-label="${label} view">`).join("")}
<main data-stream="${esc(stream)}" data-last-seq="${v.lastSeq}" data-node-count="${v.nodeCount}" data-fold-tree-count="${foldTreeCount}" data-dump-hash="${esc(dumpHash)}">
<span class="pollen" style="left:64%;top:180px"></span><span class="pollen" style="left:82%;top:420px;animation-delay:-5s"></span><span class="pollen" style="left:40%;top:560px;animation-delay:-9s"></span>
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
