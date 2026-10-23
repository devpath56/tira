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
import { JiraCloud, projectName, type JiraClient } from "../sync/jira.ts";
import { access, appKeys, atlassianAuth, displayName, dropSession, forgetGithub, githubAuth, isAdmin, saveDisplayName, signOutEverywhere, jiraLogin, mayEnter, saveAccess, saveAppKeys, saveAtlassianAuth, saveGithubAuth, saveSession, type Access, type AtlassianAuth, type JiraLogin } from "../sync/credentials.ts";
import { GitHubDevice, type GitHubAuthApi } from "../auth/github.ts";
import { AtlassianOAuth, type AtlassianAuthApi } from "../auth/atlassian.ts";
import type { Dispatcher } from "../write/dispatcher.ts";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { esc } from "../render/escape.ts";
import { brand, CSS, projectMark, SIDE_SHUT, SIDE_TOGGLE, THEME_RADIOS } from "../render/html.ts";
import { quote } from "./command.ts";
import { codePage, connectPage, jiraTabPage, landingPage, type ConnectOpts } from "./welcome.ts";

export const SESSION_COOKIE = "tira_session";
// a direct GitHub sign-in under way, in the browser that started it (integrations.ts: signinStart)
const SIGNIN_COOKIE = "tira_signin";

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
  home?: string; // the project tira serve was started with
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
const EMAIL = /^[^\s@<>"']{1,64}@(?:[^\s@<>"'.]+\.)+[^\s@<>"'.]{2,}$/; // dot-free parts: linear, nothing to backtrack over
const NAME = /^[^\u0000-\u001f\u007f<>]{1,60}$/;

// where a form may send its person back to (never an address it names itself)
const BACKS = new Set(["/welcome", "/connect", "/integrations", "/settings", "/projects/new"]);
export const backOf = (v: string | null | undefined, fallback = "/integrations"): string => (v && BACKS.has(v) ? v : fallback);
const portOf = (host: string) => host.replace(/^[^:]*:?/, "") || "4747";

// Where a person's Jira stands, for a page that offers it (the connect step, the New project page)
export type JiraState = ConnectOpts["jira"];

// A person's accounts, for any page that offers them: their GitHub (pull requests, their repos)
// and their Jira (their Atlassian sign-in or, failing that, an API-token login for the site).
export function accounts(outside: Outside | undefined) {
  const env = outside?.env ?? process.env;
  const gh = outside?.githubAuth ?? new GitHubDevice();
  const at = outside?.atlassian ?? new AtlassianOAuth();
  const jiraOf = (login: string | undefined, ws: WorkspaceLink | undefined): JiraClient | undefined => {
    const keys = appKeys(env).atlassian;
    const a = login ? atlassianAuth(login, env) : undefined;
    if (keys && a?.cloudId && login) return at.jira(keys, a, (next) => saveAtlassianAuth(login, next, env));
    const site = ws?.jira_site;
    const l = site ? jiraLogin(site, env) : undefined;
    return site && l ? outside?.jira?.(site, l) ?? new JiraCloud(site, l.email, l.token) : undefined;
  };
  const githubOf = (login: string | undefined): GitHubClient => {
    if (outside?.github) return outside.github;
    const t = login ? githubAuth(login, env)?.token : undefined;
    return t && gh instanceof GitHubDevice ? gh.pullsAs(t) : new GhCli();
  };
  // their repos, as GitHub lists them (none until they sign in with GitHub)
  const repos = async (login: string | undefined): Promise<{ repos: string[]; problem?: string }> => {
    const a = login ? githubAuth(login, env) : undefined;
    if (!a) return { repos: [] };
    try {
      return { repos: await gh.repos(a.token) };
    } catch (err) {
      return { repos: [], problem: `GitHub didn't list your repos (${(err as Error).message}).` };
    }
  };
  // their Jira: not set up, to connect (at localhost: where Atlassian sends people back to the page
  // named by `back`), or connected, with its sites and the chosen one's projects
  const jira = async (login: string, host: string, back: string, ws?: WorkspaceLink): Promise<JiraState> => {
    if (!appKeys(env).atlassian) return { state: "unset" };
    const a = atlassianAuth(login, env);
    if (!a) return /^localhost(:\d+)?$/.test(host) ? { state: "disconnected" } : { state: "elsewhere", localhost: `http://localhost:${portOf(host)}${back}` };
    let projects: { key: string; name: string }[] = [];
    let problem: string | undefined;
    if (a.cloudId) {
      try {
        projects = (await jiraOf(login, ws)?.projects()) ?? [];
      } catch (err) {
        problem = `Jira didn't list its projects (${(err as Error).message}).`;
      }
    }
    return { state: "connected", sites: a.sites ?? [], ...(a.site ? { site: a.site } : {}), ...(a.cloudId ? { cloudId: a.cloudId } : {}), projects, ...(problem ? { problem } : {}) };
  };
  return { env, gh, at, jiraOf, githubOf, repos, jira };
}

