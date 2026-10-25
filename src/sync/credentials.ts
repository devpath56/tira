// tira's private store: people's accounts, never the event log, never the page, never a message.
// When tira's data is in Postgres ($TIRA_DATABASE_URL), the accounts are kept there too, sealed
// with $TIRA_SECRET_KEY, shared by everyone on that database (accounts-pg.ts; Isha, 2026-10-22);
// otherwise (tests, a first try with no database yet) in one file on this machine ($TIRA_HOME,
// default ~/.config/tira/credentials.json, readable by its owner only). They hold:
//   apps       the keys of tira's own GitHub and Atlassian apps (typed into Account settings)
//   github     each signed-in person's GitHub token, by GitHub login (from GitHub's device sign-in)
//   atlassian  each person's Atlassian sign-in, by GitHub login (access and refresh tokens, site)
//   sessions   who each page session is: only a hash of the session id, so the store can't sign
//              anyone in; a session lasts 30 days, like its cookie
//   names      the name each person chose to be shown as (Account settings), by login
//   access     who may sign in: the admin (the first person to sign in), the people the admin
//              added, and how people reach the admin to be added
// and, always in this computer's file (they belong to this computer, not to the team):
//   jira       Jira API-token logins by site (tira connect-jira, for a terminal with no browser)
//   pageToken  the random token tira serve's forms carry, made once, so a restart doesn't
//              turn every open page stale
//
// Reading is synchronous: from the file, or from the snapshot of Postgres that refreshAccounts
// takes (tira serve takes one at the start of each request). Every change is a promise: it is in
// the database (or the file) when it resolves.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPostgresUrl, liveDatabase } from "../store/open.ts";
import { PostgresAccounts, SESSION_DAYS, type Access, type Accounts, type AppKeys, type AtlassianAuth, type GitHubAuth } from "./accounts-pg.ts";

export type { Access, AppKeys, AtlassianAuth, GitHubAuth } from "./accounts-pg.ts";
export { AccountsRefused } from "./accounts-pg.ts";
export interface JiraLogin { email: string; token: string }

interface Stored extends Accounts {
  jira?: Record<string, JiraLogin>;
  pageToken?: string;
}

type Env = Record<string, string | undefined>;
export const tiraHome = (env: Env = process.env): string => env.TIRA_HOME ?? join(homedir(), ".config", "tira");
const file = (env: Env) => join(tiraHome(env), "credentials.json");

function readFile(env: Env): Stored {
  try {
    return JSON.parse(readFileSync(file(env), "utf8")) as Stored;
  } catch {
    return {}; // none yet, or unreadable: as if none
  }
}

