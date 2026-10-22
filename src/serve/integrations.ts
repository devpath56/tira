// The way in to `tira serve` and its Integrations page. Someone who isn't signed in lands on
// /welcome (Continue with GitHub), approves GitHub's code, connects the workspace to a repo and,
// if they use one, a Jira project (/connect), and then sees the board (the pages: welcome.ts).
// /integrations changes those links later: sign in with GitHub, connect Jira, and pick what this
// workspace links to, with buttons and pickers, not commands (the command each choice amounts to
// is one click away, under "Show the command").
//
// - Sign in with GitHub (GitHub's device flow, src/auth/github.ts): tira shows a code, the
//   person approves it on github.com, and from then on the page acts as their GitHub login.
//   Their GitHub token lists their repos and reads pull requests when they sync.
// - Connect Jira (Atlassian's sign-in, src/auth/atlassian.ts): Atlassian sends the person back
//   here with a code; tira trades it for tokens and lists their Jira sites and projects.
// - Setup: the keys of tira's own GitHub and Atlassian apps, typed in once; the Atlassian secret
//   is a hidden field, kept in the private store, never shown again.
// - Link: a repo and a Jira project, picked from lists; written as the next version of the
//   workspace's link (src/tables/links.ts), as the person signed in.
// - Sync: the same sync as `tira sync`, as the person signed in.
// - Access: the first person to sign in becomes this tira's admin; after that only the admin and
//   the people they add (by GitHub login, on Integrations) get in. Anyone else is told who to ask,
//   with the contact the admin gave.
//
// Every token, key and secret lives only in the private store (src/sync/credentials.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { FoldResult } from "../fold/fold.ts";
import { workspaceOf, type WorkspaceLink } from "../fold/workspace.ts";
import { JIRA_PROJECT, REPO, WORKSPACE, WORKSPACE_ID } from "../tables/links.ts";
import { reportLines, sync } from "../sync/sync.ts";
import { GhCli, type GitHubClient } from "../sync/github.ts";
import { JiraCloud, type JiraClient } from "../sync/jira.ts";
import { access, appKeys, atlassianAuth, dropSession, forget, githubAuth, isAdmin, jiraLogin, mayEnter, saveAccess, saveAppKeys, saveAtlassianAuth, saveGithubAuth, saveSession, type Access, type AtlassianAuth, type JiraLogin } from "../sync/credentials.ts";
import { GitHubDevice, type GitHubAuthApi } from "../auth/github.ts";
import { AtlassianOAuth, type AtlassianAuthApi } from "../auth/atlassian.ts";
import type { Dispatcher } from "../write/dispatcher.ts";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { esc } from "../render/escape.ts";
import { BRAND, CSS, THEME_RADIOS, THEME_SWITCH } from "../render/html.ts";
import { quote } from "./command.ts";
import { codePage, connectPage, jiraTabPage, landingPage, type ConnectOpts } from "./welcome.ts";

export const SESSION_COOKIE = "tira_session";

type Env = Record<string, string | undefined>;
type Flash = { ok: boolean; text: string };

export interface Outside {
  jira?: (site: string, login: JiraLogin) => JiraClient; // an API-token login (tira connect-jira)
  github?: GitHubClient; // pull requests, instead of the person's own token or gh
  githubAuth?: GitHubAuthApi;
  atlassian?: AtlassianAuthApi;
  env?: Env;
}

export interface IntegrationsContext {
  store: EventStore;
  registry: Registry;
  stream: string;
  token: string; // the page's own, for every write
  fallbackActor?: string; // who acts when tira has no GitHub sign-in set up (none: everyone signs in)
  dispatcher: Dispatcher;
  outside: Outside | undefined;
  now: () => Promise<{ r: FoldResult }>;
  send: (res: ServerResponse, status: number, type: string, body: string, extra?: Record<string, string>) => void;
  formOf: (req: IncomingMessage, res: ServerResponse, host: string) => Promise<URLSearchParams | undefined>;
  flash: (f: Flash) => string; // keeps it once, returns its key
  takeFlash: (key: string) => Flash | undefined;
}

const html = "text/html; charset=utf-8";

export function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

// Who is signed in on this request, and who the page writes as: the GitHub login once GitHub
// sign-in is set up (no one, until they sign in), else the name `tira serve` was started with
// (none, when it was started without one: then everyone signs in).
export function whoIs(req: IncomingMessage, fallback: string | undefined, env: Env, sessionLogin: (id: string) => string | undefined): { login?: string; actor?: string; signInOn: boolean } {
  const id = cookieOf(req, SESSION_COOKIE);
  const login = id ? sessionLogin(id) : undefined;
  const signInOn = appKeys(env).github?.clientId !== undefined;
  if (login && mayEnter(access(env), login)) return { login, actor: login, signInOn }; // removed since: no one
  return signInOn || fallback === undefined ? { signInOn } : { actor: fallback, signInOn };
}

