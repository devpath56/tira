// The way into `tira serve` for people who sign in: a landing page (one button: Continue with
// GitHub), straight to GitHub and back once tira's app has its secret (else GitHub's code to approve), then one step to connect the workspace to a GitHub repo and,
// if you use one, a Jira project; then the board.
//
// Apple's Human Interface Guidelines, as in debugAssist: a material card on a quiet background,
// the sign-in button in the label colour, blue for the one primary action, grouped lists for
// settings, and as few words as will do. Light and dark. CSS only, apart from signin.mjs on the
// code step (it waits for GitHub, and copies the code) and tabs.mjs (Jira's own tab).
// The routes are in integrations.ts; this file only writes the pages.
import { esc } from "../render/escape.ts";
import { BRAND_MARK, CSS, THEME_RADIOS } from "../render/html.ts";

export const GITHUB_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const JIRA_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M5.5 2.5v11M10.5 2.5v11"/></svg>`;
const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

// what tira does, as the landing's steps (illustration only: nothing about a workspace shows before sign-in)
const FLOW = ["Sign in with GitHub", "Connect a repo", "Add Jira (optional)", "Work the board"];

const LAND_CSS = `
body.land{min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:var(--bg)}
body.land::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
background:radial-gradient(60% 45% at 50% -10%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%)}
.land-wrap{position:relative;z-index:1;width:min(820px,calc(100vw - 32px));max-width:none;padding:32px 0;margin:0}
.land-card{display:grid;grid-template-columns:1fr 1fr;border-radius:20px;overflow:hidden;
background:color-mix(in srgb,var(--panel) 86%,transparent);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);
box-shadow:0 0 0 .5px color-mix(in srgb,var(--fg) 12%,transparent),0 24px 60px -24px rgba(0,0,0,.35)}
.land-card.one{grid-template-columns:1fr;max-width:560px;margin:0 auto}
.land-brand{display:grid;align-content:start;gap:20px;padding:36px 32px;background:color-mix(in srgb,var(--panel-2) 70%,transparent)}
.land-logo{display:flex;align-items:center;gap:8px;margin:0;font-weight:600;font-size:15px}.land-logo svg{width:22px;height:22px;color:var(--brand)}
.land-brand h2{margin:0;font-size:24px;font-weight:700;letter-spacing:-.015em;line-height:1.2}
.land-flow{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.land-flow li{display:flex;gap:12px;align-items:center;padding:9px 12px;border-radius:10px;font-size:14px;font-weight:500}
.land-flow .d{flex:none;width:8px;height:8px;border-radius:50%;background:var(--line-2)}
.land-form{display:grid;align-content:center;justify-items:center;gap:14px;padding:44px 32px;text-align:center}
.land-mark{width:60px;height:60px;display:grid;place-items:center;border-radius:14px;background:var(--panel-2)}.land-mark svg{width:32px;height:32px;color:var(--brand)}
.land h1{margin:2px 0 4px;font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1.2}
.land-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;height:44px;border:0;border-radius:12px;
background:var(--fg);color:var(--bg);font:600 15px var(--sans);cursor:pointer;text-decoration:none;transition:opacity .15s,transform .15s}
.land-btn svg{width:18px;height:18px}.land-btn:hover{opacity:.88}.land-btn:active{transform:scale(.98)}.land-btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.land-btn.blue{background:var(--btn);color:var(--btn-fg)}
.land-form form{width:100%;margin:0;display:grid;gap:12px}
.land-foot{margin:0;font-size:13px;color:var(--mut)}.land-foot a,.land-link{color:var(--accent-text)}.land-foot a:hover,.land-link:hover{text-decoration:underline}
.land-flash{width:100%;margin:0;padding:10px 14px;border-radius:10px;font-size:13px;text-align:left}
.land-flash.no{background:var(--block-bg)}.land-flash.ok{background:var(--done-bg)}
.land-code{display:flex;align-items:center;justify-content:center;gap:10px;width:100%}
.land-code code{font:600 30px var(--mono);letter-spacing:.12em;padding:10px 16px;border-radius:12px;background:var(--panel-2)}
.land-copy{font:500 13px var(--sans);color:var(--accent-text);background:var(--panel-2);border:0;border-radius:8px;padding:6px 12px;cursor:pointer}
.land-status{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;color:var(--mut)}
.land-status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--warn);flex:none}
.land-quiet{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--accent-text);cursor:pointer}.land-quiet:hover{text-decoration:underline}
.land-field{display:grid;gap:6px;font-size:13px;color:var(--mut);text-align:left;width:100%}
.land-field input,.land-field select{font:15px var(--sans);color:var(--fg);background:var(--panel-2);border:0;border-radius:10px;padding:10px 12px;width:100%}
.land-field input:focus,.land-field select:focus{outline:2px solid var(--accent);outline-offset:0}
.land-how{width:100%;text-align:left;font-size:13px;color:var(--mut)}.land-how summary{cursor:pointer;color:var(--accent-text)}.land-how ol{margin:8px 0 0;padding-left:18px}.land-how li{margin:3px 0}.land-how code{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;color:var(--fg)}
.land-steps{display:flex;justify-content:center;gap:6px;list-style:none;margin:0;padding:18px 24px 0}
.land-steps li{width:28px;height:4px;border-radius:2px;background:var(--line)}.land-steps .done,.land-steps .now{background:var(--accent)}
.land-body{display:grid;gap:18px;padding:22px 24px 26px}
.land-body>header{text-align:center}.land-body>header h1{margin:0}.land-body>header p{margin:4px 0 0;color:var(--mut);font-size:13px}
.land-body .grp{margin:0}.land-body .grp-list{background:var(--panel-2);box-shadow:none}.land-body .grp-row select,.land-body .grp-row input{background:var(--panel)}
.land-who{display:flex;justify-content:center;align-items:center;gap:10px;font-size:13px;color:var(--mut)}.land-who form{display:inline}
@media (max-width:720px){.land-card{grid-template-columns:1fr}.land-brand{padding:22px 22px 4px;gap:8px;background:none}
.land-brand h2{font-size:19px}.land-flow{display:none}.land-form{padding:24px 22px 32px}.land-body{padding:18px}}
@media (prefers-reduced-transparency:reduce){.land-card{background:var(--panel);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-reduced-motion:no-preference){.land-card{animation:land-in .45s cubic-bezier(.2,.7,.2,1) both}
.land-flow li{animation:land-row 8s calc(var(--i) * 1.4s + .4s) infinite both}.land-flow li .d{animation:land-dot 8s calc(var(--i) * 1.4s + .4s) infinite both}
.land-status::before{animation:land-pulse 1.6s ease-in-out infinite}}
@media (prefers-reduced-motion:reduce){.land-flow .d{background:var(--done)}}
@keyframes land-in{from{opacity:0;transform:translateY(8px) scale(.99)}}
@keyframes land-row{0%{background:transparent}4%,14%{background:color-mix(in srgb,var(--accent) 12%,transparent)}20%,100%{background:transparent}}
@keyframes land-dot{0%{background:var(--line-2)}4%,14%{background:var(--accent)}20%,100%{background:var(--done)}}
@keyframes land-pulse{50%{opacity:.35}}
`;

