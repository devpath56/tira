// tira's private store: people's accounts, never the event log, never the page, never a message.
// When tira's data is in Postgres ($TIRA_DATABASE_URL), the accounts are kept there too, sealed
// with $TIRA_SECRET_KEY, shared by everyone on that database (accounts-pg.ts; Isha, 2026-10-22);
// otherwise (tests, a first try with no database yet) in one file on this machine ($TIRA_HOME,
// default ~/.config/tira/credentials.json, readable by its owner only). They hold:
//   apps       the keys of tira's own GitHub and Atlassian apps (typed into Account settings)
//   github     each signed-in person's GitHub token, by GitHub login (from GitHub's device sign-in)
//   atlassian  each person's Atlassian sign-in, by GitHub login (access and refresh tokens, site)
//   sessions   who each page session is: only a hash of the session id, so the store can't sign
//              anyone in; a session lasts 30 days in a remembered browser, else 12 hours at most
//   names      the name each person chose to be shown as (Account settings), by login
//   emails     the email each person gave when they signed up, by login
//   access     this tira's owner (the first person to sign in, or TIRA_ADMIN), and, from before
//              each project had its own people, the people every project then had
//   blocked    the accounts the owner removed: they can't sign in
//   projects   each project's people: its admins and members (Isha, 2026-10-25)
//   seen       what each person has seen or put away: the first-time tour, the Get started
//              checklist (Isha, 2026-10-26), so a new browser doesn't show them again
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
import { BROWSER_SESSION_HOURS, PostgresAccounts, SESSION_DAYS, type Access, type Accounts, type AppKeys, type AtlassianAuth, type GitHubAuth, type Invite, type Note, type ProjectPeople, type StoredFile, type Wake, type WakeRun } from "./accounts-pg.ts";

export type { Access, AppKeys, AtlassianAuth, GitHubAuth, Invite, Note, ProjectPeople, StoredFile, Wake, WakeRun } from "./accounts-pg.ts";
export { AccountsRefused } from "./accounts-pg.ts";
export interface JiraLogin { email: string; token: string }

interface Stored extends Accounts {
  jira?: Record<string, JiraLogin>;
  pageToken?: string;
}

type Env = Record<string, string | undefined>;
// settings that name no home take the process's (in tests, a throwaway one: test/hermetic.ts)
// before this machine's own
export const tiraHome = (env: Env = process.env): string => env.TIRA_HOME ?? process.env.TIRA_HOME ?? join(homedir(), ".config", "tira");
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
// someone's login as GitHub spells it, once they've signed in here (asked in any case)
export const knownLogin = (login: string, env: Env = process.env): string | undefined => Object.keys(read(env).github ?? {}).find((k) => k.toLowerCase() === login.toLowerCase());
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

// this tira's owner and the people from before projects had their own; with no owner yet, the one
// the server's settings name (TIRA_ADMIN), if any
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
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// this tira's owner: its setup (tira's own apps), and removing accounts; never anyone's projects
export const isOwner = (a: Access, login: string): boolean => a.admin !== undefined && same(a.admin, login);

// Anyone with GitHub signs in (Isha, 2026-10-25), but for an account the owner removed.
export const isBlocked = (login: string, env: Env = process.env): boolean => (read(env).blocked ?? []).some((b) => same(b, login));
export const blockedNow = (env: Env = process.env): string[] => read(env).blocked ?? [];
export async function block(login: string, by: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.block(login, by);
  update(env, (s) => { if (!(s.blocked ?? []).some((b) => same(b, login))) s.blocked = [...(s.blocked ?? []), login]; });
}
export async function unblock(login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.unblock(login);
  update(env, (s) => { s.blocked = (s.blocked ?? []).filter((b) => !same(b, login)); });
}

// Invites to projects (Isha, 2026-10-26): an admin invites someone by GitHub username; they see the
// project once they accept. The ones not answered yet, oldest first; a new one (true when it's new);
// and its end, when it's accepted, declined or taken back.
export const invitesNow = (env: Env = process.env): Invite[] => read(env).invites ?? [];
export async function invite(stream: string, login: string, by: string, env: Env = process.env): Promise<boolean> {
  const pg = postgresAccounts(env);
  if (pg) return pg.invite(stream, login, by);
  let added = false;
  update(env, (s) => {
    if ((s.invites ?? []).some((x) => x.stream === stream && same(x.login, login))) return;
    added = true;
    s.invites = [...(s.invites ?? []), { stream, login, by, at: new Date().toISOString() }];
  });
  return added;
}
export async function dropInvite(stream: string, login: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.dropInvite(stream, login);
  update(env, (s) => { s.invites = (s.invites ?? []).filter((x) => !(x.stream === stream && same(x.login, login))); });
}

// Agents that start when they're @mentioned (Isha, 2026-10-26): each one's Claude Code routine, by
// project and agent (its token sealed on Postgres; in the private file as other tokens are), and
// the last start of each agent on each task (its session, to watch).
export const wakesOf = (stream: string, env: Env = process.env): Wake[] => (read(env).wakes ?? []).filter((w) => w.stream === stream);
export async function saveWake(w: Omit<Wake, "at">, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveWake(w);
  update(env, (s) => { s.wakes = [...(s.wakes ?? []).filter((x) => !(x.stream === w.stream && x.agent === w.agent)), { ...w, at: new Date().toISOString() }]; });
}
export async function dropWake(stream: string, agent: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.dropWake(stream, agent);
  update(env, (s) => { s.wakes = (s.wakes ?? []).filter((x) => !(x.stream === stream && x.agent === agent)); });
}
export const wakeRunsOf = (stream: string, env: Env = process.env): WakeRun[] => (read(env).wakeRuns ?? []).filter((r) => r.stream === stream);
export async function saveWakeRun(r: Omit<WakeRun, "at">, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveWakeRun(r);
  const same3 = (x: WakeRun) => x.stream === r.stream && x.task === r.task && x.agent === r.agent;
  update(env, (s) => { s.wakeRuns = [...(s.wakeRuns ?? []).filter((x) => !same3(x)), { ...r, at: new Date().toISOString() }]; });
}

