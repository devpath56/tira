// A first-time person's welcome on the board (Isha, 2026-10-26), after Jira's quick start and the
// short animated tours of Linear and Notion: a tour of tira's hero features in five scenes, each a
// small moving picture made of tira's own pieces (cards crossing the Kanban, a pull request
// closing a task, tira closing the parent, an agent at work, a teammate joining), then a Get
// started checklist in the sidebar that ticks itself off as the person does each thing.
//
// - The tour opens by itself once per person (remembered on their account: account_seen "tour"),
//   and again from Help's Take the tour button. Back, Next, Skip; the arrow keys and Esc. It's tour.mjs
//   that plays it: with no script, the board is as it was.
// - The checklist shows until it's hidden ("checklist-hidden"); finishing the tour brings it back.
// - Still, fully drawn, under Reduce Motion; tira's colours, light or dark.
import { esc } from "../render/escape.ts";
import { BRAND_MARK } from "../render/html.ts";
import { GITHUB_MARK } from "./welcome.ts";

// what the checklist knows about this project and this person
export interface Progress { repo: boolean; tasks: boolean; agent: boolean; team: boolean; proven: boolean }
// a task was finished with proof (a commit or pull request), in this project's log
export const provenIn = (events: readonly { type: string; data: Record<string, unknown> }[]): boolean =>
  events.some((e) => e.type.endsWith(".complete") && typeof (e.data.payload as { evidenceRef?: unknown } | undefined)?.evidenceRef === "string");

const joiner = (path: string) => (path.includes("?") ? "&" : "?");
const withQ = (path: string, q: string) => (q === "" ? path : path + joiner(path) + q);
const tokenField = (token: string) => `<input type="hidden" name="token" value="${esc(token)}">`;

