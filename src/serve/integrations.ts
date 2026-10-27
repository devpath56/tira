// The way in to `tira serve` and its Integrations page. Someone who isn't signed in lands on
// /welcome (Continue with GitHub), approves GitHub's code, connects the workspace to a repo and,
// if they use one, a Jira project (/connect), and then sees the board (the pages: welcome.ts).
// /integrations changes those links later: sign in with GitHub, connect Jira, and pick what this
// workspace links to, with buttons and pickers, not commands.
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
// - Access (Isha, 2026-10-25): anyone with GitHub signs up and gives an email (their GitHub
//   profile's, when it shows one); each project is seen only by its own people, whose admins add
//   them by GitHub username in Project settings → Team (src/serve/team.ts). The owner (the first
//   person to sign in, or TIRA_ADMIN) has tira's setup and can remove an account; nothing more.
//
// Every token, key and secret lives only in the private store (src/sync/credentials.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { FoldResult } from "../fold/fold.ts";
import { agentNameProblem } from "../mcp/names.ts";
import { APP_AGENT, APP_NAME, APPS, appSetup, databaseCheck, mcpUrl, TIRA_ENV_FILE, TIRA_SCRIPT, TOKEN_HERE, type App, type AppSetup, type DatabaseCheck, type Launch, type Where } from "../mcp/connect.ts";
import { agentTokensFor, freeName, type AgentToken, type AgentTokens } from "../mcp/tokens.ts";
import { workspaceOf, type WorkspaceLink } from "../fold/workspace.ts";
import { JIRA_PROJECT, REPO, WORKSPACE, WORKSPACE_ID } from "../tables/links.ts";
import { reportLines, sync } from "../sync/sync.ts";
import { GhCli, type GitHubClient } from "../sync/github.ts";
import { JiraCloud, projectName, type JiraClient } from "../sync/jira.ts";
import { access, appKeys, hasSeen, dropInvite, invite, invitesNow, addNote, dropNote, notesFor, saveWake, dropWake, wakesOf, same, atlassianAuth, block, blockedNow, displayName, dropSession, emailOf, forgetGithub, githubAuth, isBlocked, isOwner, knownLogin, markSeen, saveDisplayName, unmarkSeen, saveEmail, saveProject, signOutEverywhere, jiraLogin, saveAccess, saveAppKeys, saveAtlassianAuth, saveGithubAuth, saveSession, unblock, type AtlassianAuth, type JiraLogin, type ProjectPeople } from "../sync/credentials.ts";
import { changeTeam, inProject, isProjectAdmin, type TeamMove } from "./team.ts";
import { INBOX_ICON, letterHtml, noteHtml } from "./invites.ts";
import { routineProblem, WAKE_PROMPT, type Fire } from "./wake.ts";
import type { Reviewer } from "./review.ts";
import { GitHubDevice, type GitHubAuthApi } from "../auth/github.ts";
import { AtlassianOAuth, type AtlassianAuthApi } from "../auth/atlassian.ts";
import type { Dispatcher } from "../write/dispatcher.ts";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { esc } from "../render/escape.ts";
import { brand, CSS, projectMark, nameHtml, SIDE_SHUT, SIDE_TOGGLE, THEME_RADIOS } from "../render/html.ts";
import { codePage, connectPage, emailPage, GITHUB_MARK, jiraTabPage, landingPage, type ConnectOpts } from "./welcome.ts";
import { SIGNIN_CSP } from "./csp.ts";
import type { PublicSite } from "./public.ts";
import { CONNECTOR_APP } from "../mcp/oauth.ts";
import { projectCode } from "../fold/tickets.ts";

export const SESSION_COOKIE = "tira_session";
// Setup's buttons: copy (a tick once copied), and show / hide, as SF Symbols draw them
const COPY = `<svg class="i-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.5v-.3a1.7 1.7 0 0 0-1.7-1.7H4.2a1.7 1.7 0 0 0-1.7 1.7v4.6a1.7 1.7 0 0 0 1.7 1.7h.3"/></svg><svg class="i-done" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

// Settings' icons (Isha, 2026-10-26: a new look, after Linear's, GitHub's and Stripe's settings): one
// per section, in the list on the left and on its header's tile; and each app an agent works in.
const svg24 = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SET_ICON: Record<string, string> = {
  profile: svg24('<circle cx="12" cy="8" r="4"/><path d="M5 20c1.4-3.4 3.8-5 7-5s5.6 1.6 7 5"/>'),
  linked: svg24('<path d="M10 14l4-4"/><path d="M11 7l1.5-1.5a3.5 3.5 0 0 1 5 5L16 12"/><path d="M13 17l-1.5 1.5a3.5 3.5 0 0 1-5-5L8 12"/>'),
  appearance: svg24('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  setup: svg24('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>'),
  accounts: svg24('<circle cx="10" cy="8" r="4"/><path d="M3 20c1.3-3.3 3.7-5 7-5 1.2 0 2.3.2 3.3.7M16 16l4 4M20 16l-4 4"/>'),
  general: svg24('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  team: svg24('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c1-3 3.2-4.5 6-4.5s5 1.5 6 4.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 15.6c1.6.7 2.6 2.1 3 4.4"/>'),
  github: GITHUB_MARK,
  jira: svg24('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 8v8M15 8v4"/>'),
  agents: svg24('<path d="M9 3v4M15 3v4"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v6"/>'),
  delete: svg24('<path d="M12 4 21 20H3z"/><path d="M12 10v4M12 17v.01"/>'),
};
const APP_ICON: Record<App, string> = {
  "claude-code": svg24('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  cursor: svg24('<path d="M6 4l12 7-6 1.5L9.5 19z"/>'),
  vscode: svg24('<path d="M17 3l4 2v14l-4 2L7 12z"/><path d="M17 3v18M3 9l3 3-3 3"/>'),
  "claude-desktop": svg24('<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4 3v-3a2 2 0 0 1-2-2z"/>'),
};
const TRASH = svg24('<path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>');
// a section's header: its icon on a tile, its title, and a line on what it's for
const sectionTop = (id: string, title: string) => {
  const desc = descOf(id);
  const line = desc ? `<p class="grp-desc">${esc(desc)}</p>` : "";
  return `<div class="grp-top"><span class="grp-icon" aria-hidden="true">${SET_ICON[id] ?? ""}</span><div><h2 class="grp-h">${title}</h2>${line}</div></div>`;
};
const EYE = `<svg class="i-show" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg><svg class="i-hide" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 3.7A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4 5.1C2.4 6.3 1.5 8 1.5 8S3.9 12.5 8 12.5c1.2 0 2.2-.4 3.1-.9M6.6 6.6a2 2 0 0 0 2.8 2.8M2 2l12 12"/></svg>`;