export function integrationRoutes(c: IntegrationsContext, who: (req: IncomingMessage) => { login?: string; actor?: string; signInOn: boolean }) {
  const acc = accounts(c.outside);
  const { env, gh, at, jiraOf, githubOf } = acc;
  const pendingSignIns = new Map<string, { deviceCode: string; userCode: string; verifyAt: string; interval: number; until: number }>();
  const pendingJira = new Map<string, { login: string; until: number; back: string; tab: boolean }>();
  const pendingGithub = new Map<string, { until: number; w: string | null }>(); // the direct way's sign-ins under way, by state: until when, and the project it left from
  const back = (res: ServerResponse, to: string, f?: Flash) => c.send(res, 303, "text/plain; charset=utf-8", "", { Location: f ? `${to}?r=${c.flash(f)}` : to });
  const redirectUri = (host: string) => `http://${host}/integrations/jira/callback`;
  const githubBack = (host: string) => `http://${host}/signin/github/callback`;


  // the step after signing in: connect a repo while the workspace has none, else the board
  const nextStep = async (login: string | undefined): Promise<string> => (login && !workspaceOf((await c.now()).r, c.stream)?.repo ? "/connect" : "/");

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

  const signinStart = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const clientId = appKeys(env).github?.clientId;
    if (!clientId) return back(res, "/welcome", { ok: false, text: "GitHub sign-in isn't set up yet: add tira's GitHub app first." });
    // the direct way, once tira's app has its secret: off to GitHub's page and straight back, at
    // localhost (where tira's GitHub app sends people back to). The state rides in a cookie too, so
    // only the browser that started a sign-in can finish it.
    const secret = appKeys(env).github?.secret;
    if (secret && /^localhost(:\d+)?$/.test(host)) {
      const now = Date.now();
      for (const [s, p] of pendingGithub) if (p.until < now) pendingGithub.delete(s);
      const state = randomBytes(24).toString("hex");
      pendingGithub.set(state, { until: now + 10 * 60_000, w: url.searchParams.get("w") });
      return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: gh.authorizeUrl(clientId, githubBack(host), state), "Set-Cookie": `${SIGNIN_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/signin; Max-Age=600` });
    }
    try {
      const s = await gh.start(clientId);
      const id = randomBytes(16).toString("hex");
      pendingSignIns.set(id, { deviceCode: s.deviceCode, userCode: s.userCode, verifyAt: s.verifyAt, interval: s.interval, until: Date.now() + s.expiresIn * 1000 });
      // the code at its own address, so Back from GitHub (when it opened in this tab) or a reload comes back to it
      c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/signin/code?id=${id}` });
    } catch (err) {
      back(res, "/welcome", { ok: false, text: `GitHub sign-in didn't start (${(err as Error).message}).` });
    }
  };

  // GitHub's code to approve, at its own address: the page waits there, and goes on in once it's approved
  const signinCode = async (_req: IncomingMessage, res: ServerResponse, url: URL) => {
    const id = url.searchParams.get("id") ?? "";
    const p = pendingSignIns.get(id);
    if (!p || p.until < Date.now()) return back(res, "/welcome", { ok: false, text: "That sign-in expired: start again." });
    signinPage(res, id, p);
  };

  // GitHub, back from the direct way: its one-time code, for a token, once, in the browser that left
  const signinBack = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const state = url.searchParams.get("state") ?? "";
    const p = pendingGithub.get(state);
    // GitHub comes back to one address: first, to the project the sign-in left from
    if (p?.w && !url.searchParams.has("w")) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/signin/github/callback${url.search}&w=${encodeURIComponent(p.w)}` });
    pendingGithub.delete(state); // a state works once
    const keys = appKeys(env).github;
    if (!keys?.secret || state === "" || p === undefined || p.until < Date.now() || cookieOf(req, SIGNIN_COOKIE) !== state) {
      return back(res, "/welcome", { ok: false, text: "That GitHub sign-in didn't start here, or took too long: sign in again." });
    }
    const error = url.searchParams.get("error");
    if (error) return back(res, "/welcome", { ok: false, text: error === "access_denied" ? "You turned it down on GitHub: sign in again when you're ready." : `GitHub sign-in stopped: ${error}.` });
    try {
      await enter(res, await gh.exchange(keys.clientId, keys.secret, url.searchParams.get("code") ?? "", githubBack(host)), false);
    } catch (err) {
      back(res, "/welcome", { ok: false, text: `GitHub sign-in stopped (${(err as Error).message}).` });
    }
  };

  // In, with GitHub's token (either way): only the admin and the people they added get in (the first
  // person in becomes the admin); anyone else is told who to ask, and tira keeps nothing of theirs.
  // fragment: signin.mjs asked, and goes where the answer says.
  const enter = async (res: ServerResponse, token: string, fragment: boolean) => {
    const me = await gh.user(token);
    const a = access(env);
    if (!mayEnter(a, me.login)) {
      const key = c.flash({ ok: false, text: `${me.login} doesn't have access to this tira yet. ${askAdmin(a)}` });
      return fragment ? c.send(res, 200, html, `<div data-go="/welcome?r=${key}"></div>`) : back(res, "/welcome", c.takeFlash(key));
    }
    const first = a.admin === undefined;
    if (first) await saveAccess((x) => (x.admin === undefined ? { ...x, admin: me.login } : x), env); // the first one in, even if two arrive at once
    await saveGithubAuth(me.login, { token, ...(me.name ? { name: me.name } : {}) }, env);
    const session = randomBytes(32).toString("hex");
    await saveSession(session, me.login, env);
    const cookie = `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
    const key = c.flash({ ok: true, text: first
      ? `Signed in as ${me.login}: you're this tira's admin. Add the people who may sign in in Account settings.`
      : `Signed in as ${me.login}. tira records your changes as ${me.login}.` });
    const go = `${await nextStep(me.login)}?r=${key}`;
    if (fragment) return c.send(res, 200, html, `<div data-go="${esc(go)}"></div>`, { "Set-Cookie": cookie });
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: go, "Set-Cookie": cookie });
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
      pendingSignIns.delete(id);
      await enter(res, got.token, fragment);
    } catch (err) {
      fail(`GitHub sign-in stopped (${(err as Error).message}).`);
    }
  };

  const signout = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const id = cookieOf(req, SESSION_COOKIE);
    if (id) await dropSession(id, env);
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/", "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  };

  // ---------- the settings pages ----------
  // GitHub's settings: a section per subject (a title, a line on what it's for, then rows of label
  // and control, a footnote at most), reached from the nav on the left. Each choice's command is one
  // click away, under "Show the command". Account settings are yours, in every project; Project
  // settings are the project's own.
  const hidden = () => `<input type="hidden" name="token" value="${esc(c.token)}">`;
  const cmd = (text: string) => `<details class="int-cmd"><summary>Show the command</summary><code>${esc(text)}</code></details>`;
  const row = (k: string, v: string) => `<div class="grp-row"><span class="grp-k">${k}</span>${v}</div>`;
  const group = (id: string, title: string, rows: string, foot = "") => `<section class="grp" id="${id}" data-int="${id}"><h2 class="grp-h">${title}</h2>${descOf(id) ? `<p class="grp-desc">${esc(descOf(id) ?? "")}</p>` : ""}<div class="grp-list">${rows}</div>${foot ? `<div class="grp-foot">${foot}</div>` : ""}</section>`;
  const problem = (text: string) => (text ? `<div class="grp-row"><span class="grp-k no">${esc(text)}</span></div>` : "");
  const flashOf = (url: URL) => {
    const f = c.takeFlash(url.searchParams.get("r") ?? "");
    return f ? `<div class="flash ${f.ok ? "ok" : "no"}" role="status" data-flash>${esc(f.text)}</div>` : "";
  };
  const scripts = `<script type="module" src="/tabs.mjs"></script><script type="module" src="/help.mjs"></script>`;
  const signedOut = (res: ServerResponse, url: URL) => c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/welcome${url.search}` }); // a result goes along

  // Account settings (GET /settings): who you are, your GitHub and Jira, how tira looks, who may
  // sign in, and tira's own apps.
  const profile = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url); // yours: sign in first
    const keys = appKeys(env);
    const ghAuth = me.login ? githubAuth(me.login, env) : undefined;
    const t = hidden();

    // you (someone who isn't signed in is sent to the landing, unless tira serve acts as its own name),
    // shown by the name you chose (else GitHub's, else your login); your changes stay under your login
    const initial = (name: string) => esc(([...name][0] ?? "?").toUpperCase());
    const role = me.login ? (isAdmin(access(env), me.login) ? "Admin" : "Member") : "";
    const chosen = displayName(me.actor, env);
    const shown = chosen ?? (me.login ? ghAuth?.name ?? me.login : me.actor);
    const nameRow = `<form method="post" action="/integrations/profile" class="grp-row" data-display-name>${t}<span class="grp-k">Display name</span><input type="text" name="name" value="${esc(chosen ?? "")}" maxlength="60" autocomplete="off" placeholder="${esc(me.login ? ghAuth?.name ?? me.login : me.actor)}" aria-label="Display name"><button class="act" type="submit">Save</button></form>`;
    // you and your accounts, in one list (as Apple's settings put them): who you are, the name you're
    // shown by, then GitHub (who you're signed in as) and Jira (sign in, pick a site, disconnect),
    // each with its action on its own row
    const card = me.login
      ? `<div class="profile" data-profile-card><span class="av av-lg">${initial(shown)}</span><span class="pf-who"><b>${esc(shown)}</b><span>@${esc(me.login)} · signed in with GitHub</span></span><span class="pill">${role}</span>`
        + `<form method="post" action="/signout" class="pf-out">${t}<button class="act" type="submit">Sign out</button></form></div>`
      : `<div class="profile" data-profile-card><span class="av av-lg">${initial(shown)}</span><span class="pf-who"><b>${esc(shown)}</b><span>the name tira serve was started with</span></span></div>`
        + row("Working as", `<span class="grp-v">${esc(me.actor)}</span>`);
    let jira: string;
    if (!me.login) jira = row("Jira", `<span class="grp-v">${keys.atlassian ? "Sign in with GitHub first" : "Not set up: add tira's Atlassian app under Setup"}</span>`);
    else {
      const j = await acc.jira(me.login, host, "/settings");
      if (j.state === "unset") jira = row("Jira", `<span class="grp-v">Not set up: add tira's Atlassian app under Setup</span>`);
      else if (j.state === "elsewhere") jira = row("Jira", `<a class="how" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`);
      else if (j.state === "disconnected") jira = row("Jira", `<a class="act primary" href="${esc("/integrations/jira/connect?back=/settings&tab=1")}" target="_blank" rel="noopener" data-connect-jira>Sign in to Jira</a>`);
      else {
        const off = `<button class="how" type="submit">Disconnect</button></form>`;
        jira = j.sites.length > 1
          ? `<form method="post" action="/integrations/jira/site" class="grp-row">${t}<input type="hidden" name="back" value="/settings"><span class="grp-k">Jira site</span><select name="site" aria-label="Jira site">${j.sites.map((x) => `<option value="${esc(x.id)}"${x.id === j.cloudId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select><button class="act" type="submit">Use</button></form>`
            + `<form method="post" action="/integrations/jira/disconnect" class="grp-row" data-disconnect-jira>${t}<span class="grp-k">Jira</span>${off}`
          : `<form method="post" action="/integrations/jira/disconnect" class="grp-row" data-disconnect-jira>${t}<span class="grp-k">Jira</span><span class="grp-v">${j.site ? esc(j.site.replace(/^https:\/\//, "")) : "Connected"}</span>${off}`;
      }
    }
    const github = me.login
      ? `<form method="post" action="/integrations/github/disconnect" class="grp-row" data-disconnect-github>${t}<span class="grp-k">GitHub</span><span class="grp-v">@${esc(me.login)}</span><button class="how" type="submit">Disconnect</button></form>`
      : row("GitHub", `<span class="grp-v">${keys.github ? "Not signed in" : "Not set up: add tira's GitHub app under Setup"}</span>`);
    const account = group("account", "Account", card + nameRow + github + jira, me.login
      ? "Your changes are recorded under your GitHub login; the display name is only how you're shown. GitHub and Jira stay linked until you disconnect them here."
      : "GitHub sign-in isn't set up. Add it under Setup.");

    // how tira looks, in this browser (the theme's radios are at the top of every page)
    const looks: [string, string, string][] = [["system", "System", "Follows your computer"], ["light", "Light", "Always light"], ["dark", "Dark", "Always dark"]];
    const appearance = `<section class="grp" id="appearance" data-int="appearance"><h2 class="grp-h">Appearance</h2><p class="grp-desc">${esc(DESC.appearance)}</p>`
      + `<div class="appear" data-theme-switch>${looks.map(([v, label, said]) => `<label for="th-${v}" class="look look-${v}"><span class="look-pic" aria-hidden="true"><i></i><i></i><i></i></span><b>${label}</b><small>${said}</small></label>`).join("")}</div></section>`;

    // people: who may sign in (the admin changes it; everyone else sees who to ask)
    const a = access(env);
    let people: string;
    if (!me.login) people = group("people", "People", row("Admin", `<span class="grp-v">The first to sign in</span>`));
    else if (!isAdmin(a, me.login)) people = group("people", "People", row("Admin", `<span class="grp-v">${esc(a.contact?.name ?? a.admin ?? "")}</span>`), "Ask the admin to add or remove people.");
    else {
      const rows = (a.members ?? []).map((m) => `<form method="post" action="/integrations/people" class="grp-row">${t}<input type="hidden" name="do" value="remove"><input type="hidden" name="login" value="${esc(m)}"><span class="grp-k">${esc(m)}</span><button class="how" type="submit">Remove</button></form>`).join("");
      people = `<section class="grp" id="people" data-int="people"><h2 class="grp-h">People</h2><p class="grp-desc">${esc(DESC.people)}</p><div class="grp-list" data-people>`
        + `<div class="grp-row"><span class="grp-k">${esc(a.admin ?? me.login)}</span><span class="pill">Admin</span></div>${rows}`
        + `<form method="post" action="/integrations/people" class="grp-row" data-add-person>${t}<input type="hidden" name="do" value="add"><input type="text" name="login" aria-label="GitHub username" autocomplete="off" spellcheck="false" placeholder="GitHub username" required><button class="act primary" type="submit">Add</button></form>`
        + `</div><div class="grp-foot">Only these people can sign in.</div></section>`
        + `<section class="grp" id="contact" data-int="contact"><h2 class="grp-h">Your contact</h2><form method="post" action="/integrations/people" class="grp-list" data-admin-contact>${t}<input type="hidden" name="do" value="contact">`
        + `<label class="grp-row"><span class="grp-k">Name</span><input type="text" name="name" value="${esc(a.contact?.name ?? ghAuth?.name ?? "")}" autocomplete="off"></label>`
        + `<label class="grp-row"><span class="grp-k">Email</span><input type="email" name="email" value="${esc(a.contact?.email ?? "")}" autocomplete="off"></label>`
        + `<div class="grp-row"><span class="grp-k"></span><button class="act" type="submit">Save</button></div></form><div class="grp-foot">Shown to people who can't sign in yet.</div></section>`;
    }

    // setup: tira's own apps (open while one is missing)
    const setup = `<details class="grp" data-int="setup" id="setup"${keys.github && keys.atlassian ? "" : " open"}><summary class="grp-h">Setup</summary><p class="grp-desc">${esc(DESC.setup)}</p>`
      + `<form method="post" action="/integrations/setup" class="grp-list">${t}<input type="hidden" name="back" value="/settings">`
      + `<label class="grp-row"><span class="grp-k">GitHub Client ID</span><input type="text" name="github_client_id" value="${esc(keys.github?.clientId ?? "")}" autocomplete="off" spellcheck="false"></label>`
      + `<label class="grp-row"><span class="grp-k">GitHub Secret</span><input type="password" name="github_secret" value="" autocomplete="off" placeholder="${keys.github?.secret ? "Saved" : "Optional: sign in in one click"}"></label>`
      + `<label class="grp-row"><span class="grp-k">Atlassian Client ID</span><input type="text" name="atlassian_client_id" value="${esc(keys.atlassian?.clientId ?? "")}" autocomplete="off" spellcheck="false"></label>`
      + `<label class="grp-row"><span class="grp-k">Atlassian Secret</span><input type="password" name="atlassian_secret" value="" autocomplete="off"${keys.atlassian ? ` placeholder="Saved"` : ""}></label>`
      + `<div class="grp-row"><span class="grp-k"></span><button class="act primary" type="submit">Save</button></div></form>`
      + `<div class="grp-foot">Kept privately, sealed. A secret is never shown again. How to make these apps: ask the Help centre.</div></details>`;

    const body = `<header class="int-head"><h1>Account settings</h1><p>Yours, in every project on this tira.</p></header>` + flashOf(url) + account + setup + people + appearance;
    c.send(res, 200, html, settingsPage({ title: "Account settings", label: "Account settings", sections: [["account", "Account"], ["setup", "Setup"], ["people", "People"], ["appearance", "Appearance"]] }, body, helpPanel(portOf(host), shown), scripts));
  };

  // Project settings (GET /integrations): this project's name, its GitHub repo, its Jira project,
  // Sync, and deleting it.
  const page = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url); // the project's: sign in first
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const keys = appKeys(env);
    const t = hidden();

    // GitHub: pick one of your repos
    const got = await acc.repos(me.login);
    const repoOptions = [...new Set([...(ws?.repo ? [ws.repo] : []), ...got.repos])];
    const github = group("github", "GitHub",
      problem(got.problem ?? "")
        + (repoOptions.length === 0 ? row("Repository", `<span class="grp-v">${keys.github ? "Sign in with GitHub to pick one" : "Set up GitHub sign-in in Account settings first"}</span>`)
          : `<form method="post" action="/integrations/link" class="grp-row" data-link-repo-form>${t}<input type="hidden" name="what" value="repo"><span class="grp-k">Repository</span><select name="repo" aria-label="Repository">${repoOptions.map((x) => `<option value="${esc(x)}"${x === ws?.repo ? " selected" : ""}>${esc(x)}</option>`).join("")}</select><button class="act primary" type="submit">${ws?.repo ? "Change" : "Link"}</button>${ws?.repo ? `<button class="how" type="submit" name="repo" value="">Unlink</button>` : ""}</form>`),
      repoOptions.length > 0 ? cmd(`tira link --repo ${quote(ws?.repo ?? repoOptions[0] ?? "OWNER/NAME")}`) : "");

    // Jira: pick a project from your connected site (connecting is yours: Account settings)
    let jira: string;
    if (!keys.atlassian) jira = group("jira", "Jira", row("Jira", `<span class="grp-v">Not set up</span>`), `Add tira's Atlassian app in <a class="how" href="/settings#setup">Account settings</a>.`);
    else if (!me.login) jira = group("jira", "Jira", row("Jira", `<span class="grp-v">Sign in with GitHub first</span>`));
    else {
      const j = await acc.jira(me.login, host, "/integrations", ws);
      if (j.state === "elsewhere") jira = group("jira", "Jira", row("Jira", `<a class="how" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`));
      else if (j.state !== "connected") jira = group("jira", "Jira", row("Jira", `<a class="act primary" href="${esc("/integrations/jira/connect?tab=1")}" target="_blank" rel="noopener" data-connect-jira>Sign in to Jira</a>`), "Connects your Atlassian account, for every project (Account settings).");
      else if (!j.cloudId) jira = group("jira", "Jira", row("Jira", `<a class="how" href="/settings#account">Pick your Jira site in Account settings</a>`));
      else jira = group("jira", "Jira",
        row("Site", `<span class="grp-v">${esc(j.site ?? "")}</span>`)
          + problem(j.problem ?? "")
          + `<form method="post" action="/integrations/link" class="grp-row" data-link-jira-form>${t}<input type="hidden" name="what" value="jira"><span class="grp-k">Project</span><select name="jira_project" aria-label="Jira project">${j.projects.map((x) => `<option value="${esc(x.key)}"${x.key === ws?.jira_project ? " selected" : ""}>${esc(x.name)} (${esc(x.key)})</option>`).join("")}</select><button class="act primary" type="submit">${ws?.jira_project ? "Change" : "Link"}</button>${ws?.jira_project ? `<button class="how" type="submit" name="jira_project" value="">Unlink</button>` : ""}</form>`,
        cmd(`tira link --jira-site ${quote(j.site ?? "")} --jira ${quote(ws?.jira_project ?? j.projects[0]?.key ?? "KEY")}`));
    }

    // sync
    const canSync = !!ws && (!!ws.repo || !!ws.jira_project);
    const syncCard = group("sync", "Sync", canSync
      ? `<form method="post" action="/sync" class="grp-row">${t}<input type="hidden" name="back" value="/integrations"><span class="grp-k">GitHub and Jira</span><button class="act primary" type="submit" data-sync>Sync now</button></form>`
      : row("Sync", `<span class="grp-v">Link a repo or a Jira project first</span>`), canSync ? cmd("tira sync") : "");

    // its name, as people see it (its address and history keep the one it was made with)
    const shown = ws?.title ?? c.stream;
    const name = esc(shown);
    const general = `<section class="grp" id="general" data-int="general"><h2 class="grp-h">General</h2><p class="grp-desc">${esc(DESC.general)}</p>`
      + `<form method="post" action="/projects/rename" class="grp-list" data-rename-project>${t}<label class="grp-row"><span class="grp-k">Project name</span><input type="text" name="title" value="${name}" required maxlength="80" autocomplete="off" spellcheck="false" aria-label="Project name"></label>`
      + `<div class="grp-row"><span class="grp-k"></span><button class="act primary" type="submit">Rename</button></div></form>`
      + `<div class="grp-foot">Its address and its history keep the name it was made with: <code>${esc(c.stream)}</code>.</div></section>`;

    // delete: type the project's name to be sure (not the one tira serve was started with)
    const remove = `<section class="grp danger" id="delete" data-int="delete"><h2 class="grp-h">Delete project</h2><p class="grp-desc">${esc(DESC.delete)}</p>`
      + (c.stream === c.home
        ? `<div class="grp-list">${row("Delete", `<span class="grp-v">This is the project tira serve was started with: start it on another to delete this one</span>`)}</div></section>`
        : `<form method="post" action="/projects/delete" class="grp-list" data-delete-project>${t}<label class="grp-row"><span class="grp-k">Type <b>${name}</b> to confirm</span><input type="text" name="confirm" autocomplete="off" spellcheck="false" required aria-label="Type ${name} to confirm"></label>`
          + `<div class="grp-row"><span class="grp-k"></span><button class="act danger" type="submit">Delete this project</button></div></form></section>`);

    const body = `<header class="int-head"><h1>Project settings</h1><p>${projectMark(c.stream, shown)}<b>${name}</b></p></header>` + flashOf(url) + general + github + jira + syncCard + remove;
    c.send(res, 200, html, settingsPage({ title: `Project settings · ${shown}`, label: "Project settings", project: { stream: c.stream, name: shown }, sections: [["general", "General"], ["github", "GitHub"], ["jira", "Jira"], ["sync", "Sync"], ["delete", "Delete"]] }, body, helpPanel(portOf(host), me.actor), scripts));
  };

  // ---------- people: the admin adds and removes who may sign in ----------
  const peoplePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const a = access(env);
    if (!login || !isAdmin(a, login)) return back(res, "/settings", { ok: false, text: "Only this tira's admin can change who may sign in." });
    const what = form.get("do");
    if (what === "contact") {
      const name = (form.get("name") ?? "").trim();
      const email = (form.get("email") ?? "").trim();
      if ((name && !NAME.test(name)) || (email && !EMAIL.test(email))) return back(res, "/settings", { ok: false, text: "That isn't a name and an email people can use." });
      await saveAccess((x) => ({ ...x, contact: { ...(name ? { name } : {}), ...(email ? { email } : {}) } }), env);
      return back(res, "/settings", { ok: true, text: "Saved: the sign-in page shows how to reach you." });
    }
    const who2 = (form.get("login") ?? "").trim().replace(/^@/, "");
    if (!GITHUB_LOGIN.test(who2)) return back(res, "/settings", { ok: false, text: "That isn't a GitHub username." });
    if (what === "add") {
      if (mayEnter(a, who2)) return back(res, "/settings", { ok: true, text: `${who2} can already sign in.` });
      await saveAccess((x) => ({ ...x, members: [...(x.members ?? []), who2] }), env);
      return back(res, "/settings", { ok: true, text: `Added ${who2}: they can sign in with GitHub now.` });
    }
    if (what === "remove" && !isAdmin(a, who2)) {
      await saveAccess((x) => ({ ...x, members: (x.members ?? []).filter((m) => m.toLowerCase() !== who2.toLowerCase()) }), env);
      await signOutEverywhere(who2, env);
      return back(res, "/settings", { ok: true, text: `Removed ${who2}: they're signed out and can't sign in. Their GitHub and Jira links stay until they unlink them.` });
    }
    back(res, "/settings", { ok: false, text: "Nothing changed." });
  };

  // ---------- you: the name you're shown by, and unlinking your GitHub ----------
  const profilePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    if (!me.actor) return back(res, "/welcome", { ok: false, text: "Sign in with GitHub first." });
    const name = (form.get("name") ?? "").trim().replace(/\s+/g, " ");
    if (name !== "" && !NAME.test(name)) return back(res, "/settings", { ok: false, text: "A display name is 1 to 60 characters, with no angle brackets." });
    await saveDisplayName(me.actor, name || undefined, env);
    back(res, "/settings", { ok: true, text: name ? `You're shown as ${name} now.` : "You're shown by your usual name again." });
  };

  const githubDisconnect = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    if (!login) return back(res, "/settings", { ok: false, text: "No GitHub account is linked here." });
    await forgetGithub(login, env);
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/welcome?r=${c.flash({ ok: true, text: "GitHub disconnected: tira no longer holds your GitHub token, and you're signed out. Sign in again to link it." })}`, "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
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
    const ghSecret = (form.get("github_secret") ?? "").trim();
    const aId = (form.get("atlassian_client_id") ?? "").trim();
    const aSecret = (form.get("atlassian_secret") ?? "").trim();
    const next: Parameters<typeof saveAppKeys>[0] = {};
    // a secret left empty keeps the one saved (the direct sign-in; without one, GitHub's code)
    const keptSecret = ghSecret || now.github?.secret;
    if (ghId) next.github = { clientId: ghId, ...(keptSecret ? { secret: keptSecret } : {}) };
    if (aId && (aSecret || now.atlassian?.secret)) next.atlassian = { clientId: aId, secret: aSecret || (now.atlassian?.secret as string) };
    if (aId && !aSecret && !now.atlassian?.secret) return back(res, to, { ok: false, text: "Add the Atlassian app's secret too." });
    await saveAppKeys(next, env);
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
      link.jira_name = key && site ? await projectName(jiraOf(me.login, { version: 0, jira_site: site }), key) : undefined;
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
    const ghAuth = githubAuth(me.login, env);
    let repos: string[] = [];
    let repoProblem: string | undefined;
    try {
      repos = ghAuth ? await gh.repos(ghAuth.token) : [];
    } catch (err) {
      repoProblem = `GitHub didn't list your repos (${(err as Error).message}): type one instead.`;
    }
    const jira = await acc.jira(me.login, host, "/connect", ws);
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
    if (!same && link.jira_project && link.jira_site) link.jira_name = await projectName(jiraOf(me.login, { version: 0, jira_site: link.jira_site }), link.jira_project);
    const f = same ? { ok: true, text: "" } : await writeLink(me.login, ws, link);
    if (!f.ok) return back(res, "/connect", f);
    const jiraShown = link.jira_name ?? (link.jira_project === ws?.jira_project ? ws?.jira_name : undefined) ?? link.jira_project;
    back(res, "/", { ok: true, text: `Connected to ${repo}${link.jira_project ? ` and Jira ${jiraShown}` : ""}. Here's your board.` });
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
      await saveAtlassianAuth(p.login, { ...auth, sites, ...(one ? { cloudId: one.id, site: one.url } : {}) }, env);
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
    await saveAtlassianAuth(login, { ...a, cloudId: site.id, site: site.url }, env);
    back(res, to, { ok: true, text: `Using Jira ${site.url}.` });
  };

  const jiraDisconnect = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    if (login) await saveAtlassianAuth(login, undefined, env);
    back(res, "/settings", { ok: true, text: "Jira disconnected: tira no longer holds your Atlassian sign-in." });
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
      const rep = await sync({ store: c.store, registry: c.registry, stream: c.stream, by: me.actor, ...(jira ? { jira } : {}), ...(ws?.repo ? { github: githubOf(me.login) } : {}) });
      if (ws?.jira_project && !jira) rep.problems.push("Jira isn't connected: connect it in Account settings");
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
    "GET /settings": profile,
    "POST /integrations/setup": setupPost,
    "POST /integrations/link": linkPost,
    "POST /integrations/people": peoplePost,
    "POST /integrations/profile": profilePost,
    "POST /integrations/github/disconnect": githubDisconnect,
    "GET /integrations/jira/connect": jiraConnect,
    "GET /integrations/jira/callback": jiraCallback,
    "POST /integrations/jira/site": jiraSite,
    "POST /integrations/jira/disconnect": jiraDisconnect,
    "POST /signin/start": signinStart,
    "GET /signin/start": async (_req: IncomingMessage, res: ServerResponse) => back(res, "/welcome"), // a reload of the button's address
    "GET /signin/code": signinCode,
    "GET /signin/github/callback": signinBack,
    "POST /signin/poll": signinPoll,
    "POST /signout": signout,
    "POST /sync": syncPost,
  };
}