// ---------- the Get started checklist ----------
export function checklistHtml(p: Progress, token: string, q: string): string {
  const steps: [boolean, string, string, string][] = [
    [p.repo, "Link your GitHub repo", withQ("/integrations", q) + "#github", ""],
    [p.tasks, "Get your first task on the board", withQ("/", q) + "#create", ""],
    [p.agent, "Connect an agent", withQ("/integrations", q) + "#agents", ""],
    [p.team, "Add a collaborator", withQ("/integrations", q) + "#team", ""],
    [p.proven, "Finish a task with proof", "", "A commit or pull request"],
  ];
  const done = steps.filter(([d]) => d).length;
  const step = ([d, label, href, hint]: [boolean, string, string, string]) => {
    const what = href && !d ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`;
    const how = hint && !d ? `<small>${esc(hint)}</small>` : "";
    return `<li${d ? ' class="done"' : ""}><i aria-hidden="true"></i>${what}${how}<span class="sr">${d ? " (done)" : ""}</span></li>`;
  };
  const head = done === steps.length ? "You're all set" : "Get started";
  return `<section class="gs" aria-label="Get started" data-get-started><div class="gs-head"><b>${head}</b><span class="gs-count">${done} of ${steps.length}</span>`
    + `<form method="post" action="${esc(withQ("/onboarding", q))}" class="gs-hide-form">${tokenField(token)}<input type="hidden" name="do" value="hide-checklist"><button class="gs-hide" type="submit" title="Hide Get started" aria-label="Hide Get started" data-hide-checklist>×</button></form></div>`
    + `<div class="gs-bar" aria-hidden="true"><i style="width:${Math.round((done / steps.length) * 100)}%"></i></div>`
    + `<ol class="gs-list">${steps.map(step).join("")}</ol></section>`;
}

// ---------- the tour ----------
// each scene: its picture, its title, a line
const card = (x: number, y: number, w: number, label: string, cls = "") => `<g class="tn ${cls}"><rect x="${x}" y="${y}" width="${w}" height="30" rx="8"/><circle cx="${x + 14}" cy="${y + 15}" r="4"/><text x="${x + 26}" y="${y + 19.5}">${label}</text></g>`;

const TREE = `<svg class="ts-tree" viewBox="0 0 560 220" role="presentation">`
  + `<path class="tl l1" d="M280 44 C280 70 140 68 140 94"/><path class="tl l2" d="M280 44 C280 70 420 68 420 94"/>`
  + `<path class="tl l3" d="M140 124 C140 150 70 148 70 174"/><path class="tl l4" d="M140 124 C140 150 210 148 210 174"/>`
  + `<path class="tl l5" d="M420 124 C420 150 350 148 350 174"/><path class="tl l6" d="M420 124 C420 150 490 148 490 174"/>`
  + card(228, 14, 104, "Launch", "n0 doing") + card(88, 94, 104, "Design", "n1 done") + card(368, 94, 104, "Build", "n2 doing")
  + card(18, 174, 104, "Logo", "n3 done") + card(158, 174, 104, "Colours", "n4 done") + card(298, 174, 104, "Pages", "n5 doing") + card(438, 174, 104, "Deploy", "n6 todo")
  + `</svg>`;

// (its classes are tv-: the board's own tk- are the ticket's, and a tour sharing them broke tickets)
const BOARD = `<div class="tv"><div class="tv-search"><kbd>⌘K</kbd><b class="tv-type">checkout</b></div><div class="tv-cols">`
  + `<div class="tv-col"><i>To do</i><span class="tv-card">Logo</span><span class="tv-card">Pages</span></div>`
  + `<div class="tv-col"><i>In progress</i><span class="tv-card doing">Colours</span></div>`
  + `<div class="tv-col"><i>Done</i><span class="tv-card done">Design</span></div></div><span class="tv-move">Checkout</span></div>`;

const BOLT = `<path class="tp-bolt" d="M374 18 l-9 14 h7 l-4 12 l11 -16 h-7 z"/>`;
const PROOF = `<svg class="ts-proof" viewBox="0 0 560 220" role="presentation">`
  + `<path class="tl" d="M280 62 C280 100 145 100 145 140"/><path class="tl" d="M280 62 C280 100 405 100 405 140"/>`
  + `<g class="tp-parent"><rect x="196" y="22" width="168" height="40" rx="10"/><rect class="tp-parent-done" x="196" y="22" width="168" height="40" rx="10"/><circle class="tp-ring-track" cx="222" cy="42" r="9"/><circle class="tp-ring" cx="222" cy="42" r="9"/><text x="242" y="47">Checkout</text></g>`
  + BOLT
  + `<g class="tn done"><rect x="80" y="140" width="130" height="34" rx="9"/><circle cx="96" cy="157" r="4"/><text x="108" y="162">Cart</text></g>`
  + `<g class="tn tp-pay"><rect x="340" y="140" width="130" height="34" rx="9"/><rect class="tp-pay-done" x="340" y="140" width="130" height="34" rx="9"/><circle cx="356" cy="157" r="4"/><text x="368" y="162">Payment</text></g>`
  + `<g class="tp-chip"><rect x="392" y="186" width="122" height="24" rx="12"/><text x="453" y="202">PR #42 merged</text></g>`
  + `</svg>`;

const AGENTS = `<div class="ta"><div class="ta-card"><b>Payment</b><span class="ta-agent"><i>C</i>claude-code · started</span></div>`
  + `<div class="ta-idea"><em>IDEA</em><b>Retry failed payments</b><span class="ta-act"><span class="ta-approve">Approve</span><span class="ta-approved">Approved</span></span></div></div>`;

const JIRA = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M5.5 2.5v11M10.5 2.5v11"/></svg>`;
const TEAM = `<div class="tt"><div class="tt-people"><span class="tt-av">I</span><span class="tt-av a2">D</span><span class="tt-av a3">R</span><em class="tt-added">@devansh added</em></div>`
  + `<div class="tt-sync"><span class="tt-logo">${GITHUB_MARK}</span><i class="tt-flow"></i><span class="tt-logo tira">${BRAND_MARK}</span><i class="tt-flow"></i><span class="tt-logo">${JIRA}</span></div><p class="tt-synced">Synced</p></div>`;

const SCENES = (name: string): [string, string, string][] => [
  [TREE, `Welcome to tira, ${name}`, "Plan your work as a tree of tasks: big goals branch into the steps that get them done."],
  [BOARD, "Your board, and the whole tree", "Kanban puts each task in its column, the Graph shows the whole tree, and ⌘K finds any task."],
  [PROOF, "Done means proven", "Finish a task with a commit or pull request as proof. When the last child is done, tira closes the parent for you."],
  [AGENTS, "Agents work beside you", "Claude Code and others take tasks under their own names, by tira's rules. Their ideas wait for you to approve."],
  [TEAM, "Bring your team", "Add people by GitHub username in Project settings. Link GitHub and Jira, and sync."],
];

// auto: open by itself (the person hasn't seen it yet)
export function tourHtml(name: string, token: string, q: string, auto: boolean): string {
  const scenes = SCENES(name).map(([pic, title, line], i) => `<li class="tour-scene" data-tour-scene hidden><div class="tour-stage" aria-hidden="true">${pic}</div><h2 id="tour-t${i + 1}">${esc(title)}</h2><p>${esc(line)}</p></li>`).join("");
  const dots = SCENES(name).map((_, i) => `<span class="tour-dot" data-tour-dot aria-label="Step ${i + 1} of 5"></span>`).join("");
  return `<style>${TOUR_CSS}</style><div class="tour" data-tour${auto ? ' data-auto="1"' : ""} data-action="${esc(withQ("/onboarding", q))}" hidden role="dialog" aria-modal="true" aria-labelledby="tour-t1">`
    + `<div class="tour-scrim" data-tour-skip></div><div class="tour-box">${tokenField(token)}<ol class="tour-scenes">${scenes}</ol>`
    // Back on the left (kept in its place on the first scene, where it's hidden), the dots in the
    // middle, Skip tour and Next together on the right: neither moves from scene to scene
    + `<div class="tour-foot"><button type="button" class="act tour-back" data-tour-back>Back</button><div class="tour-dots">${dots}</div>`
    + `<div class="tour-go"><button type="button" class="tour-skip" data-tour-skip>Skip tour</button><button type="button" class="act primary" data-tour-next>Next</button></div></div></div></div>`;
}

// The tour's and the checklist's look: tira's colours, the board's cards; every moving part is
// drawn at its end state, so Reduce Motion (no animation at all) shows each scene complete.
const TOUR_CSS = `
.tour{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:16px}
.tour[hidden]{display:none}
.tour-scrim{position:absolute;inset:0;background:color-mix(in srgb,#000 48%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.tour-box{position:relative;width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:22px;padding:22px 22px 18px;background:var(--panel);
box-shadow:0 0 0 .5px color-mix(in srgb,var(--fg) 14%,transparent),0 40px 100px -30px rgba(0,0,0,.55)}
.tour-scenes{list-style:none;margin:0;padding:0}
.tour-scene h2{margin:0 0 6px;font-size:22px;letter-spacing:-.015em}
.tour-scene p{margin:0;font-size:15px;line-height:1.5;color:var(--mut)}
.tour-stage{position:relative;height:220px;margin-bottom:18px;border-radius:14px;overflow:hidden;
background:radial-gradient(60% 80% at 20% 100%,color-mix(in srgb,var(--done) 16%,transparent),transparent 70%),radial-gradient(60% 80% at 90% 0%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%),var(--panel-2)}
.tour-stage>svg{position:absolute;inset:0;width:100%;height:100%}
.tour-foot{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;margin-top:18px}
.tour-back{justify-self:start}
.tour-dots{display:flex;gap:6px}
.tour-go{justify-self:end;display:flex;align-items:center;gap:6px}
.tour-dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);transition:width .25s,background .25s}
.tour-dot[aria-current="step"]{width:20px;border-radius:4px;background:var(--btn)}
.tour-skip{background:none;border:0;font:inherit;font-size:14px;color:var(--mut);cursor:pointer;padding:8px}.tour-skip:hover{color:var(--fg)}
.tour-foot .act{min-height:36px;padding:0 16px}
.tour-foot .act[disabled]{visibility:hidden}
/* the cards in the pictures */
.tn rect{fill:var(--panel);stroke:var(--line-2);stroke-width:1}
.tn text,.tp-parent text{font:600 12px var(--sans);fill:var(--fg)}
.tn circle{fill:var(--dim)}.tn.done circle{fill:var(--done)}.tn.doing circle{fill:var(--accent)}
.tl{fill:none;stroke:color-mix(in srgb,var(--done) 55%,var(--line-2));stroke-width:1.6;stroke-dasharray:240;stroke-dashoffset:0}
/* 1: the tree grows */
.ts-tree .tn{transform-box:fill-box;transform-origin:center}
.tour-scene.on .ts-tree .n0{animation:tour-grow-a 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ts-tree .n1,.tour-scene.on .ts-tree .n2{animation:tour-grow-b 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ts-tree .n3,.tour-scene.on .ts-tree .n4{animation:tour-grow-c 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ts-tree .n5,.tour-scene.on .ts-tree .n6{animation:tour-grow-d 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ts-tree .l1,.tour-scene.on .ts-tree .l2{animation:tour-line-b 8s ease-out infinite both}
.tour-scene.on .ts-tree .l3,.tour-scene.on .ts-tree .l4{animation:tour-line-c 8s ease-out infinite both}
.tour-scene.on .ts-tree .l5,.tour-scene.on .ts-tree .l6{animation:tour-line-d 8s ease-out infinite both}
/* 2: a card crosses the board; ⌘K finds it */
.tv{position:absolute;inset:0;padding:14px 16px}
.tv-search{display:flex;align-items:center;gap:8px;width:220px;height:30px;padding:0 10px;border-radius:9px;background:var(--panel);box-shadow:0 0 0 1px var(--line);font-size:13px;color:var(--mut)}
.tv-search kbd{font:600 11px var(--mono);padding:2px 5px;border-radius:5px;background:var(--panel-2);color:var(--mut)}
.tv-type{display:inline-block;overflow:hidden;white-space:nowrap;width:8ch;color:var(--fg);font-weight:500;border-right:1.5px solid var(--accent)}
.tv-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.tv-col{display:grid;align-content:start;gap:6px;min-height:150px;padding:8px;border-radius:10px;background:color-mix(in srgb,var(--panel) 60%,transparent)}
.tv-col i{font:600 11px var(--sans);letter-spacing:.06em;text-transform:uppercase;font-style:normal;color:var(--dim)}
.tv-card,.tv-move{display:block;padding:7px 9px;border-radius:8px;background:var(--panel);box-shadow:0 0 0 1px var(--line);font-size:12px;font-weight:600;border-left:3px solid var(--dim)}
.tv-card.doing{border-left-color:var(--accent)}.tv-card.done{border-left-color:var(--done)}
.tv-move{position:absolute;top:144px;left:calc(68% + 4px);width:calc(29% - 14px);border-left-color:var(--done);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 60%,transparent),0 10px 24px -10px rgba(0,0,0,.4)}
.tour-scene.on .tv-move{animation:tour-cross 7s cubic-bezier(.5,0,.2,1) infinite both}
.tour-scene.on .tv-type{animation:tour-type 7s steps(8) infinite both}
/* 3: a pull request proves a task; tira closes the parent */
.tp-parent rect{fill:var(--panel);stroke:var(--line-2)}
.tp-parent-done,.tp-pay-done{fill:color-mix(in srgb,var(--done) 22%,var(--panel))!important;stroke:var(--done)!important}
.tp-ring-track{fill:none;stroke:var(--line-2);stroke-width:2.5}
.tp-ring{fill:none;stroke:var(--done);stroke-width:2.5;stroke-dasharray:57;stroke-dashoffset:0;transform:rotate(-90deg);transform-box:fill-box;transform-origin:center}
.tp-bolt{fill:var(--accent);transform-box:fill-box;transform-origin:center}
.tp-chip rect{fill:var(--accent)}.tp-chip text{font:600 11px var(--sans);fill:var(--btn-fg);text-anchor:middle}
.tp-chip{transform:translate(-40px,-70px)}
.tour-scene.on .tp-chip{animation:tour-chip 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .tp-pay-done{animation:tour-show-1 8s ease infinite both}
.tour-scene.on .tp-ring{animation:tour-ring 8s ease infinite both}
.tour-scene.on .tp-parent-done{animation:tour-show-2 8s ease infinite both}
.tour-scene.on .tp-bolt{animation:tour-bolt 8s cubic-bezier(.2,.7,.2,1) infinite both}
/* 4: an agent takes a task; its idea waits for you */
.ta{position:absolute;inset:0;display:grid;align-content:center;justify-items:center;gap:16px}
.ta-card,.ta-idea{display:grid;gap:8px;width:min(320px,80%);padding:12px 14px;border-radius:12px;background:var(--panel);box-shadow:0 0 0 1px var(--line);border-left:3px solid var(--accent)}
.ta-card b,.ta-idea b{font-size:14px}
.ta-agent{display:inline-flex;align-items:center;gap:6px;justify-self:start;padding:3px 9px 3px 3px;border-radius:999px;background:var(--accent-bg);color:var(--accent-text);font-size:12px;font-weight:600}
.ta-agent i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--accent);color:var(--btn-fg);font-style:normal;font-size:11px}
.ta-idea{border-left-color:var(--done)}
.ta-idea em{font:700 11px var(--sans);letter-spacing:.08em;font-style:normal;color:var(--done)}
.ta-act{position:relative;justify-self:start;height:26px}
.ta-approve,.ta-approved{display:inline-grid;place-items:center;height:26px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:600}
.ta-approve{position:absolute;left:0;top:0;opacity:0;background:var(--btn);color:var(--btn-fg)}
.ta-approved{background:var(--done-bg);color:var(--done)}
.tour-scene.on .ta-agent{animation:tour-slide 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ta-idea{animation:tour-rise 8s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .ta-approve{animation:tour-press 8s ease infinite both}
.tour-scene.on .ta-approved{animation:tour-show-3 8s ease infinite both}
/* 5: a teammate joins; GitHub and Jira sync */
.tt{position:absolute;inset:0;display:grid;align-content:center;justify-items:center;gap:22px}
.tt-people{display:flex;align-items:center}
.tt-av{display:grid;place-items:center;width:40px;height:40px;margin-left:-8px;border-radius:50%;background:var(--accent);color:var(--btn-fg);font-weight:700;box-shadow:0 0 0 3px var(--panel-2)}
.tt-av:first-child{margin-left:0}.tt-av.a2{background:var(--done)}.tt-av.a3{background:var(--warn)}
.tt-added{margin-left:12px;font-size:13px;font-style:normal;font-weight:600;color:var(--done)}
.tt-sync{display:flex;align-items:center;gap:8px}
.tt-logo{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--panel);box-shadow:0 0 0 1px var(--line);color:var(--fg)}
.tt-logo svg{width:22px;height:22px}.tt-logo.tira svg{color:var(--brand)}
.tt-flow{width:52px;height:2px;background:repeating-linear-gradient(90deg,var(--accent) 0 6px,transparent 6px 12px)}
.tour-scene .tt-synced{margin:-10px 0 0;font-size:12px;font-weight:600;color:var(--done)}
.tour-scene.on .tt-av.a2{animation:tour-join 7s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .tt-av.a3{animation:tour-join-late 7s cubic-bezier(.2,.7,.2,1) infinite both}
.tour-scene.on .tt-added{animation:tour-show-4 7s ease infinite both}
.tour-scene.on .tt-flow{animation:tour-flow 1s linear infinite}
.tour-scene.on .tt-synced{animation:tour-show-5 7s ease infinite both}
@keyframes tour-grow-a{0%{opacity:0;transform:scale(.7)}7%,90%{opacity:1;transform:none}97%,100%{opacity:0}}
@keyframes tour-grow-b{0%,9%{opacity:0;transform:scale(.7)}16%,90%{opacity:1;transform:none}97%,100%{opacity:0}}
@keyframes tour-grow-c{0%,17%{opacity:0;transform:scale(.7)}24%,90%{opacity:1;transform:none}97%,100%{opacity:0}}
@keyframes tour-grow-d{0%,22%{opacity:0;transform:scale(.7)}29%,90%{opacity:1;transform:none}97%,100%{opacity:0}}
@keyframes tour-line-b{0%,5%{stroke-dashoffset:240;opacity:1}12%,90%{stroke-dashoffset:0;opacity:1}97%,100%{opacity:0}}
@keyframes tour-line-c{0%,13%{stroke-dashoffset:240;opacity:1}20%,90%{stroke-dashoffset:0;opacity:1}97%,100%{opacity:0}}
@keyframes tour-line-d{0%,18%{stroke-dashoffset:240;opacity:1}25%,90%{stroke-dashoffset:0;opacity:1}97%,100%{opacity:0}}
@keyframes tour-cross{0%,10%{left:4%;border-left-color:var(--dim)}22%,40%{left:calc(36% + 2px);border-left-color:var(--accent)}52%,88%{left:calc(68% + 4px);border-left-color:var(--done)}96%,100%{opacity:0}}
@keyframes tour-type{0%,55%{width:0}75%,100%{width:8ch}}
@keyframes tour-chip{0%,8%{transform:none;opacity:0}12%{opacity:1;transform:none}28%,88%{transform:translate(-40px,-70px);opacity:1}96%,100%{opacity:0;transform:translate(-40px,-70px)}}
@keyframes tour-show-1{0%,30%{opacity:0}38%,92%{opacity:1}100%{opacity:0}}
@keyframes tour-ring{0%,36%{stroke-dashoffset:28}52%,92%{stroke-dashoffset:0}100%{stroke-dashoffset:28}}
@keyframes tour-show-2{0%,54%{opacity:0}62%,92%{opacity:1}100%{opacity:0}}
@keyframes tour-bolt{0%,58%{opacity:0;transform:scale(.3)}66%{opacity:1;transform:scale(1.2)}70%,92%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-slide{0%,8%{opacity:0;transform:translateX(-16px)}18%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-rise{0%,30%{opacity:0;transform:translateY(16px)}42%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-press{0%,44%{opacity:0}48%,58%{opacity:1;transform:none}62%{opacity:1;transform:scale(.92)}66%,100%{opacity:0}}
@keyframes tour-show-3{0%,64%{opacity:0}70%,90%{opacity:1}100%{opacity:0}}
@keyframes tour-join{0%,10%{opacity:0;transform:scale(.4)}20%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-join-late{0%,16%{opacity:0;transform:scale(.4)}26%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-show-4{0%,26%{opacity:0;transform:translateX(-6px)}34%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tour-flow{to{background-position:12px 0}}
@keyframes tour-show-5{0%,50%{opacity:0}58%,90%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.tour *,.tour *::before{animation:none!important;transition:none!important}}
@media (max-width:560px){.tour-box{padding:16px 14px 14px;border-radius:18px}.tour-stage{height:190px}.tour-scene h2{font-size:19px}.tv-search{width:170px}.tour-skip{padding:8px 4px}}
/* the Get started checklist, in the sidebar */
.gs{margin:10px 0 4px;padding:12px 12px 10px;border-radius:12px;background:color-mix(in srgb,var(--accent) 7%,var(--panel));box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 22%,var(--line))}
.gs-head{display:flex;align-items:center;gap:8px;font-size:13px}.gs-head b{margin-right:auto}
.gs-count{font-size:12px;color:var(--mut)}
.gs-hide-form{margin:0}.gs-hide{width:22px;height:22px;border:0;border-radius:6px;background:none;color:var(--mut);font-size:16px;line-height:1;cursor:pointer}.gs-hide:hover{background:var(--hover);color:var(--fg)}
.gs-bar{height:4px;margin:8px 0 6px;border-radius:2px;background:var(--line)}.gs-bar i{display:block;height:100%;border-radius:2px;background:var(--done);transition:width .4s}
.gs-list{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.gs-list li{display:grid;grid-template-columns:16px 1fr;column-gap:8px;align-items:center;padding:4px 2px;font-size:13px}
.gs-list li>i{width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--line-2)}
.gs-list li.done>i{background:var(--done);box-shadow:none}
.gs-list li.done span{color:var(--mut);text-decoration:line-through;text-decoration-color:var(--line-2)}
.gs-list a{color:var(--accent-text)}.gs-list a:hover{text-decoration:underline}
.gs-list small{grid-column:2;font-size:11px;color:var(--dim)}
.gs .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:899px){nav.top .gs{flex-basis:100%;order:99;margin:6px 0 2px}.gs-list{grid-template-columns:repeat(auto-fill,minmax(200px,1fr));column-gap:12px}}
`;
