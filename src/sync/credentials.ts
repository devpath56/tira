// tira's private store: one file on this machine ($TIRA_HOME, default
// ~/.config/tira/credentials.json, readable by its owner only). Never the event log, never the
// page, never a message. It holds:
//   apps       the keys of tira's own GitHub and Atlassian apps (typed into the Integrations page)
//   github     each signed-in person's GitHub token, by GitHub login (from GitHub's device sign-in)
//   atlassian  each person's Atlassian sign-in, by GitHub login (access and refresh tokens, site)
//   jira       Jira API-token logins by site (tira connect-jira, for a terminal with no browser)
//   sessions   who each page session is: only a hash of the session id, so the file can't sign anyone in
//   access     who may sign in: the admin (the first person to sign in), the people the admin
//              added, and how people reach the admin to be added
//   pageToken  the random token tira serve's forms carry, made once, so a restart doesn't
//              turn every open page stale
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JiraLogin { email: string; token: string }
export interface AppKeys { github?: { clientId: string }; atlassian?: { clientId: string; secret: string } }
export interface GitHubAuth { token: string; name?: string }
export interface AtlassianAuth {
  access: string;
  refresh?: string;
  expiresAt: number; // ms since the epoch
  cloudId?: string; // the Jira site picked, when there is one
  site?: string; // its address, e.g. https://acme.atlassian.net
  sites?: { id: string; url: string; name: string }[]; // every site the sign-in can reach
}

// GitHub logins, compared as GitHub does: without regard to case
export interface Access { admin?: string; members?: string[]; contact?: { name?: string; email?: string } }

interface Stored {
  apps?: AppKeys;
  access?: Access;
  pageToken?: string;
  github?: Record<string, GitHubAuth>;
  atlassian?: Record<string, AtlassianAuth>;
  jira?: Record<string, JiraLogin>;
  sessions?: Record<string, { login: string; at: string }>;
}

type Env = Record<string, string | undefined>;
export const tiraHome = (env: Env = process.env): string => env.TIRA_HOME ?? join(homedir(), ".config", "tira");
const file = (env: Env) => join(tiraHome(env), "credentials.json");

function read(env: Env): Stored {
  try {
    return JSON.parse(readFileSync(file(env), "utf8")) as Stored;
  } catch {
    return {}; // none yet, or unreadable: as if none
  }
}

function update(env: Env, change: (s: Stored) => void): void {
  const dir = tiraHome(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = read(env);
  change(now);
  writeFileSync(file(env), `${JSON.stringify(now, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file(env), 0o600); // an existing file keeps its old mode otherwise
}

export function saveJiraLogin(site: string, login: JiraLogin, env: Env = process.env): void {
  update(env, (s) => { s.jira = { ...(s.jira ?? {}), [site]: { email: login.email, token: login.token } }; });
}

export function jiraLogin(site: string, env: Env = process.env): JiraLogin | undefined {
  const l = read(env).jira?.[site];
  return l && typeof l.email === "string" && typeof l.token === "string" && l.token !== "" ? l : undefined;
}

export const appKeys = (env: Env = process.env): AppKeys => read(env).apps ?? {};
export function saveAppKeys(keys: AppKeys, env: Env = process.env): void {
  update(env, (s) => { s.apps = { ...(s.apps ?? {}), ...keys }; });
}

export const githubAuth = (login: string, env: Env = process.env): GitHubAuth | undefined => read(env).github?.[login];
export function saveGithubAuth(login: string, auth: GitHubAuth, env: Env = process.env): void {
  update(env, (s) => { s.github = { ...(s.github ?? {}), [login]: auth }; });
}

export const atlassianAuth = (login: string, env: Env = process.env): AtlassianAuth | undefined => read(env).atlassian?.[login];
export function saveAtlassianAuth(login: string, auth: AtlassianAuth | undefined, env: Env = process.env): void {
  update(env, (s) => {
    const all = { ...(s.atlassian ?? {}) };
    if (auth === undefined) delete all[login];
    else all[login] = auth;
    s.atlassian = all;
  });
}

export function pageToken(env: Env = process.env): string {
  const now = read(env).pageToken;
  if (typeof now === "string" && /^[0-9a-f]{48}$/.test(now)) return now;
  const made = randomBytes(24).toString("hex");
  update(env, (s) => { s.pageToken = made; });
  return made;
}

export const access = (env: Env = process.env): Access => read(env).access ?? {};
export function saveAccess(change: (a: Access) => Access, env: Env = process.env): void {
  update(env, (s) => { s.access = change(s.access ?? {}); });
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const isAdmin = (a: Access, login: string): boolean => a.admin !== undefined && same(a.admin, login);
// anyone, until there is an admin (the first to sign in becomes it); then the admin and the people they added
export const mayEnter = (a: Access, login: string): boolean => a.admin === undefined || isAdmin(a, login) || (a.members ?? []).some((m) => same(m, login));
// someone the admin removed: tira forgets their GitHub and Atlassian sign-ins and their sessions
export function forget(login: string, env: Env = process.env): void {
  update(env, (s) => {
    const github = { ...(s.github ?? {}) };
    const atlassian = { ...(s.atlassian ?? {}) };
    for (const k of Object.keys(github)) if (same(k, login)) delete github[k];
    for (const k of Object.keys(atlassian)) if (same(k, login)) delete atlassian[k];
    s.github = github;
    s.atlassian = atlassian;
    s.sessions = Object.fromEntries(Object.entries(s.sessions ?? {}).filter(([, v]) => !same(v.login, login)));
  });
}

const hashed = (id: string) => createHash("sha256").update(id).digest("hex");
export const sessionLogin = (id: string, env: Env = process.env): string | undefined => read(env).sessions?.[hashed(id)]?.login;
export function saveSession(id: string, login: string, env: Env = process.env): void {
  update(env, (s) => { s.sessions = { ...(s.sessions ?? {}), [hashed(id)]: { login, at: new Date().toISOString() } }; });
}
export function dropSession(id: string, env: Env = process.env): void {
  update(env, (s) => {
    const all = { ...(s.sessions ?? {}) };
    delete all[hashed(id)];
    s.sessions = all;
  });
}