// What each settings section is for, in a line (GitHub's settings say it under the title).
const DESC = {
  general: "What everyone sees this project called, everywhere in tira.",
  account: "Who you are here, and the GitHub and Jira accounts tira uses for you, in every project.",
  appearance: "How tira looks in this browser: it follows your computer unless you pick one.",
  people: "Who can sign in to this tira. The first person to sign in is its admin.",
  github: "This project's repository. A pull request that names a task links to it; a merged one is its proof.",
  jira: "The Jira project this project mirrors into. tira leads: nothing moves in Jira until someone syncs.",
  sync: "Brings GitHub and Jira up to date with the board, and Jira moves back as commands tira checks.",
  setup: "tira's own GitHub and Atlassian apps, made once per machine.",
  delete: "It leaves tira's project list and its board closes, for everyone. tira never erases: its history stays in the log.",
};

const descOf = (id: string): string | undefined => (DESC as Record<string, string | undefined>)[id];

// A settings page, after GitHub's: the sections on the left (the tira mark goes back to the board),
// the page across the middle, help on the right; ☰ hides the sections, as on the board. Account settings are yours; Project settings name
// their project.
interface SettingsOf { title: string; label: string; project?: { stream: string; name: string }; sections: [string, string][] }
function settingsPage(o: SettingsOf, body: string, help: string, script = ""): string {
  const nav = `<nav class="set-nav" aria-label="${esc(o.label)}">${brand("/")}<p class="set-k">${esc(o.label)}</p>`
    + (o.project === undefined ? "" : `<p class="set-proj">${projectMark(o.project.stream, o.project.name)}<span>${esc(o.project.name)}</span></p>`)
    + o.sections.map(([id, label]) => `<a class="set-link" href="#${id}">${label}</a>`).join("") + `</nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · ${esc(o.title)}</title><style>${CSS}</style></head><body>${THEME_RADIOS}${SIDE_SHUT}<main class="settings-page" data-settings>${SIDE_TOGGLE}${nav}<div class="set-main">`
    + body + `</div>${help}</main><script type="module" src="/theme.mjs"></script>${script}</body></html>\n`;
}