// what someone who can't get in is told: who to ask
export function askAdmin(a: Access): string {
  const { name, email } = a.contact ?? {};
  const who = name && email ? `${name} (${email})` : name ?? email ?? (a.admin ? `@${a.admin} on GitHub` : "");
  return who ? `Ask the admin, ${who}, to add your GitHub account.` : "Ask this tira's admin to add your GitHub account.";
}
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const NAME = /^[^\u0000-\u001f\u007f<>]{1,60}$/;

// where a form may send its person back to (never an address it names itself)
const BACKS = new Set(["/welcome", "/connect", "/integrations"]);
export const backOf = (v: string | null | undefined, fallback = "/integrations"): string => (v && BACKS.has(v) ? v : fallback);

export function integrationRoutes(c: IntegrationsContext, who: (req: IncomingMessage) => { login?: string; actor?: string; signInOn: boolean }) {
  const env = c.outside?.env ?? process.env;
  const gh = c.outside?.githubAuth ?? new GitHubDevice();
  const at = c.outside?.atlassian ?? new AtlassianOAuth();
  const pendingSignIns = new Map<string, { deviceCode: string; userCode: string; verifyAt: string; interval: number; until: number }>();
  const pendingJira = new Map<string, { login: string; until: number; back: string; tab: boolean }>();
  const back = (res: ServerResponse, to: string, f?: Flash) => c.send(res, 303, "text/plain; charset=utf-8", "", { Location: f ? `${to}?r=${c.flash(f)}` : to });
  const redirectUri = (host: string) => `http://${host}/integrations/jira/callback`;

  // the person's Jira, as their Atlassian sign-in or, failing that, an API-token login for the site
  const jiraOf = (login: string | undefined, ws: WorkspaceLink | undefined): JiraClient | undefined => {
    const keys = appKeys(env).atlassian;
    const a = login ? atlassianAuth(login, env) : undefined;
    if (keys && a?.cloudId && login) return at.jira(keys, a, (next) => saveAtlassianAuth(login, next, env));
    const site = ws?.jira_site;
    const l = site ? jiraLogin(site, env) : undefined;
    return site && l ? c.outside?.jira?.(site, l) ?? new JiraCloud(site, l.email, l.token) : undefined;
  };
  const githubOf = (login: string | undefined): GitHubClient => {
    if (c.outside?.github) return c.outside.github;
    const t = login ? githubAuth(login, env)?.token : undefined;
    return t && gh instanceof GitHubDevice ? gh.pullsAs(t) : new GhCli();
  };

  // the step after signing in: connect a repo while the workspace has none, else the board
  const nextStep = async (login: string | undefined): Promise<string> => (login && !workspaceOf((await c.now()).r, c.stream)?.repo ? "/connect" : "/");
  const portOf = (host: string) => host.replace(/^[^:]*:?/, "") || "4747";

  // ---------- the landing ----------
  const welcome = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (me.actor) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: await nextStep(me.login) });
    const flash = c.takeFlash(url.searchParams.get("r") ?? "");
    const a = access(env);
    c.send(res, 200, html, landingPage({ token: c.token, githubReady: !!appKeys(env).github, port: portOf(host), ...(a.admin ? { admin: { login: a.admin, ...(a.contact ? { contact: a.contact } : {}) } } : {}), ...(flash ? { flash } : {}) }));
  };

  // ---------- sign in with GitHub ----------
  const signinPage = (res: ServerResponse, id: string, p: { userCode: string; verifyAt: string; interval: number }, note?: string) =>
    c.send(res, 200, html, codePage({ token: c.token, id, userCode: p.userCode, verifyAt: p.verifyAt, interval: p.interval, ...(note ? { note } : {}) }));

  const signinStart = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const clientId = appKeys(env).github?.clientId;
    if (!clientId) return back(res, "/welcome", { ok: false, text: "GitHub sign-in isn't set up yet: add tira's GitHub app first." });
    try {
      const s = await gh.start(clientId);
      const id = randomBytes(16).toString("hex");
      pendingSignIns.set(id, { deviceCode: s.deviceCode, userCode: s.userCode, verifyAt: s.verifyAt, interval: s.interval, until: Date.now() + s.expiresIn * 1000 });
      signinPage(res, id, s);
    } catch (err) {
      back(res, "/welcome", { ok: false, text: `GitHub sign-in didn't start (${(err as Error).message}).` });
    }
  };

  const signinPoll = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const fragment = form.get("fragment") === "1";
    const id = form.get("id") ?? "";
    const p = pendingSignIns.get(id);
    const clientId = appKeys(env).github?.clientId;
    const fail = (text: string) => (fragment ? c.send(res, 200, html, `<div data-error>${esc(text)}</div>`) : back(res, "/welcome", { ok: false, text }));
    if (!p || !clientId || p.until < Date.now()) {
      pendingSignIns.delete(id);
      return fail("That sign-in expired: start again.");
    }
    try {
      const got = await gh.poll(clientId, p.deviceCode);
      if ("failed" in got) {
        pendingSignIns.delete(id);
        return fail(`GitHub sign-in stopped: ${got.failed}.`);
      }
      if ("wait" in got) {
        if (got.wait > 0) p.interval = got.wait;
        return fragment ? c.send(res, 202, html, `<div data-waiting data-interval="${p.interval}"></div>`) : signinPage(res, id, p, "Not approved on GitHub yet.");
      }
      const me = await gh.user(got.token);
      pendingSignIns.delete(id);
      // only the admin and the people they added get in (the first person in becomes the admin);
      // anyone else is told who to ask, and tira keeps nothing of theirs
      const a = access(env);
      if (!mayEnter(a, me.login)) {
        const key = c.flash({ ok: false, text: `${me.login} doesn't have access to this tira yet. ${askAdmin(a)}` });
        return fragment ? c.send(res, 200, html, `<div data-go="/welcome?r=${key}"></div>`) : back(res, "/welcome", c.takeFlash(key));
      }
      const first = a.admin === undefined;
      if (first) saveAccess((x) => ({ ...x, admin: me.login }), env);
      saveGithubAuth(me.login, { token: got.token, ...(me.name ? { name: me.name } : {}) }, env);
      const session = randomBytes(32).toString("hex");
      saveSession(session, me.login, env);
      const cookie = `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
      const key = c.flash({ ok: true, text: first
        ? `Signed in as ${me.login}: you're this tira's admin. Add the people who may sign in on Integrations.`
        : `Signed in as ${me.login}. tira records your changes as ${me.login}.` });
      const go = `${await nextStep(me.login)}?r=${key}`;
      if (fragment) return c.send(res, 200, html, `<div data-go="${esc(go)}"></div>`, { "Set-Cookie": cookie });
      c.send(res, 303, "text/plain; charset=utf-8", "", { Location: go, "Set-Cookie": cookie });
    } catch (err) {
      fail(`GitHub sign-in stopped (${(err as Error).message}).`);
    }
  };

  const signout = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const id = cookieOf(req, SESSION_COOKIE);
    if (id) dropSession(id, env);
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/", "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  };

  // ---------- the page ----------
  const page = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/welcome${url.search}` }); // a result goes along
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const keys = appKeys(env);
    const flash = c.takeFlash(url.searchParams.get("r") ?? "");
    const hidden = `<input type="hidden" name="token" value="${esc(c.token)}">`;
    const ghAuth = me.login ? githubAuth(me.login, env) : undefined;
    const aAuth = me.login ? atlassianAuth(me.login, env) : undefined;
    // Apple's grouped lists (as in Settings): a short header, rows of label and control, a
    // footnote at most. Each choice's command is one click away, under "Show the command".
    const cmd = (text: string) => `<details class="int-cmd"><summary>Show the command</summary><code>${esc(text)}</code></details>`;
    const row = (k: string, v: string) => `<div class="grp-row"><span class="grp-k">${k}</span>${v}</div>`;
    const group = (id: string, title: string, rows: string, foot = "") => `<section class="grp" data-int="${id}"><h2 class="grp-h">${title}</h2><div class="grp-list">${rows}</div>${foot ? `<div class="grp-foot">${foot}</div>` : ""}</section>`;
    const problem = (text: string) => (text ? `<div class="grp-row"><span class="grp-k no">${esc(text)}</span></div>` : "");

    // account (someone who isn't signed in is sent to the landing, unless tira serve acts as its own name)
    const account = me.login
      ? group("account", "Account", `<form method="post" action="/signout" class="grp-row">${hidden}<span class="grp-k"><b>${esc(me.login)}</b>${ghAuth?.name ? ` <span class="grp-sub">${esc(ghAuth.name)}</span>` : ""}</span><button class="act" type="submit">Sign out</button></form>`)
      : group("account", "Account", row("Working as", `<span class="grp-v">${esc(me.actor)}</span>`), "GitHub sign-in isn't set up. Add it under Setup.");

    // people: who may sign in (the admin changes it; everyone else sees who to ask)
    const acc = access(env);
    let people: string;
    if (!me.login) people = group("people", "People", row("Admin", `<span class="grp-v">The first to sign in</span>`));
    else if (!isAdmin(acc, me.login)) people = group("people", "People", row("Admin", `<span class="grp-v">${esc(acc.contact?.name ?? acc.admin ?? "")}</span>`), "Ask the admin to add or remove people.");
    else {
      const rows = (acc.members ?? []).map((m) => `<form method="post" action="/integrations/people" class="grp-row">${hidden}<input type="hidden" name="do" value="remove"><input type="hidden" name="login" value="${esc(m)}"><span class="grp-k">${esc(m)}</span><button class="how" type="submit">Remove</button></form>`).join("");
      people = `<section class="grp" data-int="people"><h2 class="grp-h">People</h2><div class="grp-list" data-people>`
        + `<div class="grp-row"><span class="grp-k">${esc(acc.admin ?? me.login)}</span><span class="pill">Admin</span></div>${rows}`
        + `<form method="post" action="/integrations/people" class="grp-row" data-add-person>${hidden}<input type="hidden" name="do" value="add"><input type="text" name="login" aria-label="GitHub username" autocomplete="off" spellcheck="false" placeholder="GitHub username" required><button class="act primary" type="submit">Add</button></form>`
        + `</div><div class="grp-foot">Only these people can sign in.</div></section>`
        + `<section class="grp" data-int="contact"><h2 class="grp-h">Your contact</h2><form method="post" action="/integrations/people" class="grp-list" data-admin-contact>${hidden}<input type="hidden" name="do" value="contact">`
        + `<label class="grp-row"><span class="grp-k">Name</span><input type="text" name="name" value="${esc(acc.contact?.name ?? ghAuth?.name ?? "")}" autocomplete="off"></label>`
        + `<label class="grp-row"><span class="grp-k">Email</span><input type="email" name="email" value="${esc(acc.contact?.email ?? "")}" autocomplete="off"></label>`
        + `<div class="grp-row"><span class="grp-k"></span><button class="act" type="submit">Save</button></div></form><div class="grp-foot">Shown to people who can't sign in yet.</div></section>`;
    }

    // GitHub: pick a repo
    let repos: string[] = [];
    let repoProblem = "";
    if (ghAuth) {
      try {
        repos = await gh.repos(ghAuth.token);
      } catch (err) {
        repoProblem = `GitHub didn't list your repos (${(err as Error).message}).`;
      }
    }
    const repoOptions = [...new Set([...(ws?.repo ? [ws.repo] : []), ...repos])];
    const github = group("github", "GitHub",
      problem(repoProblem)
        + (repoOptions.length === 0 ? row("Repository", `<span class="grp-v">Sign in with GitHub to pick one</span>`)
          : `<form method="post" action="/integrations/link" class="grp-row" data-link-repo-form>${hidden}<input type="hidden" name="what" value="repo"><span class="grp-k">Repository</span><select name="repo" aria-label="Repository">${repoOptions.map((x) => `<option value="${esc(x)}"${x === ws?.repo ? " selected" : ""}>${esc(x)}</option>`).join("")}</select><button class="act primary" type="submit">${ws?.repo ? "Change" : "Link"}</button>${ws?.repo ? `<button class="how" type="submit" name="repo" value="">Unlink</button>` : ""}</form>`),
      repoOptions.length > 0 ? cmd(`tira link --repo ${quote(ws?.repo ?? repoOptions[0] ?? "OWNER/NAME")}`) : "");

    // Jira: connect, pick a site, pick a project
    let jira: string;
    const onLocalhost = /^localhost(:\d+)?$/.test(host);
    if (!keys.atlassian) jira = group("jira", "Jira", row("Jira", `<span class="grp-v">Not set up</span>`), "Add tira's Atlassian app under Setup.");
    else if (!me.login) jira = group("jira", "Jira", row("Jira", `<span class="grp-v">Sign in with GitHub first</span>`));
    else if (!aAuth) jira = group("jira", "Jira", onLocalhost
      ? row("Jira", `<a class="act primary" href="${esc("/integrations/jira/connect?tab=1")}" target="_blank" rel="noopener" data-connect-jira>Connect Jira</a>`)
      : row("Jira", `<a class="how" href="http://localhost${esc(host.replace(/^[^:]*/, ""))}/integrations">Open tira at localhost to connect</a>`));
    else {
      const sites = aAuth.sites ?? [];
      let projects: { key: string; name: string }[] = [];
      let projectProblem = "";
      if (aAuth.cloudId) {
        try {
          projects = (await jiraOf(me.login, ws)?.projects()) ?? [];
        } catch (err) {
          projectProblem = `Jira didn't list its projects (${(err as Error).message}).`;
        }
      }
      jira = group("jira", "Jira",
        (sites.length > 1
          ? `<form method="post" action="/integrations/jira/site" class="grp-row">${hidden}<span class="grp-k">Site</span><select name="site" aria-label="Jira site">${sites.map((x) => `<option value="${esc(x.id)}"${x.id === aAuth.cloudId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select><button class="act" type="submit">Use</button></form>`
          : row("Site", `<span class="grp-v">${esc(aAuth.site ?? "")}</span>`))
        + problem(projectProblem)
        + (!aAuth.cloudId ? ""
          : `<form method="post" action="/integrations/link" class="grp-row" data-link-jira-form>${hidden}<input type="hidden" name="what" value="jira"><span class="grp-k">Project</span><select name="jira_project" aria-label="Jira project">${projects.map((x) => `<option value="${esc(x.key)}"${x.key === ws?.jira_project ? " selected" : ""}>${esc(x.name)} (${esc(x.key)})</option>`).join("")}</select><button class="act primary" type="submit">${ws?.jira_project ? "Change" : "Link"}</button>${ws?.jira_project ? `<button class="how" type="submit" name="jira_project" value="">Unlink</button>` : ""}</form>`)
        + `<form method="post" action="/integrations/jira/disconnect" class="grp-row">${hidden}<span class="grp-k"></span><button class="how" type="submit">Disconnect Jira</button></form>`,
        aAuth.cloudId ? cmd(`tira link --jira-site ${quote(aAuth.site ?? "")} --jira ${quote(ws?.jira_project ?? projects[0]?.key ?? "KEY")}`) : "");
    }

    // sync
    const canSync = !!me.actor && !!ws && (!!ws.repo || !!ws.jira_project);
    const syncCard = group("sync", "Sync", canSync
      ? `<form method="post" action="/sync" class="grp-row">${hidden}<input type="hidden" name="back" value="/integrations"><span class="grp-k">GitHub and Jira</span><button class="act primary" type="submit" data-sync>Sync now</button></form>`
      : row("Sync", `<span class="grp-v">Link a repo or a Jira project first</span>`), canSync ? cmd("tira sync") : "");

    // setup: tira's own apps (open while one is missing)
    const port = portOf(host);
    const setup = `<details class="grp" data-int="setup"${keys.github && keys.atlassian ? "" : " open"}><summary class="grp-h">Setup</summary>`
      + `<form method="post" action="/integrations/setup" class="grp-list">${hidden}`
      + `<label class="grp-row"><span class="grp-k">GitHub Client ID</span><input type="text" name="github_client_id" value="${esc(keys.github?.clientId ?? "")}" autocomplete="off" spellcheck="false"></label>`
      + `<label class="grp-row"><span class="grp-k">Atlassian Client ID</span><input type="text" name="atlassian_client_id" value="${esc(keys.atlassian?.clientId ?? "")}" autocomplete="off" spellcheck="false"></label>`
      + `<label class="grp-row"><span class="grp-k">Atlassian Secret</span><input type="password" name="atlassian_secret" value="" autocomplete="off"${keys.atlassian ? ` placeholder="Saved"` : ""}></label>`
      + `<div class="grp-row"><span class="grp-k"></span><button class="act primary" type="submit">Save</button></div></form>`
      + `<div class="grp-foot"><details><summary>How to make these apps</summary><ol class="int-steps"><li>GitHub: Settings → Developer settings → OAuth Apps → New. Homepage <code>http://localhost:${esc(port)}</code>, callback <code>http://localhost:${esc(port)}/</code>. Tick Enable Device Flow.</li><li>Atlassian: Developer console → Create → OAuth 2.0. Jira scopes <code>read:jira-work</code>, <code>write:jira-work</code>, <code>read:jira-user</code>. Callback <code>http://localhost:${esc(port)}/integrations/jira/callback</code>.</li></ol></details>Kept privately on this machine. The secret is never shown again.</div></details>`;

    const body = `<header class="int-head"><h1>Integrations</h1><p>${esc(c.stream)}</p></header>`
      + (flash ? `<div class="flash ${flash.ok ? "ok" : "no"}" role="status" data-flash>${esc(flash.text)}</div>` : "")
      + account + people + github + jira + syncCard + setup;
    c.send(res, 200, html, standalone("Integrations", body, `<script type="module" src="/tabs.mjs"></script>`));
  };

  // ---------- people: the admin adds and removes who may sign in ----------
  const peoplePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const a = access(env);
    if (!login || !isAdmin(a, login)) return back(res, "/integrations", { ok: false, text: "Only this tira's admin can change who may sign in." });
    const what = form.get("do");
    if (what === "contact") {
      const name = (form.get("name") ?? "").trim();
      const email = (form.get("email") ?? "").trim();
      if ((name && !NAME.test(name)) || (email && !EMAIL.test(email))) return back(res, "/integrations", { ok: false, text: "That isn't a name and an email people can use." });
      saveAccess((x) => ({ ...x, contact: { ...(name ? { name } : {}), ...(email ? { email } : {}) } }), env);
      return back(res, "/integrations", { ok: true, text: "Saved: the sign-in page shows how to reach you." });
    }
    const who2 = (form.get("login") ?? "").trim().replace(/^@/, "");
    if (!GITHUB_LOGIN.test(who2)) return back(res, "/integrations", { ok: false, text: "That isn't a GitHub username." });
    if (what === "add") {
      if (mayEnter(a, who2)) return back(res, "/integrations", { ok: true, text: `${who2} can already sign in.` });
      saveAccess((x) => ({ ...x, members: [...(x.members ?? []), who2] }), env);
      return back(res, "/integrations", { ok: true, text: `Added ${who2}: they can sign in with GitHub now.` });
    }
    if (what === "remove" && !isAdmin(a, who2)) {
      saveAccess((x) => ({ ...x, members: (x.members ?? []).filter((m) => m.toLowerCase() !== who2.toLowerCase()) }), env);
      forget(who2, env);
      return back(res, "/integrations", { ok: true, text: `Removed ${who2}: they're signed out, and tira forgot their sign-ins.` });
    }
    back(res, "/integrations", { ok: false, text: "Nothing changed." });
  };

  // ---------- setup and links ----------
  const setupPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const to = backOf(form.get("back"));
    const now = appKeys(env);
    // once GitHub sign-in is on, only someone signed in may change tira's apps
    if (now.github && !who(req).login) return back(res, to, { ok: false, text: "Sign in with GitHub to change tira's apps." });
    const ghId = (form.get("github_client_id") ?? "").trim();
    const aId = (form.get("atlassian_client_id") ?? "").trim();
    const aSecret = (form.get("atlassian_secret") ?? "").trim();
    const next: Parameters<typeof saveAppKeys>[0] = {};
    if (ghId) next.github = { clientId: ghId };
    if (aId && (aSecret || now.atlassian?.secret)) next.atlassian = { clientId: aId, secret: aSecret || (now.atlassian?.secret as string) };
    if (aId && !aSecret && !now.atlassian?.secret) return back(res, to, { ok: false, text: "Add the Atlassian app's secret too." });
    saveAppKeys(next, env);
    back(res, to, { ok: true, text: to === "/welcome" ? "Saved. Now sign in." : "Saved." });
  };

  const linkPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    if (!me.actor) return back(res, "/integrations", { ok: false, text: "Sign in with GitHub first." });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const link: Record<string, string | undefined> = { repo: ws?.repo, jira_site: ws?.jira_site, jira_project: ws?.jira_project };
    if (form.get("what") === "repo") {
      const repo = (form.get("repo") ?? "").trim();
      if (repo !== "" && !REPO.test(repo)) return back(res, "/integrations", { ok: false, text: `${repo} isn't a repo as owner/name.` });
      link.repo = repo || undefined;
    } else if (form.get("what") === "jira") {
      const key = (form.get("jira_project") ?? "").trim();
      const site = me.login ? atlassianAuth(me.login, env)?.site : undefined;
      if (key !== "" && (!JIRA_PROJECT.test(key) || !site)) return back(res, "/integrations", { ok: false, text: "Pick a Jira project from your connected site." });
      link.jira_project = key || undefined;
      link.jira_site = key ? site : undefined;
    } else return back(res, "/integrations", { ok: false, text: "Nothing to link." });
    back(res, "/integrations", await writeLink(me.actor, ws, link));
  };

  // the workspace's next link, as `actor`: a new version, in the history
  const writeLink = async (actor: string, ws: WorkspaceLink | undefined, link: Record<string, string | undefined>): Promise<Flash> => {
    const payload = Object.fromEntries(Object.entries(link).filter((e): e is [string, string] => e[1] !== undefined));
    if (Object.keys(payload).length === 0) return { ok: false, text: "That would leave the workspace linked to nothing." };
    const version = (ws?.version ?? 0) + 1;
    const w = (await c.dispatcher.submit({ stream: c.stream, kind: "create", entity: { type: WORKSPACE, id: WORKSPACE_ID, version }, actor, payload })).result;
    return w.status === "appended" ? { ok: true, text: `Linked (version ${version}).` } : { ok: false, text: `Not linked (${w.status === "rejected" ? w.detail : w.status}).` };
  };

  // ---------- connect: after signing in, a repo (needed) and a Jira project (optional) ----------
  const connect = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.login) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: me.actor ? "/integrations" : "/welcome" });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const keys = appKeys(env);
    const ghAuth = githubAuth(me.login, env);
    const aAuth = atlassianAuth(me.login, env);
    let repos: string[] = [];
    let repoProblem: string | undefined;
    try {
      repos = ghAuth ? await gh.repos(ghAuth.token) : [];
    } catch (err) {
      repoProblem = `GitHub didn't list your repos (${(err as Error).message}): type one instead.`;
    }
    let jira: ConnectOpts["jira"];
    if (!keys.atlassian) jira = { state: "unset" };
    else if (!aAuth) jira = /^localhost(:\d+)?$/.test(host) ? { state: "disconnected" } : { state: "elsewhere", localhost: `http://localhost:${portOf(host)}/connect` };
    else {
      let projects: { key: string; name: string }[] = [];
      let problem: string | undefined;
      if (aAuth.cloudId) {
        try {
          projects = (await jiraOf(me.login, ws)?.projects()) ?? [];
        } catch (err) {
          problem = `Jira didn't list its projects (${(err as Error).message}).`;
        }
      }
      jira = { state: "connected", sites: aAuth.sites ?? [], ...(aAuth.site ? { site: aAuth.site } : {}), ...(aAuth.cloudId ? { cloudId: aAuth.cloudId } : {}), projects, ...(problem ? { problem } : {}) };
    }
    const flash = c.takeFlash(url.searchParams.get("r") ?? "");
    c.send(res, 200, html, connectPage({
      token: c.token, stream: c.stream, login: me.login, ...(ghAuth?.name ? { name: ghAuth.name } : {}), ...(ws?.repo ? { repo: ws.repo } : {}), repos,
      ...(repoProblem ? { repoProblem } : {}), jira, ...(ws?.jira_project ? { jiraProject: ws.jira_project } : {}), port: portOf(host), ...(flash ? { flash } : {}),
    }));
  };

  const connectPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    if (!me.login) return back(res, "/welcome", { ok: false, text: "Sign in with GitHub first." });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const repo = (form.get("repo") ?? "").trim();
    if (!REPO.test(repo)) return back(res, "/connect", { ok: false, text: repo ? `${repo} isn't a repo as owner/name.` : "Pick a repo." });
    const link: Record<string, string | undefined> = { repo, jira_site: ws?.jira_site, jira_project: ws?.jira_project };
    if (form.has("jira_project")) { // the Jira picker was there: its choice, "No Jira project" included
      const key = (form.get("jira_project") ?? "").trim();
      const site = atlassianAuth(me.login, env)?.site;
      if (key !== "" && (!JIRA_PROJECT.test(key) || !site)) return back(res, "/connect", { ok: false, text: "Pick a Jira project from your connected site." });
      link.jira_project = key || undefined;
      link.jira_site = key ? site : undefined;
    }
    const same = link.repo === ws?.repo && link.jira_project === ws?.jira_project && link.jira_site === ws?.jira_site;
    const f = same ? { ok: true, text: "" } : await writeLink(me.login, ws, link);
    if (!f.ok) return back(res, "/connect", f);
    back(res, "/", { ok: true, text: `Connected to ${repo}${link.jira_project ? ` and Jira ${link.jira_project}` : ""}. Here's your board.` });
  };

  // ---------- Atlassian's round trip ----------
  const jiraConnect = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    const keys = appKeys(env).atlassian;
    const to = backOf(url.searchParams.get("back"));
    if (!me.login || !keys) return back(res, to, { ok: false, text: !keys ? "Add tira's Atlassian app under Setup first." : "Sign in with GitHub first." });
    const state = randomBytes(24).toString("hex");
    pendingJira.set(state, { login: me.login, until: Date.now() + 10 * 60_000, back: to, tab: url.searchParams.get("tab") === "1" });
    c.send(res, 302, "text/plain; charset=utf-8", "", { Location: at.authorizeUrl(keys.clientId, redirectUri(host), state) });
  };

  const jiraCallback = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const state = url.searchParams.get("state") ?? "";
    const p = pendingJira.get(state);
    pendingJira.delete(state);
    const me = who(req);
    const keys = appKeys(env).atlassian;
    // the state must be one this server handed out, to the person now signed in, recently
    if (!p || p.until < Date.now() || p.login !== me.login || !keys) return back(res, "/integrations", { ok: false, text: "That Jira sign-in didn't come from here, or took too long: connect again." });
    const to = p.back;
    // in the tab Connect Jira opened: say how it went there; else back to the page it started on
    const done = (f: Flash) => (p.tab ? c.send(res, 200, html, jiraTabPage(f.ok, f.text, to)) : back(res, to, f));
    const error = url.searchParams.get("error");
    if (error) return done({ ok: false, text: `Jira wasn't connected (${error}).` });
    try {
      const auth: AtlassianAuth = await at.exchange(keys, url.searchParams.get("code") ?? "", redirectUri(host));
      const sites = await at.sites(auth.access);
      const one = sites.length === 1 ? sites[0] : undefined;
      saveAtlassianAuth(p.login, { ...auth, sites, ...(one ? { cloudId: one.id, site: one.url } : {}) }, env);
      done({ ok: true, text: sites.length === 0 ? "Connected, but your Atlassian account has no Jira site." : one ? `Connected to Jira ${one.url}. Pick a project to link.` : "Connected. Pick a Jira site, then a project." });
    } catch (err) {
      done({ ok: false, text: `Jira wasn't connected (${(err as Error).message}).` });
    }
  };

  const jiraSite = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const to = backOf(form.get("back"));
    const login = who(req).login;
    const a = login ? atlassianAuth(login, env) : undefined;
    const site = a?.sites?.find((s) => s.id === form.get("site"));
    if (!login || !a || !site) return back(res, to, { ok: false, text: "Pick one of your Jira sites." });
    saveAtlassianAuth(login, { ...a, cloudId: site.id, site: site.url }, env);
    back(res, to, { ok: true, text: `Using Jira ${site.url}.` });
  };

  const jiraDisconnect = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    if (login) saveAtlassianAuth(login, undefined, env);
    back(res, "/integrations", { ok: true, text: "Jira disconnected: tira no longer holds your Atlassian sign-in." });
  };

  // ---------- sync ----------
  const syncPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const to = form.get("back") === "/integrations" ? "/integrations" : "/";
    const me = who(req);
    if (!me.actor) return back(res, to, { ok: false, text: "Sign in with GitHub to sync." });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    try {
      const jira = jiraOf(me.login, ws);
      const rep = await sync({ store: c.store, registry: c.registry, stream: c.stream, ...(jira ? { jira } : {}), ...(ws?.repo ? { github: githubOf(me.login) } : {}) });
      if (ws?.jira_project && !jira) rep.problems.push("Jira isn't connected: connect it on the Integrations page");
      back(res, to, { ok: rep.problems.length === 0, text: `Sync: ${reportLines(rep).join("; ")}.` });
    } catch (err) {
      back(res, to, { ok: false, text: `Sync: not finished (${(err as Error).message}).` });
    }
  };

  return {
    "GET /welcome": welcome,
    "GET /connect": connect,
    "POST /connect": connectPost,
    "GET /integrations": page,
    "POST /integrations/setup": setupPost,
    "POST /integrations/link": linkPost,
    "POST /integrations/people": peoplePost,
    "GET /integrations/jira/connect": jiraConnect,
    "GET /integrations/jira/callback": jiraCallback,
    "POST /integrations/jira/site": jiraSite,
    "POST /integrations/jira/disconnect": jiraDisconnect,
    "POST /signin/start": signinStart,
    "POST /signin/poll": signinPoll,
    "POST /signout": signout,
    "POST /sync": syncPost,
  };
}

// a page of its own, with tira's bar: the board, the theme, and this page's own script, if any
function standalone(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · ${esc(title)}</title><style>${CSS}</style></head><body>${THEME_RADIOS}<main class="int-page"><nav class="top">${BRAND}<a class="how" href="/">← the board</a>${THEME_SWITCH}</nav>`
    + body + `</main><script type="module" src="/theme.mjs"></script>${script}</body></html>\n`;
}