// a direct GitHub sign-in under way, in the browser that started it (integrations.ts: signinStart)
const SIGNIN_COOKIE = "tira_signin";
// where a sign-in goes on to when it started from somewhere that needs one: Claude's connection,
// waiting to be approved (src/mcp/oauth.ts). Only that page's own address is taken.
export const NEXT_COOKIE = "tira_next";
const NEXT = /^\/oauth\/authorize\?[^\s"'<>\\]{1,2000}$/;
const nextOf = (req: IncomingMessage): string | undefined => {
  let v = cookieOf(req, NEXT_COOKIE) ?? "";
  try {
    v = decodeURIComponent(v);
  } catch {
    return undefined;
  }
  return NEXT.test(v) ? v : undefined;
};

type Env = Record<string, string | undefined>;
type Flash = { ok: boolean; text: string; wait?: boolean }; // wait: not yet, and nothing wrong (Test connection)

export interface Outside {
  jira?: (site: string, login: JiraLogin) => JiraClient; // an API-token login (tira connect-jira)
  github?: GitHubClient; // pull requests, instead of the person's own token or gh
  githubAuth?: GitHubAuthApi;
  atlassian?: AtlassianAuthApi;
  env?: Env;
  envFile?: string; // tira's own .env, which tira mcp reads (Project settings → Connect agents checks it); default: this tira's
  agentTokens?: AgentTokens; // agents' tokens; default: tira's Postgres database's
  fireRoutine?: Fire; // starts an agent's Claude Code routine (wake.ts); default: the real call
  reviewer?: Reviewer; // reviews work before it's done (review.ts); default: Muse, when its key is set
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
  titleOf?: (stream: string) => Promise<string>; // a project's name as people see it (renamed in Project settings)
  send: (res: ServerResponse, status: number, type: string, body: string, extra?: Record<string, string>) => void;
  formOf: (req: IncomingMessage, res: ServerResponse, host: string) => Promise<URLSearchParams | undefined>;
  flash: (f: Flash) => string; // keeps it once, returns its key
  takeFlash: (key: string) => Flash | undefined;
  site?: PublicSite; // the public https address tira is reached at (src/serve/public.ts)
  people: (stream: string) => Promise<ProjectPeople>; // a project's people (src/serve/team.ts)
  projectsOf: (login: string) => Promise<MyProject[]>; // the live projects someone is in
}
// a project someone is in, for their list (GET /projects)
export interface MyProject { stream: string; title?: string; href: string; admin: boolean; tasks: number; open: number }

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
  if (login && !isBlocked(login, env)) return { login, actor: login, signInOn }; // removed since: no one
  return signInOn || fallback === undefined ? { signInOn } : { actor: fallback, signInOn };
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const EMAIL = /^[^\s@<>"']{1,64}@(?:[^\s@<>"'.]+\.)+[^\s@<>"'.]{2,}$/; // dot-free parts: linear, nothing to backtrack over
const NAME = /^[^\u0000-\u001f\u007f<>]{1,60}$/;

// where a form may send its person back to (never an address it names itself)
const BACKS = new Set(["/welcome", "/connect", "/integrations", "/settings", "/projects/new", "/signup/email"]);
export const backOf = (v: string | null | undefined, fallback = "/integrations"): string => (v && BACKS.has(v) ? v : fallback);
const portOf = (host: string) => host.replace(/^[^:]*:?/, "") || "4747";

// Where a person's Jira stands, for a page that offers it (the connect step, the New project page)
export type JiraState = ConnectOpts["jira"];

// A person's accounts, for any page that offers them: their GitHub (pull requests, their repos)
// and their Jira (their Atlassian sign-in or, failing that, an API-token login for the site).
// site: tira's public address, which Atlassian can send people back to as it does localhost.
export function accounts(outside: Outside | undefined, site?: PublicSite) {
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
    if (!a) return site || /^localhost(:\d+)?$/.test(host) ? { state: "disconnected" } : { state: "elsewhere", localhost: `http://localhost:${portOf(host)}${back}` };
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
  const acc = accounts(c.outside, c.site);
  const { env, gh, at, jiraOf, githubOf } = acc;
  // a sign-in under way carries what it is: a sign-up (welcomed as such), and whether its browser is to be remembered
  type Way = { signup: boolean; remember: boolean };
  const pendingSignIns = new Map<string, { deviceCode: string; userCode: string; verifyAt: string; interval: number; until: number } & Way>();
  const pendingJira = new Map<string, { login: string; until: number; back: string; tab: boolean }>();
  const pendingGithub = new Map<string, { until: number; w: string | null } & Way>(); // the direct way's sign-ins under way, by state: until when, the project it left from, and what it is
  // back to a page (and the section of it, #…), with a result shown there once
  const back = (res: ServerResponse, to: string, f?: Flash) => {
    const at = to.indexOf("#");
    const [path, section] = at < 0 ? [to, ""] : [to.slice(0, at), to.slice(at)];
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: f ? `${path}?r=${c.flash(f)}${section}` : to });
  };
  // where GitHub and Atlassian send people back to: the public address, else the one the page was opened at
  const own = (host: string) => (c.site ? c.site.origin : `http://${host}`);
  // where the Help centre's steps point GitHub and Atlassian back to: a hosted tira's own address, else
  // localhost (Jira connects only there on a computer)
  const helpAt = (host: string): HelpAt => (c.site ? { address: c.site.origin, hosted: true } : { address: `http://localhost:${portOf(host)}`, hosted: false });
  const redirectUri = (host: string) => `${own(host)}/integrations/jira/callback`;
  const githubBack = (host: string) => `${own(host)}/signin/github/callback`;


  // who may see and change tira's own apps: its owner, once GitHub sign-in is on; before that,
  // whoever runs this tira (there is no one else to ask). At a public address, only its owner.
  const mayChangeApps = (login: string | undefined) => (c.site || appKeys(env).github ? !!login && isOwner(access(env), login) : true);
  // whether someone may change this project (its name, links, team, deleting it): its admins, once
  // people sign in; before that, whoever runs this tira
  const adminHere = async (login: string | undefined) => !login || isProjectAdmin(await c.people(c.stream), login);
  const NOT_ADMIN = "Only this project's admins can change that.";

  // the step after signing in: your projects, when this one isn't yours; else connect a repo while
  // the project has none, else its board
  const nextStep = async (login: string | undefined): Promise<string> => {
    if (login && !inProject(await c.people(c.stream), login)) return "/projects";
    return login && !workspaceOf((await c.now()).r, c.stream)?.repo ? "/connect" : "/";
  };

  // ---------- the landing ----------
  const welcome = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (me.actor) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: await nextStep(me.login) });
    const flash = c.takeFlash(url.searchParams.get("r") ?? "");
    c.send(res, 200, html, landingPage({ token: c.token, githubReady: !!appKeys(env).github, port: portOf(host), ...(flash ? { flash } : {}) }), { "Content-Security-Policy": SIGNIN_CSP });
  };

  // ---------- sign in with GitHub ----------
  const signinPage = (res: ServerResponse, id: string, p: { userCode: string; verifyAt: string; interval: number }, note?: string) =>
    c.send(res, 200, html, codePage({ token: c.token, id, userCode: p.userCode, verifyAt: p.verifyAt, interval: p.interval, ...(note ? { note } : {}) }));

  const signinStart = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const clientId = appKeys(env).github?.clientId;
    if (!clientId) return back(res, "/welcome", { ok: false, text: "GitHub sign-in isn't set up yet: add tira's GitHub app first." });
    // Sign up (someone new, welcomed as such) or Log in; and Remember this browser, ticked or not
    const way: Way = { signup: form.get("signup") === "1", remember: form.get("remember") === "1" };
    // the direct way, once tira's app has its secret: off to GitHub's page and straight back, at
    // localhost (where tira's GitHub app sends people back to). The state rides in a cookie too, so
    // only the browser that started a sign-in can finish it.
    const secret = appKeys(env).github?.secret;
    if (secret && (c.site || /^localhost(:\d+)?$/.test(host))) {
      const now = Date.now();
      for (const [s, p] of pendingGithub) if (p.until < now) pendingGithub.delete(s);
      const state = randomBytes(24).toString("hex");
      pendingGithub.set(state, { until: now + 10 * 60_000, w: url.searchParams.get("w"), ...way });
      return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: gh.authorizeUrl(clientId, githubBack(host), state, way.signup), "Set-Cookie": `${SIGNIN_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/signin; Max-Age=600` });
    }
    try {
      const s = await gh.start(clientId);
      const id = randomBytes(16).toString("hex");
      pendingSignIns.set(id, { deviceCode: s.deviceCode, userCode: s.userCode, verifyAt: s.verifyAt, interval: s.interval, until: Date.now() + s.expiresIn * 1000, ...way });
      // the code at its own address, so Back from GitHub (when it opened in this tab) or a reload comes back to it
      c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/signin/code?id=${id}` });
    } catch (err) {
      back(res, "/welcome", { ok: false, text: `GitHub sign-in didn't start (${(err as Error).message}).` });
    }
  };

  // GitHub's code to approve, at its own address: the page waits there, and goes on in once it's approved
  const signinCode = (_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const id = url.searchParams.get("id") ?? "";
    const p = pendingSignIns.get(id);
    if (!p || p.until < Date.now()) back(res, "/welcome", { ok: false, text: "That sign-in expired: start again." });
    else signinPage(res, id, p);
    return Promise.resolve();
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
      await enter(res, await gh.exchange(keys.clientId, keys.secret, url.searchParams.get("code") ?? "", githubBack(host)), false, nextOf(req), p);
    } catch (err) {
      back(res, "/welcome", { ok: false, text: `GitHub sign-in stopped (${(err as Error).message}).` });
    }
  };

  // In, with GitHub's token (either way): anyone with GitHub, but an account the owner removed (Isha,
  // 2026-10-25). The first person in becomes the owner. tira keeps the email their GitHub profile
  // shows, if it shows one; else they're asked for one before anything else (GET /signup/email).
  // fragment: signin.mjs asked, and goes where the answer says. next: where it started from, if anywhere.
  // way: a sign-up or not, and whether this browser is remembered: then the sign-in lasts 30 days,
  // else its cookie ends with the browser, and tira takes it for 12 hours at most (Isha, 2026-10-26).
  const enter = async (res: ServerResponse, token: string, fragment: boolean, next: string | undefined, way: Way) => {
    const me = await gh.user(token);
    const turnBack = (text: string) => {
      const key = c.flash({ ok: false, text });
      return fragment ? c.send(res, 200, html, `<div data-go="/welcome?r=${key}"></div>`) : back(res, "/welcome", c.takeFlash(key));
    };
    if (isBlocked(me.login, env)) return turnBack(`${me.login} can't sign in to this tira: its owner removed this account.`);
    // Sign up is for someone new, Log in for an account tira already has (it signed in here before,
    // or gave its email): the other way round is told which to use, and nothing changes (Isha, 2026-10-26)
    const known = knownLogin(me.login, env) !== undefined || emailOf(me.login, env) !== undefined;
    if (way.signup && known) return turnBack(`${me.login} already has a tira account: log in instead.`);
    if (!way.signup && !known) return turnBack(`${me.login} doesn't have a tira account yet: sign up first.`);
    const first = access(env).admin === undefined;
    if (first) await saveAccess((x) => (x.admin === undefined ? { ...x, admin: me.login } : x), env); // the first one in, even if two arrive at once
    await saveGithubAuth(me.login, { token, ...(me.name ? { name: me.name } : {}) }, env);
    if (!emailOf(me.login, env) && me.email && EMAIL.test(me.email)) await saveEmail(me.login, me.email, env);
    const session = randomBytes(32).toString("hex");
    await saveSession(session, me.login, env, way.remember);
    const cookie = `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/${way.remember ? "; Max-Age=2592000" : ""}`;
    const welcomed = way.signup ? `Welcome to tira, ${me.login}: make your first project, or open one someone added you to.` : `Signed in as ${me.login}. tira records your changes as ${me.login}.`;
    const key = c.flash({ ok: true, text: first ? `Signed in as ${me.login}: you're this tira's owner (its setup, and removing an account if you ever need to).` : welcomed });
    const go = next ?? `${await nextStep(me.login)}?r=${key}`;
    if (fragment) return c.send(res, 200, html, `<div data-go="${esc(go)}"></div>`, { "Set-Cookie": cookie });
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: go, "Set-Cookie": cookie });
  };

  // ---------- the email step: once, before anything else, for someone tira has no email for ----------
  const emailGet = (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const login = who(req).login;
    if (!login) return Promise.resolve(c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/welcome" }));
    if (emailOf(login, env)) return Promise.resolve(c.send(res, 303, "text/plain; charset=utf-8", "", { Location: nextOf(req) ?? "/" }));
    const flash = c.takeFlash(url.searchParams.get("r") ?? "");
    c.send(res, 200, html, emailPage({ token: c.token, login, ...(flash ? { flash } : {}) }), { "Content-Security-Policy": SIGNIN_CSP });
    return Promise.resolve();
  };
  const emailPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const back2 = backOf(form.get("back"), "/signup/email");
    if (!login) return back(res, "/welcome", { ok: false, text: "Sign in with GitHub first." });
    const email = (form.get("email") ?? "").trim();
    const fragment = form.get("fragment") === "1";
    const to = back2 === "/settings" ? "/settings#profile" : back2;
    if (!EMAIL.test(email)) return fragment ? c.send(res, 400, "text/plain; charset=utf-8", "That isn't an email address.") : back(res, to, { ok: false, text: "That isn't an email address." });
    await saveEmail(login, email, env);
    if (fragment) return c.send(res, 200, "text/plain; charset=utf-8", `Your email is ${email} now.`);
    if (back2 === "/settings") return back(res, "/settings#profile", { ok: true, text: `Your email is ${email} now.` });
    const done = c.flash({ ok: true, text: `Thanks, ${login}: you're all set.` });
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: nextOf(req) ?? `${await nextStep(login)}?r=${done}` });
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
      await enter(res, got.token, fragment, nextOf(req), p);
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
  // and control, a footnote at most), reached from the nav on the left: buttons and pickers, no
  // commands (Isha, 2026-10-26). Account settings are yours, in every project; Project settings are
  // the project's own.
  const hidden = () => `<input type="hidden" name="token" value="${esc(c.token)}">`;
  const row = (k: string, v: string) => `<div class="grp-row"><span class="grp-k">${k}</span>${v}</div>`;
  const group = (id: string, title: string, rows: string, foot = "") => {
    const footer = foot ? `<div class="grp-foot">${foot}</div>` : "";
    return `<section class="grp" id="${id}" data-int="${id}">${sectionTop(id, title)}<div class="grp-list">${rows}</div>${footer}</section>`;
  };
  const problem = (text: string) => (text ? `<div class="grp-row"><span class="grp-k no">${esc(text)}</span></div>` : "");
  const flashKind = (f: Flash) => {
    if (f.wait) return "wait";
    return f.ok ? "ok" : "no";
  };
  const flashLine = (f: Flash) => `<div class="flash ${flashKind(f)}" role="status" data-flash>${esc(f.text)}</div>`;
  const flashOf = (url: URL) => {
    const f = c.takeFlash(url.searchParams.get("r") ?? "");
    return f ? flashLine(f) : "";
  };
  const scripts = `<script type="module" src="/tabs.mjs"></script><script type="module" src="/help.mjs"></script><script type="module" src="/secrets.mjs"></script><script type="module" src="/agents.mjs"></script><script type="module" src="/sections.mjs"></script><script type="module" src="/autosave.mjs"></script><script type="module" src="/forms.mjs"></script><script type="module" src="/cplay.mjs"></script>`;
  const signedOut = (res: ServerResponse, url: URL) => c.send(res, 303, "text/plain; charset=utf-8", "", { Location: `/welcome${url.search}` }); // a result goes along

  // Account settings (GET /settings): who you are (your email, the username people add you by), your
  // GitHub and Jira, how tira looks, tira's own apps and, for its owner, removed accounts.
  type Keys = ReturnType<typeof appKeys>;
  const initial = (name: string) => esc(([...name][0] ?? "?").toUpperCase());
  const ownerPill = (login: string) => (isOwner(access(env), login) ? `<span class="pill">Owner</span>` : "");

  // you (someone who isn't signed in is sent to the landing, unless tira serve acts as its own name),
  // shown by the name you chose (else GitHub's, else your login); your changes stay under your login
  const profileCard = (login: string | undefined, actor: string, shown: string, t: string) => {
    if (!login) {
      return `<div class="profile" data-profile-card><span class="av av-lg">${initial(shown)}</span><span class="pf-who"><b>${esc(shown)}</b><span>the name tira serve was started with</span></span></div>`
        + row("Working as", `<span class="grp-v">${esc(actor)}</span>`);
    }
    return `<div class="profile" data-profile-card><span class="av av-lg">${initial(shown)}</span><span class="pf-who"><b>${esc(shown)}</b><span>@${esc(login)} · signed in with GitHub</span></span>${ownerPill(login)}`
      + `<form method="post" action="/signout" class="pf-out">${t}<button class="act" type="submit">Sign out</button></form></div>`;
  };

  // GitHub: who you're signed in as, with its action on its own row
  const githubAccountRow = (login: string | undefined, keys: Keys, t: string) => {
    if (login) return `<form method="post" action="/integrations/github/disconnect" class="grp-row" data-disconnect-github>${t}<span class="grp-k">GitHub</span><span class="grp-v">@${esc(login)}</span><button class="how" type="submit">Disconnect</button></form>`;
    return row("GitHub", `<span class="grp-v">${keys.github ? "Not signed in" : "Not set up: add tira's GitHub app under Setup"}</span>`);
  };

  // Jira: sign in, pick a site, disconnect
  const siteOption = (x: { id: string; name: string }, cloudId: string | undefined) => `<option value="${esc(x.id)}"${x.id === cloudId ? " selected" : ""}>${esc(x.name)}</option>`;
  const jiraAccountRow = async (login: string | undefined, keys: Keys, host: string, t: string): Promise<string> => {
    if (!login) return row("Jira", `<span class="grp-v">${keys.atlassian ? "Sign in with GitHub first" : "Not set up: add tira's Atlassian app under Setup"}</span>`);
    const offJira = mayChangeApps(login) ? "Not set up: add tira's Atlassian app under Setup" : "Not available on this tira yet";
    const j = await acc.jira(login, host, "/settings");
    if (j.state === "unset") return row("Jira", `<span class="grp-v">${offJira}</span>`);
    if (j.state === "elsewhere") return row("Jira", `<a class="how" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`);
    if (j.state === "disconnected") return row("Jira", `<a class="act primary" href="${esc("/integrations/jira/connect?back=/settings&tab=1")}" target="_blank" rel="noopener" data-connect-jira>Sign in to Jira</a>`);
    const disconnect = `<form method="post" action="/integrations/jira/disconnect" class="grp-row" data-disconnect-jira>${t}<span class="grp-k">Jira</span>`;
    const off = `<button class="how" type="submit">Disconnect</button></form>`;
    if (j.sites.length > 1) {
      const options = j.sites.map((x) => siteOption(x, j.cloudId)).join("");
      return `<form method="post" action="/integrations/jira/site" class="grp-row">${t}<input type="hidden" name="back" value="/settings"><span class="grp-k">Jira site</span><select name="site" aria-label="Jira site">${options}</select><button class="act" type="submit">Use</button></form>`
        + disconnect + off;
    }
    const site = j.site ? esc(j.site.replace(/^https:\/\//, "")) : "Connected";
    return disconnect + `<span class="grp-v">${site}</span>` + off;
  };

  // how tira looks, in this browser (the theme's radios are at the top of every page)
  const LOOKS: [string, string, string][] = [["system", "System", "Follows your computer"], ["light", "Light", "Always light"], ["dark", "Dark", "Always dark"]];
  const lookOption = ([v, label, said]: [string, string, string]) => `<label for="th-${v}" class="look look-${v}"><span class="look-pic" aria-hidden="true"><i></i><i></i><i></i></span><b>${label}</b><small>${said}</small></label>`;
  const appearanceGroup = () => `<section class="grp" id="appearance" data-int="appearance">${sectionTop("appearance", "Appearance")}`
    + `<div class="appear" data-theme-switch>${LOOKS.map(lookOption).join("")}</div></section>`;

  // someone's initial on a tint of its own (the same name, the same tint)
  const avatar = (who2: string) => {
    const tint = [...who2.toLowerCase()].reduce((n, ch) => n + (ch.codePointAt(0) ?? 0), 0) % 4;
    return `<span class="av t${tint}" aria-hidden="true">${esc(who2.slice(0, 1).toUpperCase())}</span>`;
  };
  // someone's role, as a picker that saves when changed (forms.mjs; a Change button with no script)
  const rolePicker = (t: string, login: string, admin: boolean) =>
    `<form method="post" action="/integrations/people" class="inline" data-autosubmit>${t}<input type="hidden" name="login" value="${esc(login)}"><select name="do" class="role" aria-label="Role of ${esc(login)}">`
    + `<option value="admin"${admin ? " selected" : ""}>Admin</option><option value="member"${admin ? "" : " selected"}>Member</option></select><noscript><button class="how" type="submit">Change</button></noscript></form>`;
  // taking someone off the project, asked first (forms.mjs)
  const removeButton = (t: string, login: string, project: string) => {
    const ask = esc(`Remove ${login} from ${project}? They won't see it any more, and their agents here stop.`);
    return `<form method="post" action="/integrations/people" class="inline" data-confirm="${ask}">${t}<input type="hidden" name="do" value="remove"><input type="hidden" name="login" value="${esc(login)}"><button class="team-del" type="submit" aria-label="Remove ${esc(login)}" title="Remove" data-team-remove>${TRASH}</button></form>`;
  };
  // collaborators (Isha, 2026-10-25; named after GitHub's, 2026-10-26): this project's admins and
  // members, who alone see it, and the agents connected to it. Its admins add people by GitHub
  // username, pick each one's role, and remove them; everyone else sees who to ask. Your own row
  // has no Remove, and no role picker while you're the only admin: a project always has one.
  const teamGroup = async (login: string | undefined, t: string, project: string) => {
    const p = await c.people(c.stream);
    const mayChange = !!login && isProjectAdmin(p, login);
    const joined = (who2: string) => (knownLogin(who2, env) ? "" : `<small class="grp-sub">Not signed up yet</small>`);
    const person = (who2: string, admin: boolean) => {
      const yours = login?.toLowerCase() === who2.toLowerCase();
      const you = yours ? " (you)" : "";
      const fixed = `<span class="pill">${admin ? "Admin" : "Member"}</span>`;
      const mayRole = mayChange && !(yours && admin && p.admins.length === 1);
      const acts = (mayRole ? rolePicker(t, who2, admin) : fixed) + (mayChange && !yours ? removeButton(t, who2, project) : "");
      return `<div class="grp-row team-row" data-team-${admin ? "admin" : "member"}>${avatar(who2)}<span class="grp-k">${esc(who2)}${you}${joined(who2)}</span>${acts}</div>`;
    };
    const people = p.admins.map((x) => person(x, true)).join("") + p.members.map((x) => person(x, false)).join("");
    // invited, not answered yet (Isha, 2026-10-26): they see it once they accept; an admin can take it back
    const takeBack = (x: string) => `<form method="post" action="/integrations/people" class="inline" data-confirm="Take back the invite to ${esc(x)}?">${t}<input type="hidden" name="do" value="uninvite"><input type="hidden" name="login" value="${esc(x)}"><button class="team-del" type="submit" aria-label="Take back the invite to ${esc(x)}" title="Take back the invite" data-team-uninvite>${TRASH}</button></form>`;
    const invited = invitesNow(env).filter((x) => x.stream === c.stream).map((x) => `<div class="grp-row team-row" data-team-invited>${avatar(x.login)}<span class="grp-k">${esc(x.login)}<small class="grp-sub">Invited by ${esc(x.by)}${knownLogin(x.login, env) ? "" : " · not signed up yet"}</small></span><span class="pill">Invited</span>${mayChange ? takeBack(x.login) : ""}</div>`).join("");
    // agents: when each last called tira, and whether that's lately (a day)
    const agentLine = (x: AgentToken) => {
      const lately = !!x.lastUsedAt && Date.now() - Date.parse(x.lastUsedAt) < 86_400_000;
      const when = x.lastUsedAt ? `last call ${ago(x.lastUsedAt)}` : "no call yet";
      return `<div class="grp-row team-row" data-team-agent><span class="av av-agent" aria-hidden="true">${SET_ICON.agents}</span><span class="grp-k">${esc(x.agent)}<small class="grp-sub">Agent · ${when}</small></span><span class="live${lately ? " on" : ""}">${lately ? "Active" : "Idle"}</span></div>`;
    };
    const agents = ((await tokensNow()?.list(c.stream)) ?? []).map(agentLine).join("");
    const add = mayChange
      ? `<form method="post" action="/integrations/people" class="grp-row team-add" data-team-add>${t}<input type="hidden" name="do" value="add"><span class="grp-k">Invite collaborators</span><input type="text" name="login" aria-label="Invite collaborators by GitHub username" autocomplete="off" spellcheck="false" placeholder="GitHub username" required><button class="act primary" type="submit">Invite</button></form>`
      : "";
    const foot = mayChange
      ? "Admins also manage collaborators and settings; members work on tasks. An invite arrives as a letter in their Inbox; they see this project once they accept. Someone's username is on their profile in Account settings."
      : `Only this project's admins add or remove collaborators: ask ${p.admins.join(", ") || "one of them"}.`;
    return `<section class="grp" id="team" data-int="team">${sectionTop("team", "Collaborators")}<div class="grp-list" data-team>${people}${invited}${agents}${add}</div><div class="grp-foot">${esc(foot)}</div></section>`;
  };
  // removed accounts, for this tira's owner: remove one (signed out, can't sign in, their agents
  // stop), or let one back in. Nobody's projects show here.
  const accountsGroup = (login: string | undefined, t: string) => {
    if (!login || !isOwner(access(env), login)) return "";
    const removed = blockedNow(env).map((b) => `<form method="post" action="/integrations/accounts" class="grp-row" data-removed-account>${t}<input type="hidden" name="do" value="unblock"><input type="hidden" name="login" value="${esc(b)}"><span class="grp-k">${esc(b)}</span><span class="grp-v">Removed</span><button class="how" type="submit">Let back in</button></form>`).join("");
    return `<section class="grp" id="accounts" data-int="accounts">${sectionTop("accounts", "Removed accounts")}<div class="grp-list" data-accounts>${removed}`
      + `<form method="post" action="/integrations/accounts" class="grp-row" data-remove-account>${t}<input type="hidden" name="do" value="block"><input type="text" name="login" aria-label="GitHub username" autocomplete="off" spellcheck="false" placeholder="GitHub username" required><button class="act danger" type="submit">Remove account</button></form>`
      + `</div><div class="grp-foot">Only you, this tira's owner, see this.</div></section>`;
  };

  // setup: tira's own apps, as Render shows environment secrets, on the page only for the owner
  // (or, before GitHub sign-in is on, whoever runs this tira): each value as dots, with an eye to
  // show it and a copy button, each fetching that one value when pressed (secrets.mjs), so no key is
  // ever in the page. Edit swaps the list for the form (a checkbox, so it works with no script),
  // where an empty field keeps what's saved; straight to the form while nothing is set.
  const setupGroup = (keys: Keys, t: string) => {
    const envKeys: [string, string, string | undefined][] = [["github_client_id", "GitHub Client ID", keys.github?.clientId], ["github_secret", "GitHub Secret", keys.github?.secret], ["atlassian_client_id", "Atlassian Client ID", keys.atlassian?.clientId], ["atlassian_secret", "Atlassian Secret", keys.atlassian?.secret]];
    const envButtons = (label: string) => `<button type="button" class="env-btn" data-env-copy title="Copy" aria-label="Copy ${label}">${COPY}</button><button type="button" class="env-btn" data-env-show title="Show" aria-label="Show ${label}" aria-pressed="false">${EYE}</button>`;
    const envRow = ([k, label, v]: [string, string, string | undefined]) => {
      let value = `<span class="env-v none">Not set</span>`;
      if (v) value = `<span class="env-v" data-env-value>${"•".repeat(12)}</span>` + envButtons(label);
      return `<div class="grp-row env-row" data-env="${k}"><span class="grp-k">${label}</span>${value}</div>`;
    };
    const envPlaceholder = (k: string, v: string | undefined) => {
      if (v) return "Saved: leave empty to keep";
      return k === "github_secret" ? "Optional: sign in in one click" : "Not set";
    };
    const envField = ([k, label, v]: [string, string, string | undefined]) => `<label class="grp-row"><span class="grp-k">${label}</span><input type="${k.endsWith("secret") ? "password" : "text"}" name="${k}" value="" autocomplete="off" spellcheck="false" placeholder="${envPlaceholder(k, v)}"></label>`;
    const editFirst = !keys.github && !keys.atlassian ? " checked" : ""; // nothing set yet: straight to the form
    const editButton = `<label class="act" for="setup-edit" data-env-edit>Edit</label>`;
    return `<section class="grp" id="setup" data-int="setup">${sectionTop("setup", "Setup")}`
      + `<input class="view-radio" type="checkbox" id="setup-edit" aria-label="Edit tira's apps"${editFirst}>`
      + `<div class="grp-list env-list" data-env-list><div class="grp-row env-head"><span class="grp-k">Key</span><span class="env-v">Value</span>${editButton}</div>${envKeys.map(envRow).join("")}</div>`
      + `<form method="post" action="/integrations/setup" class="grp-list env-edit" data-setup-form>${t}<input type="hidden" name="back" value="/settings">${envKeys.map(envField).join("")}`
      + `<div class="grp-row env-acts"><label class="how" for="setup-edit">Cancel</label><button class="act primary" type="submit">Save</button></div></form>`
      + `<div class="grp-foot">Kept privately and sealed, never in the page: Show and Copy fetch one value when you press them. How to make these apps: ask the Help centre.</div></section>`;
  };

  const profile = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url); // yours: sign in first
    const keys = appKeys(env);
    const ghAuth = me.login ? githubAuth(me.login, env) : undefined;
    const t = hidden();
    const chosen = displayName(me.actor, env);
    const fallbackName = me.login ? ghAuth?.name ?? me.login : me.actor;
    const shown = chosen ?? fallbackName;
    // saved as you type (autosave.mjs; Isha, 2026-10-26); with no script, Enter saves
    const nameRow = `<form method="post" action="/integrations/profile" class="grp-row" data-display-name data-autosave>${t}<span class="grp-k">Display name</span><input type="text" name="name" value="${esc(chosen ?? "")}" maxlength="60" autocomplete="off" placeholder="${esc(fallbackName)}" aria-label="Display name"><span class="save-state" data-save-state aria-live="polite"></span></form>`;
    // your email (never shown to anyone else), and the username a project's admin adds you by, with
    // your profile's address to send them
    const yours = me.login === undefined ? "" : `<form method="post" action="/signup/email" class="grp-row" data-email data-autosave>${t}<input type="hidden" name="back" value="/settings"><span class="grp-k">Email</span><input type="email" name="email" value="${esc(emailOf(me.login, env) ?? "")}" required maxlength="200" autocomplete="email" aria-label="Email"><span class="save-state" data-save-state aria-live="polite"></span></form>`
      + `<div class="grp-row" data-username><span class="grp-k">Username</span><code class="grp-v" id="my-username">${esc(me.login)}</code>${copyButton("my-username", "your username")}<a class="how" href="/u/${esc(encodeURIComponent(me.login))}">Profile</a></div>`;
    // one section at a time (Isha, 2026-10-26, after Chrome's): who you are; the GitHub and Jira tira
    // uses for you; how tira looks; and, for this tira's owner alone, its own apps and removed accounts
    const profileGroup = group("profile", "Profile", profileCard(me.login, me.actor, shown, t) + nameRow + yours, me.login
      ? "Your changes are recorded under your GitHub login; the display name is only how you're shown. Only you see your email. To be added to a project, send its admin your username."
      : "");
    const linked = group("linked", "GitHub and Jira", githubAccountRow(me.login, keys, t) + await jiraAccountRow(me.login, keys, host, t), me.login ? "They stay linked until you disconnect them here." : "GitHub sign-in isn't set up. Add it under Setup.");
    const setup = mayChangeApps(me.login) ? setupGroup(keys, t) : "";
    const removed = accountsGroup(me.login, t);
    const body = `<header class="int-head"><h1>Account settings</h1><p>Yours, in every project on this tira.</p></header>` + flashOf(url) + profileGroup + linked + appearanceGroup() + setup + removed;
    const admin: Section[] = [...(setup ? [["setup", "Setup"] as Section] : []), ...(removed ? [["accounts", "Removed accounts"] as Section] : [])];
    const sections: Section[] = [["", "Account"], ["profile", "Profile"], ["linked", "GitHub and Jira", me.login && githubAuth(me.login, env) ? "on" : ""], ["appearance", "Appearance"], ...(admin.length > 0 ? [["", "This tira"] as Section, ...admin] : [])];
    c.send(res, 200, html, settingsPage({ title: "Account settings", label: "Account settings", sections }, body, helpPanel(helpAt(host), shown), scripts));
  };

  // A person's profile (GET /u/<username>), for anyone signed in: who they are, and the username a
  // project's admin adds them by, to copy. Never their email.
  const personPage = (req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> => {
    showPerson(req, res, url, host);
    return Promise.resolve();
  };
  const showPerson = (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url);
    let said = "";
    try {
      said = decodeURIComponent(url.pathname.slice("/u/".length));
    } catch {
      said = "";
    }
    const asked = (GITHUB_LOGIN.test(said) ? knownLogin(said, env) : undefined) ?? said; // as GitHub spells it
    const gh2 = GITHUB_LOGIN.test(asked) ? githubAuth(asked, env) : undefined;
    if (!gh2) return c.send(res, 404, html, settingsPage({ title: "Profile", label: "Profile", sections: [] }, `<header class="int-head"><h1>No one here by that name</h1><p>No one called ${esc(asked)} has signed up to this tira yet.</p></header>`, helpPanel(helpAt(host), me.actor), scripts));
    const shown = displayName(asked, env) ?? gh2.name ?? asked;
    const card = `<div class="profile" data-person-card><span class="av av-lg">${initial(shown)}</span><span class="pf-who"><b>${esc(shown)}</b><span>@${esc(asked)} · on tira</span></span>${ownerPill(asked)}</div>`
      + `<div class="grp-row" data-username><span class="grp-k">Username</span><code class="grp-v" id="their-username">${esc(asked)}</code>${copyButton("their-username", "the username")}</div>`;
    const body = `<header class="int-head"><h1>${esc(shown)}</h1><p>A person on this tira.</p></header>` + group("person", "Profile", card, "A project's admin adds them by this username, in Project settings → Team.");
    c.send(res, 200, html, settingsPage({ title: `${shown} · Profile`, label: "Profile", sections: [["person", "Profile"]] }, body, helpPanel(helpAt(host), me.actor), scripts));
  };

  // Your projects (GET /projects): every project you're in, with whether you're its admin; where
  // someone lands who isn't in the project tira opened on (new: make your first one).
  const projectsPage = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url);
    if (!me.login) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/" }); // no sign-in: one project, everyone's
    const mine = await c.projectsOf(me.login);
    const item = (p: MyProject) => {
      const shown = p.title ?? p.stream;
      const counts = p.tasks === 0 ? "No tasks yet" : `${p.open} open of ${p.tasks}`;
      const pill = p.admin ? `<span class="pill">Admin</span>` : "";
      return `<a class="grp-row" href="${esc(p.href)}" data-my-project="${esc(p.stream)}"><span class="grp-k">${projectMark(p.stream, shown)}${esc(shown)}</span><span class="grp-v">${counts}</span>${pill}</a>`;
    };
    const none = `<div class="grp-row" data-no-projects><span class="grp-k">You're not in any project yet</span><a class="act primary" href="/projects/new">Make your first project</a></div>`;
    const list = mine.length === 0 ? none : mine.map(item).join("") + `<div class="grp-row"><span class="grp-k"></span><a class="act primary" href="/projects/new">New project</a></div>`;
    const letters = await lettersFor(me.login); // invites first: a project to join may be all there is
    const body = `<header class="int-head"><h1>Your projects</h1><p>Only a project's people see it. You're the admin of the ones you make; to join someone else's, they invite you, and the invite arrives here and in your Inbox.</p></header>`
      + flashOf(url) + (letters ? `<div class="letters" data-invites>${letters}</div>` : "") + `<section class="grp" id="projects" data-int="projects"><div class="grp-list" data-projects>${list}</div></section>`;
    c.send(res, 200, html, settingsPage({ title: "Your projects", label: "Projects", sections: [["projects", "Your projects"]] }, body, helpPanel(helpAt(host), displayName(me.login, env) ?? me.login), scripts));
  };

  // ---------- invites (Isha, 2026-10-26): the Inbox, and an answer to one ----------
  const titleOf = async (stream: string) => (c.titleOf ? c.titleOf(stream) : workspaceOf((await c.now()).r, stream)?.title ?? stream);
  // someone's invites, as letters (seen here: no letter over the page for them later)
  const lettersFor = async (login: string) => {
    const mine = invitesNow(env).filter((x) => same(x.login, login));
    const titles = await Promise.all(mine.map((x) => titleOf(x.stream)));
    await Promise.all(mine.filter((x) => !hasSeen(login, `invite:${x.stream}`, env)).map((x) => markSeen(login, `invite:${x.stream}`, env)));
    const letters = mine.map((x, i) => letterHtml(x, titles[i] ?? x.stream, c.token)).join("");
    // then the answers to the invites you sent, newest first
    const notes = notesFor(login, env).reverse(); // a copy: notesFor filters
    const named = await Promise.all(notes.map((n) => titleOf(n.stream)));
    const boardOf = (stream: string) => (stream === c.home ? "/" : `/?w=${encodeURIComponent(stream)}`);
    return letters + notes.map((n, i) => noteHtml(n, named[i] ?? n.stream, c.token, boardOf(n.stream))).join("");
  };
  const inboxPage = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url);
    if (!me.login) return c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/" });
    const letters = await lettersFor(me.login);
    const empty = `<div class="inbox-empty" data-inbox-empty><span class="inbox-empty-i">${INBOX_ICON}</span><b>Nothing new</b><p>When someone invites you to a project, or answers your invite, it arrives here.</p></div>`;
    const body = `<header class="int-head"><h1>Inbox</h1><p>Invites to projects, until you answer them, and the answers to yours.</p></header>` + flashOf(url)
      + `<section class="grp" id="inbox" data-int="inbox"><div class="letters" data-inbox>${letters || empty}</div></section>`;
    c.send(res, 200, html, settingsPage({ title: "Inbox", label: "Inbox", sections: [["inbox", "Inbox"]] }, body, helpPanel(helpAt(host), displayName(me.login, env) ?? me.login), scripts));
  };
  const invitesPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const stream = form.get("stream") ?? "";
    const mine = login ? invitesNow(env).find((x) => x.stream === stream && same(x.login, login)) : undefined;
    if (!login || !mine) return back(res, "/inbox", { ok: false, text: "That invite isn't yours to answer, or it's been answered." });
    const title = await titleOf(stream);
    if (form.get("do") === "decline") {
      await dropInvite(stream, login, env);
      await addNote({ to: mine.by, stream, who: login, did: "declined" }, env); // whoever invited them hears it
      return back(res, "/inbox", { ok: true, text: `Declined the invite to ${title}.` });
    }
    if (form.get("do") !== "accept") return back(res, "/inbox", { ok: false, text: "Nothing changed." });
    const now = await c.people(stream);
    await saveProject(stream, (saved) => {
      const p = saved ?? now;
      return inProject(p, login) ? undefined : { admins: p.admins, members: [...p.members, login] };
    }, env);
    await dropInvite(stream, login, env);
    await addNote({ to: mine.by, stream, who: login, did: "accepted" }, env);
    const joined = c.flash({ ok: true, text: `You joined ${title}: it's on your project list.` });
    const board = stream === c.home ? `/?r=${joined}` : `/?w=${encodeURIComponent(stream)}&r=${joined}`;
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: board });
  };

  // a note put away: only its own reader's
  const notesPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const stream = form.get("stream") ?? "";
    const about = form.get("who") ?? "";
    if (!login || !notesFor(login, env).some((n) => n.stream === stream && same(n.who, about))) return back(res, "/inbox", { ok: false, text: "That note isn't yours, or it's been put away." });
    await dropNote(login, stream, about, env);
    return back(res, "/inbox", { ok: true, text: "Put away." });
  };

  // Project settings (GET /integrations): this project's name, its GitHub repo, its Jira project,
  // Sync, and deleting it, a helper per section.
  type Linked = ReturnType<typeof workspaceOf>;
  const unlinkButton = (name: string, linked: string | undefined) => (linked ? `<button class="how" type="submit" name="${name}" value="">Unlink</button>` : "");

  // GitHub: pick one of your repos
  const repoOption = (x: string, linked: string | undefined) => `<option value="${esc(x)}"${x === linked ? " selected" : ""}>${esc(x)}</option>`;
  const githubGroup = async (login: string | undefined, keys: Keys, ws: Linked, t: string) => {
    const got = await acc.repos(login);
    const noRepos = keys.github ? "Sign in with GitHub to pick one" : "Set up GitHub sign-in in Account settings first";
    const repoOptions = [...new Set([...(ws?.repo ? [ws.repo] : []), ...got.repos])];
    const options = repoOptions.map((x) => repoOption(x, ws?.repo)).join("");
    const verb = ws?.repo ? "Change" : "Link";
    const picker = repoOptions.length === 0
      ? row("Repository", `<span class="grp-v">${noRepos}</span>`)
      : `<form method="post" action="/integrations/link" class="grp-row" data-link-repo-form>${t}<input type="hidden" name="what" value="repo"><span class="grp-k">Repository</span><select name="repo" aria-label="Repository">${options}</select><button class="act primary" type="submit">${verb}</button>${unlinkButton("repo", ws?.repo)}</form>`;
    return group("github", "GitHub", problem(got.problem ?? "") + picker);
  };

  // Jira: pick a project from your connected site (connecting is yours: Account settings)
  const projectOption = (x: { key: string; name: string }, linked: string | undefined) => `<option value="${esc(x.key)}"${x.key === linked ? " selected" : ""}>${esc(x.name)} (${esc(x.key)})</option>`;
  const jiraProjectGroup = async (login: string | undefined, keys: Keys, host: string, ws: Linked, t: string): Promise<string> => {
    if (!keys.atlassian) return group("jira", "Jira", row("Jira", `<span class="grp-v">Not available on this tira yet</span>`), mayChangeApps(login) ? `Add tira's Atlassian app in <a class="how" href="/settings#setup">Account settings</a>.` : "Whoever runs this tira turns Jira on, once, for everyone.");
    if (!login) return group("jira", "Jira", row("Jira", `<span class="grp-v">Sign in with GitHub first</span>`));
    const j = await acc.jira(login, host, "/integrations", ws);
    if (j.state === "elsewhere") return group("jira", "Jira", row("Jira", `<a class="how" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`));
    if (j.state !== "connected") return group("jira", "Jira", row("Jira", `<a class="act primary" href="${esc("/integrations/jira/connect?tab=1")}" target="_blank" rel="noopener" data-connect-jira>Sign in to Jira</a>`), "Connects your Atlassian account, for every project (Account settings).");
    if (!j.cloudId) return group("jira", "Jira", row("Jira", `<a class="how" href="/settings#linked">Pick your Jira site in Account settings</a>`));
    const options = j.projects.map((x) => projectOption(x, ws?.jira_project)).join("");
    const verb = ws?.jira_project ? "Change" : "Link";
    return group("jira", "Jira",
      row("Site", `<span class="grp-v">${esc(j.site ?? "")}</span>`)
        + problem(j.problem ?? "")
        + `<form method="post" action="/integrations/link" class="grp-row" data-link-jira-form>${t}<input type="hidden" name="what" value="jira"><span class="grp-k">Project</span><select name="jira_project" aria-label="Jira project">${options}</select><button class="act primary" type="submit">${verb}</button>${unlinkButton("jira_project", ws?.jira_project)}</form>`);
  };

  // ---------- Connect agents (Project settings) ----------
  // Connector first (Isha, 2026-10-26): at a public address, Connect with Claude leads (Claude's own
  // connector signs in to tira and the person approves on tira's page: no terminal, no token), then
  // Cursor and VS Code (Add to, in one click), and a terminal (Claude Code's command; on this
  // computer, Claude Desktop's config entry too) folded under them. An app picked: name its agent
  // (its own token is made then, for this project only, src/mcp/tokens.ts), then the one thing to do
  // in that app. Either way the page turns green the moment the agent first calls tira (agents.mjs
  // asks every few seconds). Each step is its own address (?app=, ?made=), so it all works without
  // the page's script; with it, steps change in place. The new token shows only in its last step, for
  // 10 minutes, to whoever made it (a one-time key in the address, never the token); tira keeps only
  // its fingerprint. Connected agents are listed below, with Revoke (whoever connected it, or the
  // admin); the rest folds under More.
  const tokensNow = (): AgentTokens | undefined => c.outside?.agentTokens ?? agentTokensFor(env);
  const launch: Launch = { node: process.execPath, script: TIRA_SCRIPT };
  const MADE_FOR_MS = 10 * 60_000;
  type Made = { token: string; id: string; agent: string; project: string; app: App; by: string; until: number };
  const justMade = new Map<string, Made>();
  const MADE_KEY = /^[0-9a-f]{24}$/;
  const meAs = (me: { login?: string; actor?: string }) => me.login ?? me.actor ?? "";
  // whoever connected it, or one of this project's admins (admin: whether this person is)
  const mayRevoke = (me: { login?: string; actor?: string }, row: AgentToken, admin: boolean) => meAs(me) === row.createdBy || !appKeys(env).github || admin;
  // where an agents action lands: the section, with the project kept (and its result shown there)
  const agentsAt = (query: string) => {
    const w = c.stream === c.home ? "" : "w=" + encodeURIComponent(c.stream);
    const q = [query, w, "from=agents"].filter(Boolean).join("&");
    return `/integrations?${q}#agents`;
  };
  const toAgents = (res: ServerResponse, query: string) => c.send(res, 303, "text/plain; charset=utf-8", "", { Location: agentsAt(query) });
  const agentName = (asked: string, taken: string[]): { name: string } | { why: string } => {
    const why = agentNameProblem(asked);
    if (why) return { why };
    if (taken.includes(asked)) return { why: `${asked} is already connected to this project: revoke it first, or pick another name.` };
    return { name: asked };
  };
  // step 2's Connect: the agent's token, for the app chosen in step 1
  const agentConnect = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const app = APPS.find((a) => a === form.get("app"));
    const said = (f: Flash) => toAgents(res, (app ? `app=${app}&` : "") + "r=" + c.flash(f));
    const me = who(req);
    if (!me.actor) return said({ ok: false, text: "Sign in first." });
    if (!app) return said({ ok: false, text: "Choose your app first." });
    const tokens = tokensNow();
    if (!tokens) return said({ ok: false, text: "Connecting agents needs tira's Postgres database." });
    const named = agentName((form.get("name") ?? "").trim(), (await tokens.list(c.stream)).map((x) => x.agent));
    if ("why" in named) return said({ ok: false, text: named.why });
    const { token, row } = await tokens.create(c.stream, named.name, meAs(me), app);
    const now = Date.now();
    for (const [k, v] of justMade) if (v.until < now) justMade.delete(k);
    const key = randomBytes(12).toString("hex");
    justMade.set(key, { token, id: row.id, agent: row.agent, project: c.stream, app, by: meAs(me), until: now + MADE_FOR_MS });
    toAgents(res, "made=" + key);
  };
  const agentRevoke = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const said = (f: Flash) => toAgents(res, "r=" + c.flash(f));
    const me = who(req);
    const tokens = tokensNow();
    if (!me.actor || !tokens) return said({ ok: false, text: "Sign in first." });
    const row = (await tokens.list(c.stream)).find((x) => x.id === form.get("id"));
    if (!row) return said({ ok: false, text: "That agent isn't connected to this project." });
    if (!mayRevoke(me, row, !!me.login && await adminHere(me.login))) return said({ ok: false, text: `Only ${row.createdBy}, who connected ${row.agent}, or this project's admins can revoke it.` });
    await tokens.revoke(row.id);
    said({ ok: true, text: `Revoked ${row.agent}: its next call is refused.` });
  };
  // Test connection: has the app called tira since the agent was made? Its first call sets the
  // agent's last used (a call from this page would prove only that the token is new). Until then
  // it's a wait, not a fault: adding tira to an app doesn't call it, so it's said calmly, with the
  // quickest way to make that first call.
  const WAITING: Record<App, string> = {
    "claude-code": "Once you've run the command, its last lines (claude mcp list) check the connection: that's its first call.",
    cursor: "Once tira is added, Cursor calls it when tira is turned on in its settings, under MCP.",
    vscode: "Once tira is added, VS Code calls it when you start tira from its MCP servers list.",
    "claude-desktop": "Once the entry is in its config, Claude Desktop calls tira when it restarts.",
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD, on this computer's calendar
  const ago = (iso: string) => {
    const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    return `on ${day(iso)}`;
  };
  const heardFrom = (row: AgentToken): Flash => {
    const app = APPS.find((a) => a === row.app);
    const where = app ? APP_NAME[app] : row.agent;
    if (row.lastUsedAt) return { ok: true, text: `${where} is connected: tira heard from ${row.agent} ${ago(row.lastUsedAt)}. Ask it "what's next in tira?"` };
    return { ok: false, wait: true, text: `Waiting for ${where}'s first call. ${app ? WAITING[app] : "Finish the step above in its app."} This turns green by itself when it calls.` };
  };
  const agentTest = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const key = form.get("made") ?? "";
    const answer = (f: Flash) => {
      if (form.get("fragment") === "1") return c.send(res, 200, html, flashLine(f)); // the page's script shows it in place
      toAgents(res, (MADE_KEY.test(key) ? `made=${key}&` : "") + "r=" + c.flash(f));
    };
    const tokens = tokensNow();
    if (!who(req).actor || !tokens) return answer({ ok: false, text: "Sign in first." });
    const row = (await tokens.list(c.stream)).find((x) => x.id === form.get("id"));
    answer(row ? heardFrom(row) : { ok: false, text: "That agent isn't connected to this project any more." });
  };
  // Connect with Claude: has an agent connected since the page opened, and called tira? Nothing to say
  // until one has (the page asks every few seconds, agents.mjs); with no script, Check posts as usual.
  const agentHeard = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const fragment = form.get("fragment") === "1";
    const tokens = tokensNow();
    if (!who(req).actor || !tokens) return fragment ? c.send(res, 200, html, "") : toAgents(res, "r=" + c.flash({ ok: false, text: "Sign in first." }));
    const asked = Number(form.get("since"));
    const since = Number.isFinite(asked) && asked > 0 ? asked : Date.now();
    const fresh = [...(await tokens.list(c.stream))].reverse().find((x) => Date.parse(x.createdAt) >= since && x.lastUsedAt); // the newest
    const said: Flash = fresh?.lastUsedAt
      ? { ok: true, text: `${fresh.agent} is connected: tira heard from it ${ago(fresh.lastUsedAt)}. Ask it "what's next in tira?"` }
      : { ok: false, wait: true, text: "Not yet: once it connects and calls tira, this turns green." };
    if (fragment) return c.send(res, 200, html, fresh ? flashLine(said) : "");
    toAgents(res, "r=" + c.flash(said));
  };
  // a just-made agent's setup, for whoever made it, while it shows
  const madeFor = (key: string | null, me: { login?: string; actor?: string }) => {
    const made = key ? justMade.get(key) : undefined;
    return made && made.until >= Date.now() && made.project === c.stream && made.by === meAs(me) ? made : undefined;
  };

  const DB_SAID: Record<DatabaseCheck, (file: string) => string> = {
    ready: () => "Claude Desktop's agent will work on this tira's database: tira's .env names it.",
    missing: (file) => `tira's .env names no database, so Claude Desktop's agent couldn't reach this board. Add TIRA_DATABASE_URL (and TIRA_SCHEMA, if this tira uses one) to <code>${esc(file)}</code>, the same as this tira's.`,
    different: (file) => `tira's .env names a different database or schema than this tira uses, so Claude Desktop's agent would work somewhere else. Make <code>${esc(file)}</code> match this tira's.`,
  };
  const APP_HOW: Record<App, string> = { "claude-code": "A command to run", cursor: "Adds in one click", vscode: "Adds in one click", "claude-desktop": "An entry for its config" };
  const TOOLS_SAID: [string, string][] = [
    ["next_task", "what's in progress, what's next, what's assigned to it, feedback it hasn't answered"], ["list_tasks", "the tasks, in the board's order"], ["get_task", "one task: its ticket, comments, commits and history"],
    ["start_task", "start a task (one at a time)"], ["complete_task", "done, with a commit or pull request as proof of work"], ["block_task", "blocked, with a reason and what it waits on"],
    ["add_subtask", "a new task under one"], ["file_idea", "an idea for later, for a person to approve"], ["add_comment", "a reply on a task's comments"],
    ["fill_ticket", "a ticket's title, description, steps and estimate"],
  ];
  const copyButton = (target: string, label: string) => `<button type="button" class="env-btn" data-copy-target="${target}" title="Copy" aria-label="Copy ${esc(label)}">${COPY}</button>`;
  const codeBlock = (id: string, code: string, label: string) => `<div class="agent-code-wrap">${copyButton(id, label)}<pre class="agent-code" id="${id}">${esc(code)}</pre></div>`;
  const stepItem = (step: string) => `<li>${esc(step)}</li>`;
  const steps = (setup: AppSetup) => `<ol class="agent-steps">${setup.steps.map(stepItem).join("")}</ol>`;
  const installLink = (app: App, url: string) => {
    const away = url.startsWith("https:") ? ` target="_blank" rel="noopener noreferrer"` : "";
    return `<a class="act primary" href="${esc(url)}"${away} data-agent-install>Add to ${APP_NAME[app]}</a>`;
  };
  const step = (n: number, title: string, state: "now" | "done" | "later", body: string) =>
    `<div class="agent-step ${state}" data-agent-step="${n}"><h3><span class="agent-n">${state === "done" ? "✓" : n}</span>${title}</h3>${body}</div>`;
  const tile = (app: App) => `<a class="agent-tile" href="${esc(agentsAt("app=" + app))}" data-agent-tile="${app}" data-agent-go><span class="agent-icon" aria-hidden="true">${APP_ICON[app]}</span><b>${APP_NAME[app]}</b><small>${APP_HOW[app]}</small></a>`;
  const startOver = (label: string) => `<a href="${esc(agentsAt(""))}" data-agent-go>${label}</a>`;
  // the last step's status: waiting, or green once the app has called (agents.mjs asks by itself;
  // Check now asks at once)
  const testForm = (made: Made, key: string, t: string, said: string) =>
    `<form method="post" action="/integrations/agents/test" class="agent-test" data-agent-test data-agent-watch>${t}<input type="hidden" name="id" value="${esc(made.id)}"><input type="hidden" name="made" value="${esc(key)}"><button class="act" type="submit">Check now</button><span class="agent-test-said">tira checks by itself too.</span></form>`
    + `<div class="agent-tested" data-agent-tested>${said}</div>`;
  // step 3: the one thing to do in the app (the setup by hand, folded, where an install link opens it)
  const finish = (made: Made, at: Where, db: DatabaseCheck, envFile: string) => {
    const setup = appSetup(made.app, made.project, at, made.token);
    const byHand = steps(setup) + codeBlock("agent-setup", setup.code, APP_NAME[made.app]);
    const dbWarn = made.app === "claude-desktop" && db !== "ready" ? `<p class="agent-db no" data-agent-database="${db}">${DB_SAID[db](envFile)}</p>` : "";
    if (!setup.install) return byHand + dbWarn;
    return `<p>${APP_NAME[made.app]} shows tira's server and asks before it adds it.</p><p class="agent-go">${installLink(made.app, setup.install)}</p>`
      + `<details class="agent-hand"><summary>Doesn't open? Add it by hand</summary>${byHand}</details>`;
  };
  const agentRow = (row: AgentToken, me: { login?: string; actor?: string }, t: string, admin: boolean) => {
    const app = APPS.find((a) => a === row.app);
    const used = row.lastUsedAt ? "last used " + day(row.lastUsedAt) : "not used yet";
    const label = row.app === CONNECTOR_APP ? "Claude's Connectors" : "";
    const woken = wakesOf(c.stream, env).some((w) => w.agent === row.agent);
    const about = [app ? APP_NAME[app] : label, `tira_${esc(row.id)}…`, `connected by ${esc(row.createdBy)} on ${day(row.createdAt)}`, used, woken ? "starts when it's @mentioned" : ""].filter(Boolean).join(" · ");
    const may = mayRevoke(me, row, admin);
    const revoke = may ? `<form method="post" action="/integrations/agents/revoke" data-agent-go>${t}<input type="hidden" name="id" value="${esc(row.id)}"><button class="how" type="submit">Revoke</button></form>` : "";
    const off = may && woken ? `<form method="post" action="/integrations/agents/wake" data-agent-wake-off>${t}<input type="hidden" name="agent" value="${esc(row.agent)}"><input type="hidden" name="do" value="off"><button class="how" type="submit">Stop starting on @mention</button></form>` : "";
    return `<div class="agent-row" data-agent="${esc(row.agent)}"><span class="agent-who"><b>${esc(row.agent)}</b><small>${about}</small></span><span class="agent-acts">${off}${revoke}</span></div>`;
  };
  // saving an agent's routine, or turning it off: whoever connected it, or this project's admin
  const agentWake = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const said = (f: Flash) => toAgents(res, "r=" + c.flash(f));
    const me = who(req);
    const tokens = tokensNow();
    const agent = form.get("agent") ?? "";
    const row = tokens ? (await tokens.list(c.stream)).find((x) => x.agent === agent) : undefined;
    if (!me.actor || !row) return said({ ok: false, text: "That agent isn't connected to this project." });
    if (!mayRevoke(me, row, !!me.login && await adminHere(me.login))) return said({ ok: false, text: `Only ${row.createdBy}, who connected ${agent}, or this project's admin can change that.` });
    if (form.get("do") === "off") {
      await dropWake(c.stream, agent, env);
      return said({ ok: true, text: `${agent} won't start on its own any more.` });
    }
    const url = (form.get("routine_url") ?? "").trim(); // its own names: "token" is the page's
    const secret = (form.get("routine_token") ?? "").trim();
    const why = routineProblem(url, secret);
    if (why) return said({ ok: false, text: why });
    await saveWake({ stream: c.stream, agent, url, token: secret, by: meAs(me) }, env);
    said({ ok: true, text: `${agent} starts when it's @mentioned now.` });
  };
  const toolItem = ([tool, said]: [string, string]) => `<li><code>${tool}</code> ${esc(said)}</li>`;
  const manualApp = (app: App, at: Where) => {
    const setup = appSetup(app, c.stream, at, TOKEN_HERE);
    return `<div class="agent-app" data-agent-app="${app}"><b>${APP_NAME[app]}</b>${steps(setup)}${codeBlock("manual-" + app, setup.code, APP_NAME[app])}<p class="agent-undo">To remove it: <code>${esc(setup.remove)}</code></p></div>`;
  };
  const morePart = (title: string, body: string) => `<div class="agent-more-part"><h4>${title}</h4>${body}</div>`;
  // whether Claude Desktop's agent would reach this tira's database (on this computer only: at a
  // public address Claude Desktop connects as Claude does)
  const databasePart = (db: DatabaseCheck, envFile: string) => {
    if (c.site) return "";
    const ready = db === "ready" ? "agent-db" : "agent-db no";
    return morePart("Claude Desktop's database", `<p class="${ready}" data-agent-database="${db}">${DB_SAID[db](envFile)}</p>`);
  };
  const more = (at: Where, db: DatabaseCheck, envFile: string) => `<details class="agent-more" data-agent-more><summary>More</summary>`
    + morePart("tira's MCP address", `<p>For any app that speaks MCP over HTTP: this address, with the agent's token in the header <code>Authorization: Bearer ${esc(TOKEN_HERE)}</code>. It answers while tira serve runs.</p>${codeBlock("agent-url", at.url, "the address")}`)
    + morePart("Each app by hand", `<p>Put the agent's token where it says ${esc(TOKEN_HERE)}.</p>${appsHere().map((app) => manualApp(app, at)).join("")}`)
    + morePart("What agents can do", `<ul class="agent-tools">${TOOLS_SAID.map(toolItem).join("")}</ul><p>Cancelling, reopening and unblocking stay with people.</p>`)
    + databasePart(db, envFile)
    + `</details>`;
  // at a public address: the apps that connect by a token here (Claude Desktop's local entry has no
  // place there: it connects as Claude does), and Claude's own way in, by its Connectors
  const appsHere = () => (c.site ? APPS.filter((a) => a !== "claude-desktop") : APPS);
  // Claude Code, first (Isha, 2026-10-26): at a public address, by a connector in the person's
  // Claude account (Claude Code signed in with it picks it up: no command, no token; the same
  // connector serves Claude on the web and the Claude app), watched until a new agent calls, with
  // its command folded in for an API key or the terminal; on this computer, the same two ways, the
  // connector first (Isha, 2026-10-26), with why it needs tira at a public address
  const byCommand = (label: string, primary: boolean) =>
    `<a class="act${primary ? " primary" : ""}" href="${esc(agentsAt("app=claude-code"))}" data-agent-tile="claude-code" data-agent-go>${label}</a>`;
  // Claude's Connectors, played (Isha, 2026-10-26): five short steps beside a small moving picture
  // of each, one at a time (cplay.mjs: round again every few seconds, a step clicked shows its own,
  // hovering holds it, still under Reduce Motion; with no script, every step is listed)
  const CPLAY: [string, string][] = [
    ["Copy tira's address", ""],
    ["Open Claude → Connectors", "Customize → Connectors, on claude.ai or the app"],
    ["Add custom connector", "Paste the address, then Add"],
    ["Connect, then approve", "On tira's page, pick this project"],
    ["Run /mcp in Claude Code", "tira shows as connected"],
  ];
  // a play of short steps beside a small moving picture of each (cplay.mjs)
  const stepPlayer = (steps: readonly [string, string][], scenes: readonly string[]) => {
    const list = steps.map(([title, sub], i) => `<li><button type="button" class="cplay-step${i === 0 ? " on" : ""}" data-cplay-go="${i}"${i === 0 ? ' aria-current="step"' : ""}><span class="cplay-n">${i + 1}</span><span class="cplay-t"><b>${esc(title)}</b><small>${esc(sub)}</small></span></button></li>`).join("");
    return `<div class="cplay" data-cplay><ol class="cplay-steps">${list}</ol><div class="cplay-stage" aria-hidden="true">`
      + scenes.map((x, i) => `<div class="cscene s${i + 1}${i === 0 ? " on" : ""}" data-cplay-scene>${x}</div>`).join("") + `<span class="cplay-bar"><i></i></span></div></div>`;
  };
  const connectorPlayer = (address: string | undefined) => {
    const where = esc(address ?? "https://your-tira…/mcp");
    const first = address ? "The address above" : "Your hosted tira, with /mcp";
    return stepPlayer(CPLAY.map(([title, sub], i) => [title, i === 0 ? first : sub]), [
      `<div class="cs-url"><span class="cs-mono">${where}</span><span class="cs-chip cs-hit">Copy</span></div><span class="cs-toast">Copied</span>`,
      `<div class="cs-win"><div class="cs-side"><span>Chats</span><span>Projects</span><span class="cs-hit">Customize</span></div><div class="cs-pane"><span>Skills</span><span class="cs-hit2">Connectors</span><span>Styles</span></div></div>`,
      `<div class="cs-modal"><b>Add custom connector</b><span class="cs-field">tira</span><span class="cs-field"><span class="cs-type cs-mono">${where}</span></span><span class="cs-btn cs-press">Add</span></div>`,
      `<div class="cs-card"><span class="cs-mark">t</span><b>Claude wants to work in tira</b><span class="cs-field">This project</span><span class="cs-btn cs-press">Approve</span><span class="cs-done">✓ Connected</span></div>`,
      `<div class="cs-term"><span class="cs-mono">› <span class="cs-type">/mcp</span></span><span class="cs-mono cs-out">tira · claude.ai · <em>✓ connected</em></span></div>`,
    ]);
  };
  // Let it start when you @mention it (wake.ts; Isha, 2026-10-26: "add it to the main flow, the
  // animation if the user wants to do this, then steps"): under Claude Code, one line on what it does
  // and Set it up, which opens five steps played, the prompt to copy, then which agent, and its
  // routine's address and token. Which agents start this way already shows above it.
  const WAKE_PLAY: [string, string][] = [
    ["Open claude.ai/code/routines", "New routine"],
    ["Pick your repo and tira", "The repository, then tira under Connectors"],
    ["Paste the prompt", "Copy it below"],
    ["Add an API trigger", "Select a trigger → API → Generate token"],
    ["Paste both here", "The routine's address and its token"],
  ];
  const wakeCard = (rows: readonly AgentToken[], t: string) => {
    const player = stepPlayer(WAKE_PLAY, [
      `<div class="cs-url"><span class="cs-mono">claude.ai/code/routines</span><span class="cs-chip cs-hit">New routine</span></div>`,
      `<div class="cs-modal"><b>New routine</b><span class="cs-field">Repository · <span class="cs-type">your-repo</span></span><span class="cs-field">Connectors · tira ✓</span><span class="cs-btn cs-press">Next</span></div>`,
      `<div class="cs-modal"><b>Prompt</b><span class="cs-field"><span class="cs-type">You work tasks in tira, through its connector…</span></span><span class="cs-btn cs-press">Save</span></div>`,
      `<div class="cs-card"><b>Select a trigger</b><span class="cs-field">Schedule · GitHub · <b>API</b></span><span class="cs-btn cs-press">Generate token</span><span class="cs-done">✓ Address and token</span></div>`,
      `<div class="cs-modal"><b>tira · Start when @mentioned</b><span class="cs-field"><span class="cs-type cs-mono">api.anthropic.com/…/trig_…/fire</span></span><span class="cs-field cs-mono">sk-ant-oat01-••••••••</span><span class="cs-btn cs-press">Save</span></div>`,
    ]);
    const on = wakesOf(c.stream, env).map((w) => w.agent).filter((a) => rows.some((x) => x.agent === a));
    const starts = on.length === 1 ? "starts" : "start";
    const already = on.length === 0 ? "" : `<p class="wake-now" data-wake-on><span class="wake-on">●</span> ${on.map(esc).join(", ")} ${starts} when @mentioned.</p>`;
    const pick = rows.find((x) => x.app === CONNECTOR_APP) ?? rows.find((x) => x.app === "claude-code") ?? rows[0];
    const options = rows.map((x) => `<option value="${esc(x.agent)}"${x === pick ? " selected" : ""}>${esc(x.agent)}</option>`).join("");
    const form = rows.length === 0
      ? `<p class="agent-later">Connect Claude above first: then it can start by itself.</p>`
      : `<form method="post" action="/integrations/agents/wake" class="wake-form" data-agent-wake-form>${t}`
        + `<label class="field"><span>Agent</span><select name="agent">${options}</select></label>`
        + `<label class="field"><span>Routine address</span><input type="url" name="routine_url" required placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" autocomplete="off"></label>`
        + `<label class="field"><span>Token</span><input type="password" name="routine_token" required placeholder="sk-ant-oat01-…" autocomplete="off"></label>`
        + `<button class="act primary" type="submit">Save</button></form>`;
    const reach = c.site ? "" : `<p class="agent-later">The routine reaches tira over the internet, so this needs tira at a public address, like your hosted tira.</p>`;
    return `<div class="agent-wake-card" data-agent-wake-card><h3><span class="agent-icon" aria-hidden="true">${SET_ICON.agents}</span>Let it start when you @mention it <span class="pill">Optional</span></h3>`
      + `<p>@mention it on a task, or give it one, and it starts by itself in Anthropic's cloud, on your Claude plan. No need to go and tell it.</p>${already}`
      + `<details class="wake-setup" data-wake-setup><summary class="act">Set it up</summary><div class="wake-body">${player}`
      + `<p>The prompt for step 3:</p>${codeBlock("wake-prompt", WAKE_PROMPT, "the prompt")}${form}${reach}</div></details></div>`;
  };
  const codeCard = (at: Where, t: string) => (c.site
    ? `<div class="agent-claude" data-agent-code data-agent-connector><h3><span class="agent-icon" aria-hidden="true">${APP_ICON["claude-code"]}</span>Claude Code <span class="pill">Recommended</span></h3>`
      + `<p>No command, no token: add tira to Claude once, and Claude Code picks it up.</p>`
      + codeBlock("agent-connector-url", at.url, "the address") + connectorPlayer(at.url)
      + `<form method="post" action="/integrations/agents/heard" class="agent-watch" data-agent-watch>${t}<input type="hidden" name="since" value="${Date.now()}"><noscript><button class="how" type="submit">Check</button></noscript></form>`
      + `<div class="agent-tested" data-agent-tested><p class="agent-test-said">This turns green the moment it connects.</p></div>`
      + `<details class="agent-term" data-agent-terminal><summary>Claude Code with an API key, or rather the terminal?</summary><p>Add tira with one command instead: name its agent, then copy the command.</p><p>${byCommand("Set up by command", false)}</p></details>`
      + `<p class="agent-later">The same connector works in Claude on the web and in the Claude app too.</p></div>`
    : `<div class="agent-claude" data-agent-code><h3><span class="agent-icon" aria-hidden="true">${APP_ICON["claude-code"]}</span>Claude Code <span class="pill">Recommended</span></h3>`
      + `<div class="code-way"><h4>1. From Claude's Connectors <span class="pill">Simplest</span></h4><p>No command, no token: add tira to Claude once, and Claude Code picks it up.</p>${connectorPlayer(undefined)}`
      + `<p class="agent-later" data-agent-connectors>Needs tira at a public address, like your hosted tira: Claude can't reach this computer.</p></div>`
      + `<div class="code-way"><h4>2. From a terminal</h4><p>One command: name its agent, then copy the command. It checks the connection when it's done, and this page turns green.</p><p>${byCommand("Set up Claude Code", true)}</p></div></div>`);
  // no app picked yet: Claude Code first, then Cursor and VS Code; on this computer, Claude Desktop
  // (the chat app, by its config entry) folded under them
  const chooser = (at: Where, t: string, rows: readonly AgentToken[]) => codeCard(at, t) + wakeCard(rows, t)
    + `<h3 class="agent-list-h">Or Cursor, VS Code</h3><div class="agent-tiles">${(["cursor", "vscode"] as const).map(tile).join("")}</div>`
    + (c.site ? "" : `<details class="agent-term" data-agent-desktop><summary>Claude Desktop, the chat app?</summary><div class="agent-tiles">${tile("claude-desktop")}</div></details>`);
  const agentsGroup = async (url: URL, me: { login?: string; actor?: string }, t: string, host: string) => {
    const head = `<section class="grp" id="agents" data-int="agents">${sectionTop("agents", "Connect agents")}`;
    const said = url.searchParams.get("from") === "agents" ? flashOf(url) : "";
    const tokens = tokensNow();
    if (!tokens) return head + said + `<div class="grp-list">${row("Agents", '<span class="grp-v">Connecting agents needs tira\'s Postgres database</span>')}</div></section>`;
    const rows = await tokens.list(c.stream);
    const key = url.searchParams.get("made");
    const shown = madeFor(key, me);
    const made = shown && rows.some((x) => x.id === shown.id) ? shown : undefined; // not once it's revoked
    const app = made?.app ?? APPS.find((a) => a === url.searchParams.get("app"));
    const at: Where = { url: mcpUrl(host, c.site?.origin), launch };
    const envFile = c.outside?.envFile ?? TIRA_ENV_FILE;
    const db = databaseCheck(envFile, env);
    const gone = key && !made ? `<div class="flash no" role="status">That setup isn't shown any more (it shows for 10 minutes, to whoever made it). Its agent is in the list below: revoke it and connect it again for a new token.</div>` : "";
    let flow: string;
    if (made) flow = madeFlow(made, rows, said, key ?? "", at, db, envFile, t);
    else if (app) flow = namingFlow(app, rows, said, t);
    else flow = chooser(at, t, rows);
    const top = made || app ? gone : said + gone; // a step's own result shows in that step
    const admin = !!me.login && await adminHere(me.login);
    const list = rows.length === 0 ? '<p class="agent-none">No agents connected yet.</p>' : rows.map((x) => agentRow(x, me, t, admin)).join("");
    return head + top + flow
      + `<h3 class="agent-list-h">Connected agents</h3><div class="agent-list" data-agents>${list}</div>`
      + more(at, db, envFile)
      + `<div class="grp-foot">A token works for this project only. Revoke it here and the agent's next call is refused.</div><span hidden data-agents-here="${esc(url.pathname + url.search)}"></span></section>`;
  };
  // an agent just made: its app and name done, then the one thing to do in its app, and its status
  const madeFlow = (made: Made, rows: AgentToken[], said: string, key: string, at: Where, db: DatabaseCheck, envFile: string, t: string) => {
    const heard = rows.find((x) => x.id === made.id);
    const status = said || (heard ? flashLine(heardFrom(heard)) : "");
    return step(1, "Choose your app", "done", `<p class="agent-done"><b>${APP_NAME[made.app]}</b></p>`)
      + step(2, "Name your agent", "done", `<p class="agent-done"><b>${esc(made.agent)}</b> is connected to this project, with a token of its own.</p>`)
      + step(3, `Finish in ${APP_NAME[made.app]}`, heard?.lastUsedAt ? "done" : "now", finish(made, at, db, envFile) + testForm(made, key, t, status) + `<p class="agent-again">${startOver("Connect another agent")}</p>`);
  };
  // an app picked: name its agent (its name suggested), then the one thing to do in its app
  const namingFlow = (app: App, rows: AgentToken[], said: string, t: string) => {
      const suggested = freeName(APP_AGENT[app], rows.map((x) => x.agent));
      return step(1, "Choose your app", "done", `<p class="agent-done"><b>${APP_NAME[app]}</b> ${startOver("Change")}</p>`)
        + step(2, "Name your agent", "now", `<p>Its name is how its moves show on the board, never a person's. It gets a token of its own, for this project only.</p>`
        + `<form method="post" action="/integrations/agents/connect" class="agent-name-form" data-agent-name data-agent-go>${t}<input type="hidden" name="app" value="${app}"><input type="text" name="name" value="${esc(suggested)}" maxlength="64" required autocomplete="off" spellcheck="false" aria-label="Agent's name"><button class="act primary" type="submit">Connect</button></form>` + said)
        + step(3, `Finish in ${APP_NAME[app]}`, "later", `<p>One thing to do in ${APP_NAME[app]}. tira turns green the moment it calls.</p>`);
  };

  const page = async (req: IncomingMessage, res: ServerResponse, url: URL, host: string) => {
    const me = who(req);
    if (!me.actor) return signedOut(res, url); // the project's: sign in first
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const keys = appKeys(env);
    const t = hidden();
    const github = await githubGroup(me.login, keys, ws, t);
    const jira = await jiraProjectGroup(me.login, keys, host, ws, t);

    // its name, as people see it (its address and history keep the one it was made with)
    const shown = ws?.title ?? c.stream;
    const name = esc(shown);
    const general = `<section class="grp" id="general" data-int="general">${sectionTop("general", "General")}`
      + `<form method="post" action="/projects/rename" class="grp-list" data-rename-project data-autosave>${t}<label class="grp-row"><span class="grp-k">Project name</span><input type="text" name="title" value="${name}" required maxlength="80" autocomplete="off" spellcheck="false" aria-label="Project name"><span class="save-state" data-save-state aria-live="polite"></span></label></form>`
      + `<div class="grp-row"><span class="grp-k">Project id</span><code class="grp-v" data-project-id>${esc(c.stream)}</code></div>`
      + `<div class="grp-foot">The id never changes: it's in the project's address and its tickets' keys (<code>TIRA_${esc(projectCode(c.stream))}_1</code>, …). Names and ids are each unique on this tira.</div></section>`;

    // delete: type the project's name to be sure (not the one tira opens on: the one tira serve was
    // started with, which a hosted tira's people can't change; said plainly, Isha 2026-10-26)
    const startedHere = row("Delete", `<span class="grp-v">tira opens on this project, so it can't be deleted. You can rename it in General.</span>`);
    const adminsOnly = row("Delete", `<span class="grp-v">Only this project's admins can delete it</span>`);
    const mayDelete = await adminHere(me.login);
    const whyNot = c.stream === c.home ? startedHere : adminsOnly;
    const remove = `<section class="grp danger" id="delete" data-int="delete">${sectionTop("delete", "Danger zone")}`
      + (c.stream === c.home || !mayDelete
        ? `<div class="grp-list">${whyNot}</div></section>`
        : `<form method="post" action="/projects/delete" class="grp-list" data-delete-project>${t}<label class="grp-row"><span class="grp-k">Type <b>${nameHtml(shown)}</b> to confirm</span><input type="text" name="confirm" autocomplete="off" spellcheck="false" required aria-label="Type ${name} to confirm"></label>`
          + `<div class="grp-row"><span class="grp-k"></span><button class="act danger" type="submit">Delete this project</button></div></form></section>`);

    const fromAgents = url.searchParams.get("from") === "agents"; // its result shows in the section
    const agents = await agentsGroup(url, me, t, host);
    const team = await teamGroup(me.login, t, shown);
    const agentCount = ((await tokensNow()?.list(c.stream)) ?? []).length;
    const body = `<header class="int-head"><h1>Project settings</h1><p>${projectMark(c.stream, shown)}<b>${nameHtml(shown)}</b></p></header>` + (fromAgents ? "" : flashOf(url)) + general + team + github + jira + agents + remove;
    c.send(res, 200, html, settingsPage({ title: `Project settings · ${shown}`, label: "Project settings", project: { stream: c.stream, name: shown }, sections: [["", "Project"], ["general", "General"], ["team", "Collaborators"], ["", "Connections"], ["github", "GitHub", ws?.repo ? "on" : ""], ["jira", "Jira", ws?.jira_project ? "on" : ""], ["agents", "Agents", agentCount > 0 ? String(agentCount) : ""], ["", "Advanced"], ["delete", "Danger zone"]] }, body, helpPanel(helpAt(host), me.actor), scripts));
  };

  // ---------- the team: a project's admins add, promote and remove its people ----------
  const TEAM_MOVES: readonly TeamMove[] = ["add", "remove", "admin", "member", "uninvite"];
  const peoplePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const now = await c.people(c.stream);
    if (!login || !isProjectAdmin(now, login)) return back(res, "/integrations#team", { ok: false, text: "Only this project's admins can change its collaborators." });
    const move = TEAM_MOVES.find((m) => m === form.get("do"));
    const asked = (form.get("login") ?? "").trim().replace(/^@/, "");
    if (!move) return back(res, "/integrations#team", { ok: false, text: "Nothing changed." });
    if (!GITHUB_LOGIN.test(asked)) return back(res, "/integrations#team", { ok: false, text: "That isn't a GitHub username." });
    const who2 = knownLogin(asked, env) ?? asked; // as GitHub spells it, once they've signed in
    // add is an invite (Isha, 2026-10-26): they answer it, and see the project once they accept
    const invitedNow = invitesNow(env).some((x) => x.stream === c.stream && same(x.login, who2));
    if (move === "add") {
      if (inProject(now, who2)) return back(res, "/integrations#team", { ok: false, text: `${who2} is already in this project.` });
      if (invitedNow || !(await invite(c.stream, who2, login, env))) return back(res, "/integrations#team", { ok: false, text: `${who2} is already invited.` });
      return back(res, "/integrations#team", { ok: true, text: knownLogin(who2, env) ? `Invited ${who2}: they'll see this project once they accept.` : `Invited ${who2}: the invite waits for them to sign up with GitHub and accept.` });
    }
    if (move === "uninvite") {
      if (!invitedNow) return back(res, "/integrations#team", { ok: false, text: `${who2} isn't invited.` });
      await dropInvite(c.stream, who2, env);
      return back(res, "/integrations#team", { ok: true, text: `Took back the invite to ${who2}.` });
    }
    let said: Flash = { ok: false, text: "Nothing changed." };
    // decided on the team as it is when it's written (two admins at once don't undo each other)
    await saveProject(c.stream, (saved) => {
      const got = changeTeam(saved ?? now, move, who2, knownLogin(who2, env) !== undefined);
      if ("why" in got) {
        said = { ok: false, text: got.why };
        return undefined;
      }
      said = { ok: true, text: got.said };
      return got.next;
    }, env);
    back(res, "/integrations#team", said);
  };

  // ---------- removed accounts: this tira's owner removes one, or lets one back in ----------
  const accountsPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const a = access(env);
    if (!login || !isOwner(a, login)) return back(res, "/settings#accounts", { ok: false, text: "Only this tira's owner can remove accounts." });
    const who2 = (form.get("login") ?? "").trim().replace(/^@/, "");
    if (!GITHUB_LOGIN.test(who2)) return back(res, "/settings#accounts", { ok: false, text: "That isn't a GitHub username." });
    if (form.get("do") === "unblock") {
      await unblock(who2, env);
      return back(res, "/settings#accounts", { ok: true, text: `${who2} can sign in again.` });
    }
    if (form.get("do") !== "block") return back(res, "/settings#accounts", { ok: false, text: "Nothing changed." });
    if (isOwner(a, who2)) return back(res, "/settings#accounts", { ok: false, text: "That's you, this tira's owner: you can't remove your own account." });
    if (isBlocked(who2, env)) return back(res, "/settings#accounts", { ok: true, text: `${who2} is removed already.` });
    await block(who2, login, env);
    await signOutEverywhere(who2, env);
    back(res, "/settings#accounts", { ok: true, text: `Removed ${who2}: they're signed out, can't sign in, and their agents stop. Their projects stay with their other admins.` });
  };

  // ---------- the first-time welcome: the tour seen, the checklist put away, or back ----------
  // fragment: tour.mjs asked, and needs no page back
  const onboardingPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const login = who(req).login;
    const what = form.get("do");
    if (login && (what === "tour-seen" || what === "tour-finished")) await markSeen(login, "tour", env);
    if (login && what === "tour-finished") await unmarkSeen(login, "checklist-hidden", env);
    if (login && what === "hide-checklist") await markSeen(login, "checklist-hidden", env);
    if (form.get("fragment") === "1") return c.send(res, 204, "text/plain; charset=utf-8", "");
    c.send(res, 303, "text/plain; charset=utf-8", "", { Location: "/" });
  };

  // ---------- you: the name you're shown by, and unlinking your GitHub ----------
  const profilePost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    if (!me.actor) return back(res, "/welcome", { ok: false, text: "Sign in with GitHub first." });
    const name = (form.get("name") ?? "").trim().replace(/\s+/g, " ");
    const said = (f: Flash) => {
      if (form.get("fragment") !== "1") return back(res, "/settings#profile", f);
      c.send(res, f.ok ? 200 : 400, "text/plain; charset=utf-8", f.text);
    };
    if (name !== "" && !NAME.test(name)) return said({ ok: false, text: "A display name is 1 to 60 characters, with no angle brackets." });
    await saveDisplayName(me.actor, name || undefined, env);
    said({ ok: true, text: name ? `You're shown as ${name} now.` : "You're shown by your usual name again." });
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
    const to = backOf(form.get("back")) === "/settings" ? "/settings#setup" : backOf(form.get("back"));
    const now = appKeys(env);
    // once GitHub sign-in is on, only its owner may change tira's apps
    const login = who(req).login;
    if (!mayChangeApps(login)) return back(res, to, { ok: false, text: login ? "Only this tira's owner can change its apps." : "Sign in with GitHub to change tira's apps." });
    const ghSecret = (form.get("github_secret") ?? "").trim();
    const aSecret = (form.get("atlassian_secret") ?? "").trim();
    // an empty field keeps what's saved: a new secret alone goes with the Client ID already there
    const ghId = (form.get("github_client_id") ?? "").trim() || (ghSecret ? now.github?.clientId ?? "" : "");
    const aId = (form.get("atlassian_client_id") ?? "").trim() || (aSecret ? now.atlassian?.clientId ?? "" : "");
    const next: Parameters<typeof saveAppKeys>[0] = {};
    // a secret left empty keeps the one saved (the direct sign-in; without one, GitHub's code)
    const keptSecret = ghSecret || now.github?.secret;
    if (ghId) next.github = { clientId: ghId, ...(keptSecret ? { secret: keptSecret } : {}) };
    if (aId && (aSecret || now.atlassian?.secret)) next.atlassian = { clientId: aId, secret: aSecret || (now.atlassian?.secret as string) };
    if (aId && !aSecret && !now.atlassian?.secret) return back(res, to, { ok: false, text: "Add the Atlassian app's secret too." });
    await saveAppKeys(next, env);
    back(res, to, { ok: true, text: to === "/welcome" ? "Saved. Now sign in." : "Saved." });
  };

  // One of tira's own keys, for Show or Copy in Setup (secrets.mjs): to whoever may change them,
  // one at a time (never cached: every tira response says no-store); the page only ever holds dots.
  const revealPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    if (!mayChangeApps(who(req).login)) return c.send(res, 403, "text/plain; charset=utf-8", "Only this tira's owner can see its keys.");
    const keys = appKeys(env);
    const value = ({ github_client_id: keys.github?.clientId, github_secret: keys.github?.secret, atlassian_client_id: keys.atlassian?.clientId, atlassian_secret: keys.atlassian?.secret } as Record<string, string | undefined>)[form.get("key") ?? ""];
    if (value === undefined) return c.send(res, 404, "text/plain; charset=utf-8", "Not set.");
    c.send(res, 200, "text/plain; charset=utf-8", value);
  };

  const linkPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    const to = form.get("what") === "jira" ? "/integrations#jira" : "/integrations#github"; // back to the section it came from
    if (!me.actor) return back(res, to, { ok: false, text: "Sign in with GitHub first." });
    if (!(await adminHere(me.login))) return back(res, to, { ok: false, text: NOT_ADMIN });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const link: Record<string, string | undefined> = { repo: ws?.repo, jira_site: ws?.jira_site, jira_project: ws?.jira_project };
    if (form.get("what") === "repo") {
      const repo = (form.get("repo") ?? "").trim();
      if (repo !== "" && !REPO.test(repo)) return back(res, to, { ok: false, text: `${repo} isn't a repo as owner/name.` });
      link.repo = repo || undefined;
    } else if (form.get("what") === "jira") {
      const notPicked = pickJira(form, me.login ?? "", link); // no one signed in: no site, so unlinking only
      if (notPicked) return back(res, to, { ok: false, text: notPicked });
      link.jira_name = await nameOfPicked(me.login, link);
    } else return back(res, to, { ok: false, text: "Nothing to link." });
    back(res, to, await writeLink(me.actor, ws, link));
  };

  // Jira's name for the project a link names now (for a link that changed), and the name to say it by
  const nameOfPicked = (login: string | undefined, link: Record<string, string | undefined>) =>
    link.jira_project && link.jira_site ? projectName(jiraOf(login, { version: 0, jira_site: link.jira_site }), link.jira_project) : Promise.resolve(undefined);
  const jiraShown = (link: Record<string, string | undefined>, ws: WorkspaceLink | undefined) =>
    link.jira_name ?? (link.jira_project === ws?.jira_project ? ws?.jira_name : undefined) ?? link.jira_project;

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

  // the connect step's Jira picker was there: its choice, "No Jira project" included, onto the link;
  // or why it can't be
  const pickJira = (form: URLSearchParams, login: string, link: Record<string, string | undefined>): string | undefined => {
    const key = (form.get("jira_project") ?? "").trim();
    const site = atlassianAuth(login, env)?.site;
    if (key !== "" && (!JIRA_PROJECT.test(key) || !site)) return "Pick a Jira project from your connected site.";
    link.jira_project = key || undefined;
    link.jira_site = key ? site : undefined;
    return undefined;
  };

  const connectPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const me = who(req);
    if (!me.login) return back(res, "/welcome", { ok: false, text: "Sign in with GitHub first." });
    if (!(await adminHere(me.login))) return back(res, "/connect", { ok: false, text: NOT_ADMIN });
    const { r } = await c.now();
    const ws = workspaceOf(r, c.stream);
    const repo = (form.get("repo") ?? "").trim();
    if (!REPO.test(repo)) return back(res, "/connect", { ok: false, text: repo ? `${repo} isn't a repo as owner/name.` : "Pick a repo." });
    const link: Record<string, string | undefined> = { repo, jira_site: ws?.jira_site, jira_project: ws?.jira_project };
    const notPicked = form.has("jira_project") ? pickJira(form, me.login, link) : undefined;
    if (notPicked) return back(res, "/connect", { ok: false, text: notPicked });
    const same = link.repo === ws?.repo && link.jira_project === ws?.jira_project && link.jira_site === ws?.jira_site;
    if (!same) link.jira_name = await nameOfPicked(me.login, link);
    const f = same ? { ok: true, text: "" } : await writeLink(me.login, ws, link);
    if (!f.ok) return back(res, "/connect", f);
    const andJira = link.jira_project ? ` and Jira ${jiraShown(link, ws)}` : "";
    back(res, "/", { ok: true, text: `Connected to ${repo}${andJira}. Here's your board.` });
  };

  // ---------- Atlassian's round trip ----------
  const jiraConnect = (req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> => {
    const me = who(req);
    const keys = appKeys(env).atlassian;
    const to = backOf(url.searchParams.get("back"));
    if (!me.login || !keys) {
      back(res, to, { ok: false, text: !keys ? "Add tira's Atlassian app under Setup first." : "Sign in with GitHub first." });
      return Promise.resolve();
    }
    const state = randomBytes(24).toString("hex");
    pendingJira.set(state, { login: me.login, until: Date.now() + 10 * 60_000, back: to, tab: url.searchParams.get("tab") === "1" });
    c.send(res, 302, "text/plain; charset=utf-8", "", { Location: at.authorizeUrl(keys.clientId, redirectUri(host), state) });
    return Promise.resolve();
  };

  // what connecting Jira says: no site, the one it picked, or pick one
  const connectedText = (sites: number, one: { url: string } | undefined) => {
    if (sites === 0) return "Connected, but your Atlassian account has no Jira site.";
    return one ? `Connected to Jira ${one.url}. Pick a project to link.` : "Connected. Pick a Jira site, then a project.";
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
      done({ ok: true, text: connectedText(sites.length, one) });
    } catch (err) {
      done({ ok: false, text: `Jira wasn't connected (${(err as Error).message}).` });
    }
  };

  const jiraSite = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const to = backOf(form.get("back")) === "/settings" ? "/settings#linked" : backOf(form.get("back"));
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
    back(res, "/settings#linked", { ok: true, text: "Jira disconnected: tira no longer holds your Atlassian sign-in." });
  };

  // ---------- sync ----------
  const syncPost = async (req: IncomingMessage, res: ServerResponse, _url: URL, host: string) => {
    const form = await c.formOf(req, res, host);
    if (form === undefined) return;
    const to = "/"; // Sync is the board's (Isha, 2026-10-26), not a setting
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
    "POST /integrations/setup/reveal": revealPost,
    "POST /integrations/agents/connect": agentConnect,
    "POST /integrations/agents/revoke": agentRevoke,
    "POST /integrations/agents/wake": agentWake,
    "POST /integrations/agents/test": agentTest,
    "POST /integrations/agents/heard": agentHeard,
    "POST /integrations/link": linkPost,
    "POST /integrations/people": peoplePost,
    "POST /integrations/accounts": accountsPost,
    "POST /onboarding": onboardingPost,
    "POST /integrations/profile": profilePost,
    "GET /signup/email": emailGet,
    "POST /signup/email": emailPost,
    "GET /u": personPage,
    "GET /projects": projectsPage,
    "GET /inbox": inboxPage,
    "POST /invites": invitesPost,
    "POST /inbox/notes": notesPost,
    "POST /integrations/github/disconnect": githubDisconnect,
    "GET /integrations/jira/connect": jiraConnect,
    "GET /integrations/jira/callback": jiraCallback,
    "POST /integrations/jira/site": jiraSite,
    "POST /integrations/jira/disconnect": jiraDisconnect,
    "POST /signin/start": signinStart,
    "GET /signin/start": async (_req: IncomingMessage, res: ServerResponse) => { back(res, "/welcome"); }, // a reload of the button's address
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
  team: "People who can see and work on this project, and the agents connected to it.",
  profile: "Who you are on tira: your name, your email, and the username people add you by.",
  linked: "The GitHub and Jira accounts tira uses for you, in every project.",
  agents: "Let AI agents work on this project's tasks. Each one shows on the board under its own name, and you can revoke it here.",
  appearance: "How tira looks in this browser: it follows your computer unless you pick one.",
  accounts: "Accounts you removed from this tira: signed out, unable to sign in, and their agents stopped. Their projects stay with their other admins.",
  github: "This project's repository. A pull request that names a task links to it; a merged one is its proof.",
  jira: "The Jira project this project mirrors into. tira leads: nothing moves in Jira until someone syncs.",
  setup: "tira's own GitHub and Atlassian apps, made once per machine.",
  delete: "It leaves tira's project list and its board closes, for everyone. tira never erases: its history stays in the log.",
};