// Files people added to tasks (src/fold/files.ts): in Postgres when the accounts are, else one file
// each in this computer's files folder (its name the id, beside it what it is), readable by its owner only.
const filesDir = (env: Env) => join(tiraHome(env), "files");
export async function saveFile(f: StoredFile, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveFile(f);
  const dir = filesDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { bytes, ...about } = f;
  writeFileSync(join(dir, f.id), bytes, { mode: 0o600 });
  writeFileSync(join(dir, `${f.id}.json`), JSON.stringify(about), { mode: 0o600 });
}
export async function fileOf(id: string, env: Env = process.env): Promise<StoredFile | undefined> {
  if (!/^[0-9a-f]{24}$/.test(id)) return undefined; // only ever a name tira made
  const pg = postgresAccounts(env);
  if (pg) return pg.fileOf(id);
  try {
    const about = JSON.parse(readFileSync(join(filesDir(env), `${id}.json`), "utf8")) as Omit<StoredFile, "bytes">;
    return { ...about, bytes: readFileSync(join(filesDir(env), id)) };
  } catch {
    return undefined; // no such file
  }
}

// Notes to whoever invited someone (Isha, 2026-10-26): "devansh accepted your invite to X", or
// declined it. One per invite (a later answer replaces it), in their Inbox until they put it away.
export const notesFor = (login: string, env: Env = process.env): Note[] => (read(env).notes ?? []).filter((n) => same(n.to, login));
export async function addNote(n: Omit<Note, "at">, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.addNote(n);
  const mine = (x: Note) => same(x.to, n.to) && x.stream === n.stream && same(x.who, n.who);
  update(env, (s) => { s.notes = [...(s.notes ?? []).filter((x) => !mine(x)), { ...n, at: new Date().toISOString() }]; });
}
export async function dropNote(to: string, stream: string, who: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.dropNote(to, stream, who);
  update(env, (s) => { s.notes = (s.notes ?? []).filter((x) => !(same(x.to, to) && x.stream === stream && same(x.who, who))); });
}

// What someone has seen or put away ("tour": the first-time tour; "checklist-hidden": the Get
// started checklist), on their account rather than in one browser.
export const hasSeen = (login: string, what: string, env: Env = process.env): boolean => (read(env).seen?.[login] ?? []).includes(what);
export async function markSeen(login: string, what: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.markSeen(login, what);
  update(env, (s) => {
    const mine = s.seen?.[login] ?? [];
    if (!mine.includes(what)) s.seen = { ...s.seen, [login]: [...mine, what] };
  });
}
export async function unmarkSeen(login: string, what: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.unmarkSeen(login, what);
  update(env, (s) => { s.seen = { ...s.seen, [login]: (s.seen?.[login] ?? []).filter((x) => x !== what) }; });
}

// the email someone gave
export const emailOf = (login: string, env: Env = process.env): string | undefined => read(env).emails?.[login];
export async function saveEmail(login: string, email: string, env: Env = process.env): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveEmail(login, email);
  update(env, (s) => { s.emails = { ...s.emails, [login]: email }; });
}

// Each project's people, as saved (a project made before projects had their own has none saved:
// src/serve/team.ts works them out), and a change to one project's, made as one: change gets them
// as they are (undefined: none saved) and returns them as they're to be, or undefined to leave them.
// No one at all: none saved. True when they were written.
export const savedProjects = (env: Env = process.env): Record<string, ProjectPeople> => read(env).projects ?? {};
export async function saveProject(stream: string, change: (p: ProjectPeople | undefined) => ProjectPeople | undefined, env: Env = process.env): Promise<boolean> {
  const pg = postgresAccounts(env);
  if (pg) return pg.saveProject(stream, change);
  let wrote = false;
  update(env, (s) => {
    const all = { ...s.projects };
    const next = change(all[stream]);
    if (next === undefined) return;
    wrote = true;
    if (next.admins.length === 0 && next.members.length === 0) delete all[stream];
    else all[stream] = { admins: [...next.admins], members: [...next.members] };
    s.projects = all;
  });
  return wrote;
}

// someone the owner removed: signed out everywhere, at once. Their GitHub and Jira links stay until
// they unlink them themselves (Isha, 2026-10-22); they can't sign in meanwhile (isBlocked).
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
// who a session is, while it lasts: 30 days in a browser its person chose to remember (Remember
// this browser), else 12 hours at most (its cookie ends with the browser, in any case)
export function sessionLogin(id: string, env: Env = process.env): string | undefined {
  const s = read(env).sessions?.[hashed(id)];
  const lasts = s?.remember === false ? BROWSER_SESSION_HOURS * 3_600_000 : SESSION_DAYS * 86_400_000;
  return s && Date.parse(s.at) > Date.now() - lasts ? s.login : undefined;
}
export async function saveSession(id: string, login: string, env: Env = process.env, remember = true): Promise<void> {
  const pg = postgresAccounts(env);
  if (pg) return pg.addSession(hashed(id), login, remember);
  update(env, (s) => { s.sessions = { ...s.sessions, [hashed(id)]: { login, at: new Date().toISOString(), ...(remember ? {} : { remember: false as const }) } }; });
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