type Flash = { ok: boolean; text: string } | undefined;
const flashHtml = (f: Flash) => (f ? `<p class="land-flash ${f.ok ? "ok" : "no"}" role="status" data-flash>${esc(f.text)}</p>` : "");
const hiddenToken = (token: string) => `<input type="hidden" name="token" value="${esc(token)}">`;

// A page on the way in: no theme switch (that's Profile settings'); it follows the computer, or the
// choice this browser made there (theme.mjs).
function page(title: string, card: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}${LAND_CSS}</style></head><body class="land">${THEME_RADIOS}<main class="land-wrap">${card}</main><script type="module" src="/theme.mjs"></script>${script}</body></html>\n`;
}

// the left side of the landing and of the code step: what tira does, in four words each
function brandSide(): string {
  const flow = FLOW.map((b, i) => `<li style="--i:${i}"><span class="d"></span>${esc(b)}</li>`).join("");
  return `<section class="land-brand" aria-label="What tira does"><p class="land-logo">${BRAND_MARK}<span>tira</span></p>`
    + `<h2>Plan the work. Prove it's done.</h2><ol class="land-flow">${flow}</ol></section>`;
}

export interface LandingOpts {
  token: string;
  githubReady: boolean; // tira's GitHub app is set up on this machine
  port: string;
  admin?: { login: string; contact?: { name?: string; email?: string } }; // none yet: the first to sign in becomes it
  flash?: Flash;
}

// who a newcomer asks for access, with a link to write to them
function newcomer(admin: LandingOpts["admin"]): string {
  if (!admin) return `The first person to sign in becomes the admin.`;
  const { name, email } = admin.contact ?? {};
  const mail = email ? `<a href="mailto:${esc(email)}" data-admin-email>${esc(email)}</a>` : "";
  const who = name && email ? `${esc(name)} (${mail})` : name ? esc(name) : email ? mail : `@${esc(admin.login)}`;
  return `New here? Ask ${who} for access.`;
}