const descOf = (id: string): string | undefined => (DESC as Record<string, string | undefined>)[id];

// A settings page, after GitHub's: the sections on the left (the tira mark goes back to the board),
// the page across the middle, help on the right; ☰ hides the sections, as on the board. Account settings are yours; Project settings name
// their project.
// A section: its id and label, and what it shows beside the label ("on": a green dot, for something
// linked; else a count). An empty id is a group's label in the list.
type Section = [id: string, label: string, mark?: string];
interface SettingsOf { title: string; label: string; project?: { stream: string; name: string }; sections: Section[] }
const navMark = (mark: string | undefined) => {
  if (mark === undefined || mark === "") return "";
  return mark === "on" ? `<span class="set-dot" title="Linked"><span class="vh"> (linked)</span></span>` : `<span class="set-count">${esc(mark)}</span>`;
};
const navItem = ([id, label, mark]: Section) => (id === ""
  ? `<p class="set-group">${esc(label)}</p>`
  : `<a class="set-link" href="#${id}">${SET_ICON[id] ?? ""}${label}${navMark(mark)}</a>`);
function settingsPage(o: SettingsOf, body: string, help: string, script = ""): string {
  // one section at a time (Isha, 2026-10-26, after Chrome's): the one the address names, else the first
  const first = o.sections.find(([id]) => id !== "")?.[0];
  if (first) body = body.replace(`id="${first}"`, `id="${first}" data-default`);
  const nav = `<nav class="set-nav" aria-label="${esc(o.label)}">${brand("/")}<p class="set-k">${esc(o.label)}</p>`
    + (o.project === undefined ? "" : `<p class="set-proj">${projectMark(o.project.stream, o.project.name)}<span title="${esc(o.project.name)}">${esc(o.project.name)}</span></p>`)
    + o.sections.map(navItem).join("") + `</nav>`;
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
// at: the address tira answers at, as GitHub and Atlassian must be told it (a hosted tira's, not
// localhost: Isha, 2026-10-26)
type HelpAt = { address: string; hosted: boolean };
function helpPanel(at: HelpAt, name?: string): string {
  const home = esc(at.address);
  // Atlassian takes one callback per app: a tira at another address needs an app of its own
  const jiraWhere: [string, string, string] = at.hosted
    ? ["Why does Jira need its own app here?", `Atlassian sends you back to one address per app, and this tira's is <code>${home}/integrations/jira/callback</code>. A tira at another address (on your computer, say) needs an Atlassian app of its own.`, "localhost callback redirect connect address url port own app hosted"]
    : ["Why does Jira need localhost?", `Atlassian sends you back to tira's callback on localhost. Open tira at <code>${home}</code> to connect Jira.`, "localhost callback redirect connect address url port"];
  // a question, its answer, and the words someone might type for it
  const qa: [string, string, string][] = [
    ["How do I make tira's GitHub app?", `On GitHub: Settings → Developer settings → OAuth Apps → New. Homepage <code>${home}</code>, callback <code>${home}/signin/github/callback</code>, exactly (a GitHub App without wildcard matching takes only that address). Tick Enable Device Flow, then paste its Client ID under Setup. For sign-in in one click (straight to GitHub and back, no code), generate a client secret there too and paste it beside the Client ID.`, "github app oauth client id secret device flow setup create sign in code direct"],
    ["How do I make the Atlassian app for Jira?", `In Atlassian's developer console: Create → OAuth 2.0. Jira scopes <code>read:jira-work</code>, <code>write:jira-work</code>, <code>read:jira-user</code>. Callback <code>${home}/integrations/jira/callback</code>, exactly (one per app). Paste its Client ID and secret under Setup.`, "atlassian jira app oauth scopes console client secret create"],
    ["Where are my keys and tokens kept?", "In tira's private store, sealed, and never in the project's log. tira's own app keys show as dots in Setup; only this tira's owner can show or copy them, one at a time.", "keys tokens secret stored kept saved private safe credentials password"],
    ["What does Sync do?", "Sync is on the board, in the bar above it. It links pull requests that name a task, makes a Jira issue for each task, and brings moves made in Jira back as commands, which tira's rules may refuse. A merged pull request counts as proof of work.", "sync syncing pull request pr issue mirror update proof merge"],
    ["Who can sign in?", "Anyone with a GitHub account. Each project is seen only by its own people: whoever makes a project is its admin, and its admins add people by GitHub username in Project settings → Team. Your username is in Account settings, to send to an admin.", "sign signin login admin people access invite add user member team join username"],
    ["How do my agents use tira?", "Through tira's MCP server, each with its own token and name. In Project settings → Connect agents: choose your app (Claude Code, Cursor, VS Code or Claude Desktop), name your agent, then do the one thing it shows in that app and test the connection. Agents can see what's next, start, complete with proof, block, add subtasks and file ideas; tira's rules apply as they do to you, and cancelling or unblocking stays with people. Revoke an agent there to stop it.", "agent agents claude mcp ai bot automation code assistant tools"],
    jiraWhere,
  ];
  const hi = name ? `Hi ${esc(name)}! I'm tira's help.` : "Hi! I'm tira's help.";
  return `<aside class="set-help" aria-label="Help centre" data-help><details class="hc" data-remember="tira-help">`
    + `<summary class="help-head" title="Help centre: open or fold"><span class="av tira">?</span><span class="hc-t"><b>Help centre</b><small><i class="hc-on" aria-hidden="true"></i>Answers right away</small></span><span class="hc-fold" aria-hidden="true"></span></summary>`
    + `<div class="hc-body"><div class="hc-log" role="log" aria-live="polite" aria-label="Conversation" data-help-log>`
    + `<div class="msg from-tira"><span class="av tira" aria-hidden="true">t</span><div class="msg-b"><p class="bubble">${hi} I can answer questions about setting up GitHub, Jira and Sync.</p><p class="bubble">Pick a question, or type your own.</p><span class="msg-meta">tira · Help centre</span></div></div></div>`
    + `<div class="hc-suggest" data-help-suggest><p class="hc-sk" data-help-sk>Suggested</p>`
    + qa.map(([q, a, keys]) => `<details class="hc-qa" data-keys="${esc(keys)}"><summary class="hc-chip">${esc(q)}</summary><p class="bubble">${a}</p></details>`).join("")
    + `</div><div class="hc-bottom" data-help-bottom hidden><form class="hc-compose" data-help-ask><input name="q" aria-label="Ask a question" placeholder="Ask a question…" autocomplete="off" maxlength="200"><button class="hc-send" type="submit" aria-label="Send" disabled>${SEND}</button></form>`
    + `<p class="hc-foot">Built-in answers: what you type stays on this page.</p></div></div></details></aside>`;
}