function update(env: Env, change: (s: Stored) => void): void {
  const dir = tiraHome(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = readFile(env);
  change(now);
  writeFileSync(file(env), `${JSON.stringify(now, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file(env), 0o600); // an existing file keeps its old mode otherwise
}

// ---------- where the accounts are ----------
// Postgres when tira's data is (the same database and schema), one connection pool per process
const pools = new Map<string, PostgresAccounts>();
export function postgresAccounts(env: Env = process.env): PostgresAccounts | undefined {
  const db = env.TIRA_DATABASE_URL ?? env.TIRA_DB;
  if (db === undefined || !isPostgresUrl(db)) return undefined;
  const u = new URL(liveDatabase(undefined, env)); // the same rules as the log's (TLS off this machine)
  const schema = u.searchParams.get("schema") ?? (env.TIRA_SCHEMA?.trim() || "tira");
  u.searchParams.delete("schema"); // tira's, not the driver's
  const at = `${u.toString()}|${schema}|${createHash("sha256").update(env.TIRA_SECRET_KEY ?? "").digest("hex")}`;
  let p = pools.get(at);
  if (p === undefined) pools.set(at, (p = new PostgresAccounts(u.toString(), schema, env.TIRA_SECRET_KEY)));
  return p;
}

// Read the accounts again (Postgres only; the file is read each time anyway).
export async function refreshAccounts(env: Env = process.env): Promise<void> {
  await postgresAccounts(env)?.refresh();
}

// This computer's old file, brought into Postgres once (what the database lacks; nothing it holds
// changes). Undefined when the accounts aren't in Postgres or the file has none.
export async function importAccountsFile(env: Env = process.env): Promise<Awaited<ReturnType<PostgresAccounts["importFrom"]>> | undefined> {
  const pg = postgresAccounts(env);
  const old = readFile(env);
  if (!pg || !(old.apps || old.access || old.github || old.atlassian || old.names || old.sessions)) return undefined;
  return pg.importFrom(old);
}

export async function closeAccounts(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.close()));
}

function read(env: Env): Stored {
  const pg = postgresAccounts(env);
  if (!pg) return readFile(env);
  const local = readFile(env);
  return { ...pg.snapshot(), ...(local.jira ? { jira: local.jira } : {}), ...(local.pageToken ? { pageToken: local.pageToken } : {}) };
}

// ---------- this computer's own ----------
export function saveJiraLogin(site: string, login: JiraLogin, env: Env = process.env): void {
  update(env, (s) => { s.jira = { ...(s.jira ?? {}), [site]: { email: login.email, token: login.token } }; });
}

export function jiraLogin(site: string, env: Env = process.env): JiraLogin | undefined {
  const l = readFile(env).jira?.[site];
  return l && typeof l.email === "string" && typeof l.token === "string" && l.token !== "" ? l : undefined;
}

export function pageToken(env: Env = process.env): string {
  const now = readFile(env).pageToken;
  if (typeof now === "string" && /^[0-9a-f]{48}$/.test(now)) return now;
  const made = randomBytes(24).toString("hex");
  update(env, (s) => { s.pageToken = made; });
  return made;
}

// ---------- everyone's ----------
// tira's apps as the server's settings name them (a public tira's: src/serve/public.ts), over the
// keys typed into Account settings
const settingsApps = (env: Env): AppKeys => {
  const gh = env.TIRA_GITHUB_CLIENT_ID?.trim();
  const ghSecret = env.TIRA_GITHUB_CLIENT_SECRET?.trim();
  const at = env.TIRA_ATLASSIAN_CLIENT_ID?.trim();
  const atSecret = env.TIRA_ATLASSIAN_CLIENT_SECRET?.trim();
  const keys: AppKeys = {};
  if (gh) keys.github = ghSecret ? { clientId: gh, secret: ghSecret } : { clientId: gh };
  if (at && atSecret) keys.atlassian = { clientId: at, secret: atSecret };
  return keys;
};
export const appKeys = (env: Env = process.env): AppKeys => ({ ...read(env).apps, ...settingsApps(env) });
export async function saveAppKeys(keys: AppKeys, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveApps(keys);
  update(env, (s) => { s.apps = { ...(s.apps ?? {}), ...keys }; });
}

export const githubAuth = (login: string, env: Env = process.env): GitHubAuth | undefined => read(env).github?.[login];
export async function saveGithubAuth(login: string, auth: GitHubAuth, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveGithub(login, auth);
  update(env, (s) => { s.github = { ...(s.github ?? {}), [login]: auth }; });
}

export const atlassianAuth = (login: string, env: Env = process.env): AtlassianAuth | undefined => read(env).atlassian?.[login];
export async function saveAtlassianAuth(login: string, auth: AtlassianAuth | undefined, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveAtlassian(login, auth);
  update(env, (s) => {
    const all = { ...(s.atlassian ?? {}) };
    if (auth === undefined) delete all[login];
    else all[login] = auth;
    s.atlassian = all;
  });
}

// who may sign in; with no admin yet, the one the server's settings name (TIRA_ADMIN), if any
export const access = (env: Env = process.env): Access => {
  const a = read(env).access ?? {};
  const named = env.TIRA_ADMIN?.trim();
  return a.admin === undefined && named ? { ...a, admin: named } : a;
};
export async function saveAccess(change: (a: Access) => Access, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveAccess(change);
  update(env, (s) => {
    const next = change(s.access ?? {});
    if (next.requests?.length === 0) delete next.requests; // none waiting: as Postgres reads it
    s.access = next;
  });
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const isAdmin = (a: Access, login: string): boolean => a.admin !== undefined && same(a.admin, login);
// someone who signed up and waits for the admin to approve them
export const hasAsked = (a: Access, login: string): boolean => (a.requests ?? []).some((r) => same(r, login));
// anyone, until there is an admin (the first to sign in becomes it); then the admin and the people they added
export const mayEnter = (a: Access, login: string): boolean => a.admin === undefined || isAdmin(a, login) || (a.members ?? []).some((m) => same(m, login));

// someone the admin removed: signed out everywhere, at once. Their GitHub and Jira links stay until
// they unlink them themselves (Isha, 2026-10-22); they can't sign in meanwhile (mayEnter).
export async function signOutEverywhere(login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.signOutEverywhere(login);
  update(env, (s) => {
    s.sessions = Object.fromEntries(Object.entries(s.sessions ?? {}).filter(([, v]) => !same(v.login, login)));
  });
}

// someone unlinking their own GitHub: tira forgets the token and signs them out everywhere (GitHub is
// how they sign in, so signing in again links it again)
export async function forgetGithub(login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.forgetGithub(login);
  update(env, (s) => {
    s.github = Object.fromEntries(Object.entries(s.github ?? {}).filter(([k]) => !same(k, login)));
    s.sessions = Object.fromEntries(Object.entries(s.sessions ?? {}).filter(([, v]) => !same(v.login, login)));
  });
}

// the name someone chose to be shown as (none: GitHub's name, else their login)
export const displayName = (login: string, env: Env = process.env): string | undefined => read(env).names?.[login];
export async function saveDisplayName(login: string, name: string | undefined, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveName(login, name);
  update(env, (s) => {
    const all = { ...(s.names ?? {}) };
    if (name === undefined) delete all[login];
    else all[login] = name;
    s.names = all;
  });
}

// everything tira holds for someone: their GitHub and Atlassian sign-ins and their sessions
export async function forget(login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.forget(login);
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
// who a session is, while it lasts (30 days, like its cookie)
export function sessionLogin(id: string, env: Env = process.env): string | undefined {
  const s = read(env).sessions?.[hashed(id)];
  return s && Date.parse(s.at) > Date.now() - SESSION_DAYS * 86_400_000 ? s.login : undefined;
}
export async function saveSession(id: string, login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.addSession(hashed(id), login);
  update(env, (s) => { s.sessions = { ...(s.sessions ?? {}), [hashed(id)]: { login, at: new Date().toISOString() } }; });
}
export async function dropSession(id: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.dropSession(hashed(id));
  update(env, (s) => {
    const all = { ...(s.sessions ?? {}) };
    delete all[hashed(id)];
    s.sessions = all;
  });
}