// The landing: sign in with GitHub, or, the first time on this machine, set up tira's GitHub app.
export function landingPage(o: LandingOpts): string {
  const form = o.githubReady
    ? `<div class="land-mark">${BRAND_MARK}</div><h1>Sign in to tira</h1>${flashHtml(o.flash)}`
      + `<form method="post" action="/signin/start">${hiddenToken(o.token)}<button class="land-btn" type="submit" data-signin-start>${GITHUB_MARK}<span>Continue with GitHub</span></button></form>`
      + `<p class="land-foot" data-newcomer>${newcomer(o.admin)}</p>`
    : `<div class="land-mark">${BRAND_MARK}</div><h1>Set up sign-in</h1>${flashHtml(o.flash)}`
      + `<form method="post" action="/integrations/setup" data-setup-github>${hiddenToken(o.token)}<input type="hidden" name="back" value="/welcome">`
      + `<label class="land-field"><span>GitHub Client ID</span><input type="text" name="github_client_id" autocomplete="off" spellcheck="false" required></label>`
      + `<label class="land-field"><span>GitHub Secret (optional: sign in in one click)</span><input type="password" name="github_secret" autocomplete="off"></label>`
      + `<button class="land-btn blue" type="submit">Continue</button></form>`
      + `<details class="land-how"><summary>Where do I find it?</summary><ol><li>GitHub → Settings → Developer settings → OAuth Apps → New.</li><li>Homepage <code>http://localhost:${esc(o.port)}</code>, callback <code>http://localhost:${esc(o.port)}/</code>.</li><li>Register, tick Enable Device Flow, copy the Client ID.</li><li>For sign-in in one click: Generate a new client secret, and paste it too.</li></ol></details>`;
  return page("Sign in to tira", `<div class="land-card" data-landing>${brandSide()}<section class="land-form">${form}</section></div>`);
}

export interface CodeOpts { token: string; id: string; userCode: string; verifyAt: string; interval: number; note?: string }

// GitHub's code to approve; signin.mjs waits for the approval and goes on by itself.
export function codePage(o: CodeOpts): string {
  const form = `<div class="land-mark">${GITHUB_MARK}</div><h1>Enter this code on GitHub</h1>`
    + (o.note ? `<p class="land-flash no" role="status">${esc(o.note)}</p>` : "")
    + `<div class="land-code"><code data-user-code>${esc(o.userCode)}</code><button type="button" class="land-copy" data-copy="${esc(o.userCode)}" hidden>Copy</button></div>`
    + `<a class="land-btn" href="${esc(o.verifyAt)}" target="_blank" rel="noopener noreferrer" data-open-github>${GITHUB_MARK}<span>Open GitHub</span></a>`
    + `<p class="land-status" role="status" data-signin-status>Waiting for approval…</p>`
    + `<form method="post" action="/signin/poll" data-signin-wait data-interval="${o.interval}">${hiddenToken(o.token)}<input type="hidden" name="id" value="${esc(o.id)}">`
    + `<button class="land-quiet" type="submit">I've approved it</button></form>`
    + `<p class="land-foot"><a href="/welcome">Cancel</a></p>`;
  return page("Sign in to tira", `<div class="land-card" data-signin>${brandSide()}<section class="land-form">${form}</section></div>`, `<script type="module" src="/signin.mjs"></script>`);
}

export interface ConnectOpts {
  token: string;
  stream: string;
  login: string;
  name?: string;
  repo?: string; // linked now
  repos: string[]; // the person's, from GitHub
  repoProblem?: string;
  jira: // where Jira stands for this person
    | { state: "unset" } // tira's Atlassian app isn't set up
    | { state: "elsewhere"; localhost: string } // open tira at localhost to connect
    | { state: "disconnected" }
    | { state: "connected"; site?: string; sites: { id: string; name: string; url: string }[]; cloudId?: string; projects: { key: string; name: string }[]; problem?: string };
  jiraProject?: string; // linked now
  port: string;
  flash?: Flash;
}