// The Help centre, as a support chat (after Intercom's and Zendesk's messengers): a header that says
// it answers right away, a greeting, the questions people ask here as suggested replies, and a box to
// type your own. help.mjs plays it as a conversation (your question on the right, a moment of
// typing, tira's answer on the left) and matches what you type to the answers it has; nothing you
// type leaves the page. With no script, each suggestion opens on its answer.
const SEND = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>`;
function helpPanel(port: string, name?: string): string {
  // a question, its answer, and the words someone might type for it
  const qa: [string, string, string][] = [
    ["How do I make tira's GitHub app?", `On GitHub: Settings → Developer settings → OAuth Apps → New. Homepage <code>http://localhost:${esc(port)}</code>, callback <code>http://localhost:${esc(port)}/</code>. Tick Enable Device Flow, then paste its Client ID under Setup. For sign-in in one click (straight to GitHub and back, no code), generate a client secret there too and paste it beside the Client ID.`, "github app oauth client id secret device flow setup create sign in code direct"],
    ["How do I make the Atlassian app for Jira?", `In Atlassian's developer console: Create → OAuth 2.0. Jira scopes <code>read:jira-work</code>, <code>write:jira-work</code>, <code>read:jira-user</code>. Callback <code>http://localhost:${esc(port)}/integrations/jira/callback</code>. Paste its Client ID and secret under Setup.`, "atlassian jira app oauth scopes console client secret create"],
    ["Where are my keys and tokens kept?", "Only on this machine, in tira's private store. The Atlassian secret is never shown again, and nothing goes into the project's log.", "keys tokens secret stored kept saved private safe credentials password"],
    ["What does Sync do?", "It links pull requests that name a task, makes a Jira issue for each task, and brings moves made in Jira back as commands, which tira's rules may refuse. A merged pull request counts as proof of work.", "sync syncing pull request pr issue mirror update proof merge"],
    ["Who can sign in?", "The first person to sign in becomes the admin. After that, only the people the admin adds by GitHub username.", "sign signin login admin people access invite add user member team"],
    ["Why does Jira need localhost?", `Atlassian sends you back to tira's callback on localhost. Open tira at <code>http://localhost:${esc(port)}</code> to connect Jira.`, "localhost callback redirect connect address url port"],
  ];
  const hi = name ? `Hi ${esc(name)}! I'm tira's help.` : "Hi! I'm tira's help.";
  return `<aside class="set-help" aria-label="Help centre" data-help><details class="hc" data-remember="tira-help-centre" open>`
    + `<summary class="help-head" title="Help centre: open or fold"><span class="av tira">?</span><span class="hc-t"><b>Help centre</b><small><i class="hc-on" aria-hidden="true"></i>Answers right away</small></span><span class="hc-fold" aria-hidden="true"></span></summary>`
    + `<div class="hc-body"><div class="hc-log" role="log" aria-live="polite" aria-label="Conversation" data-help-log>`
    + `<div class="msg from-tira"><span class="av tira" aria-hidden="true">t</span><div class="msg-b"><p class="bubble">${hi} I can answer questions about setting up GitHub, Jira and Sync.</p><p class="bubble">Pick a question, or type your own.</p><span class="msg-meta">tira · Help centre</span></div></div></div>`
    + `<div class="hc-suggest" data-help-suggest><p class="hc-sk" data-help-sk>Suggested</p>`
    + qa.map(([q, a, keys]) => `<details class="hc-qa" data-keys="${esc(keys)}"><summary class="hc-chip">${esc(q)}</summary><p class="bubble">${a}</p></details>`).join("")
    + `</div><div class="hc-bottom" data-help-bottom hidden><form class="hc-compose" data-help-ask><input name="q" aria-label="Ask a question" placeholder="Ask a question…" autocomplete="off" maxlength="200"><button class="hc-send" type="submit" aria-label="Send" disabled>${SEND}</button></form>`
    + `<p class="hc-foot">Built-in answers: what you type stays on this page.</p></div></div></details></aside>`;
}