// After sign-in: link this workspace to a repo (needed) and a Jira project (optional), then the board.
export function connectPage(o: ConnectOpts): string {
  const t = hiddenToken(o.token);
  const steps = `<ol class="land-steps" aria-label="Step 2 of 3"><li class="done"></li><li class="now" aria-current="step"></li><li></li></ol>`;
  const row = (k: string, v: string) => `<div class="grp-row"><span class="grp-k">${k}</span>${v}</div>`;

  // GitHub: pick one of your repos (or type one, if GitHub didn't list them)
  const options = [...new Set([...(o.repo ? [o.repo] : []), ...o.repos])];
  const repoField = options.length > 0
    ? `<select name="repo" form="connect" aria-label="Repository" data-repo-pick>${options.map((r) => `<option value="${esc(r)}"${r === o.repo ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>`
    : `<input type="text" name="repo" form="connect" aria-label="Repository" placeholder="owner/name" autocomplete="off" spellcheck="false" required data-repo-pick>`;
  const github = `<section class="grp" data-connect-github><h2 class="grp-h">GitHub</h2><div class="grp-list">`
    + (o.repoProblem ? `<div class="grp-row"><span class="grp-k no">${esc(o.repoProblem)}</span></div>` : "")
    + `<div class="grp-row">${GITHUB_MARK.replace("<svg ", `<svg width="18" height="18" `)}<span class="grp-k">Repository</span>${repoField}</div></div></section>`;

  // Jira: optional; set up, connect, then pick a project (or none)
  let jira = "";
  let jiraFoot = "";
  const j = o.jira;
  if (j.state === "unset") {
    jira = `<details><summary class="grp-row"><span class="grp-k">Set up Jira sign-in</span></summary><form method="post" action="/integrations/setup" data-setup-atlassian>${t}<input type="hidden" name="back" value="/connect">`
      + `<label class="grp-row"><span class="grp-k">Client ID</span><input type="text" name="atlassian_client_id" autocomplete="off" spellcheck="false" required></label>`
      + `<label class="grp-row"><span class="grp-k">Secret</span><input type="password" name="atlassian_secret" value="" autocomplete="off" required></label>`
      + `<div class="grp-row"><span class="grp-k"></span><button class="act primary" type="submit">Save</button></div></form></details>`;
    jiraFoot = `<details class="land-how"><summary>Where do I find these?</summary><ol><li>developer.atlassian.com → Create → OAuth 2.0 integration.</li><li>Jira scopes <code>read:jira-work</code>, <code>write:jira-work</code>, <code>read:jira-user</code>.</li><li>Callback <code>http://localhost:${esc(o.port)}/integrations/jira/callback</code>.</li></ol></details>`;
  } else if (j.state === "elsewhere") {
    jira = row("Jira", `<a class="land-link" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`);
  } else if (j.state === "disconnected") {
    jira = row(`${JIRA_MARK.replace("<svg ", `<svg width="18" height="18" `)} Jira`, `<a class="act" href="${esc("/integrations/jira/connect?back=/connect&tab=1")}" target="_blank" rel="noopener" data-connect-jira>Connect</a>`);
  } else {
    const siteRow = j.sites.length > 1
      ? `<div class="grp-row"><span class="grp-k">Site</span><select name="site" form="jira-site" aria-label="Jira site">${j.sites.map((s) => `<option value="${esc(s.id)}"${s.id === j.cloudId ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select><button class="act" type="submit" form="jira-site">Use</button></div>`
      : row("Site", `<span class="grp-v">${esc(j.site ?? "")}</span>`);
    const pick = !j.cloudId ? ""
      : row("Project", `<select name="jira_project" form="connect" aria-label="Jira project" data-jira-pick><option value="">None</option>${j.projects.map((p) => `<option value="${esc(p.key)}"${p.key === o.jiraProject ? " selected" : ""}>${esc(p.name)} (${esc(p.key)})</option>`).join("")}</select>`);
    jira = siteRow + (j.problem ? `<div class="grp-row"><span class="grp-k no">${esc(j.problem)}</span></div>` : "") + pick;
  }
  const jiraSect = `<section class="grp" data-connect-jira-sect><h2 class="grp-h">Jira · optional</h2><div class="grp-list">${jira}</div>${jiraFoot}</section>`;

  const card = `<div class="land-card one" data-connect>${steps}<div class="land-body"><header><h1>Connect your project</h1><p>${esc(o.stream)}</p></header>`
    + flashHtml(o.flash) + github + jiraSect
    + `<form method="post" action="/connect" id="connect">${t}<button class="land-btn blue" type="submit" data-open-board>Open Board</button></form>`
    + `<form method="post" action="/integrations/jira/site" id="jira-site">${t}<input type="hidden" name="back" value="/connect"></form>`
    + `<div class="land-who"><span>${esc(o.login)}</span><form method="post" action="/signout">${t}<button class="land-quiet" type="submit">Sign out</button></form></div>`
    + `</div></div>`;
  return page("Connect · tira", card, TABS);
}

const TABS = `<script type="module" src="/tabs.mjs"></script>`;

// The tab Connect Jira opened, back from Atlassian: says how it went; tabs.mjs tells tira's other
// tabs (they reload) and closes this one if the browser lets it.
export function jiraTabPage(ok: boolean, text: string, back: string): string {
  const card = `<div class="land-card one"${ok ? " data-jira-done" : ""}><div class="land-body"><header><h1>${ok ? "Jira connected" : "Jira wasn't connected"}</h1><p>${esc(text)}</p></header>`
    + `<p class="land-foot" style="text-align:center">${ok ? "You can close this tab. " : ""}<a href="${esc(back)}">Back to tira</a></p></div></div>`;
  return page("Jira · tira", card, TABS);
}
