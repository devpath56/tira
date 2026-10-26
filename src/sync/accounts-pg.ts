// People's accounts in Postgres, beside tira's log (Isha, 2026-10-22): about ten people each run
// `tira serve` on their own computer against one hosted Postgres, so who may sign in, each
// person's GitHub and Jira links, their sessions, the names they're shown by and tira's own app
// keys are kept there, shared, instead of in a file per computer (credentials.ts reads and writes
// through here when tira's data is in Postgres).
//
// - Every token and secret is sealed (AES-256-GCM) with a key made from $TIRA_SECRET_KEY, which is
//   never stored in the database: the database alone can sign no one in, and can't be read into
//   anyone's GitHub or Jira. Everyone sharing the database uses the same key (keep it with the
//   connection string). A seal is bound to its row (its table and login), so one can't be moved
//   onto someone else's.
// - Small tables in tira's schema, apart from the log (whose tables nothing here touches):
//   account_apps, account_access (one row each), account_github, account_atlassian, account_names,
//   account_emails (sealed), account_blocked (by GitHub login), account_projects (each project's
//   people: by project and login) and account_sessions (by a hash of the session id: the table
//   can't sign anyone in).
// - Links stay until their owner unlinks them; an admin removing someone only ends their sessions.
// - A session lasts 30 days when its browser is remembered (the person ticks Remember this browser),
//   else until the browser closes, and 12 hours at most (Isha, 2026-10-26).
// - What each page reads comes from a snapshot taken at the start of each request (refresh), so one
//   person's change shows on everyone's next page; every write goes to the database first.
import pg from "pg";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface AppKeys { github?: { clientId: string; secret?: string }; atlassian?: { clientId: string; secret: string } }
export interface GitHubAuth { token: string; name?: string }
type AppsRow = { github_client_id: string | null; github_secret: string | null; atlassian_client_id: string | null; atlassian_secret: string | null };
// who may sign in, from its row: the admin, the people added, those waiting to be, how to reach the admin
type AccessRow = { admin: string | null; members: string[]; requests: string[]; contact_name: string | null; contact_email: string | null };
function accessOf(r: AccessRow): Access {
  const a: Access = {};
  if (r.admin) a.admin = r.admin;
  if (r.members.length > 0) a.members = r.members;
  if (r.requests.length > 0) a.requests = r.requests;
  if (r.contact_name || r.contact_email) a.contact = { ...(r.contact_name ? { name: r.contact_name } : {}), ...(r.contact_email ? { email: r.contact_email } : {}) };
  return a;
}
export interface AtlassianAuth {
  access: string;
  refresh?: string;
  expiresAt: number; // ms since the epoch
  cloudId?: string; // the Jira site picked, when there is one
  site?: string; // its address, e.g. https://acme.atlassian.net
  sites?: { id: string; url: string; name: string }[]; // every site the sign-in can reach
}
// admin: this tira's owner (its setup, and removing accounts). members, requests and contact are
// from before each project had its own people (Isha, 2026-10-25): no longer changed, and members
// are the people of every project made before then.
export interface Access { admin?: string; members?: string[]; requests?: string[]; contact?: { name?: string; email?: string } }
// a project's people (Isha, 2026-10-25): its admins and its members, by GitHub login
export interface ProjectPeople { admins: string[]; members: string[] }

// what the accounts hold, as credentials.ts reads it
export interface Accounts {
  apps?: AppKeys;
  access?: Access;
  github?: Record<string, GitHubAuth>;
  atlassian?: Record<string, AtlassianAuth>;
  sessions?: Record<string, { login: string; at: string; remember?: false }>; // remember false: its browser isn't remembered
  names?: Record<string, string>;
  emails?: Record<string, string>; // the email each person gave, by login
  blocked?: string[]; // accounts the owner removed: they can't sign in
  projects?: Record<string, ProjectPeople>; // each project's people, by project (none: not set yet)
}

// why the accounts can't be used, in plain words (never the key or the connection string)
export class AccountsRefused extends Error {}

export const SESSION_DAYS = 30;
export const BROWSER_SESSION_HOURS = 12; // the most a sign-in lasts in a browser not remembered
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// ---------- sealing ----------
// "v1.<iv>.<tag>.<ciphertext>", base64url; the row it belongs to is its additional data.
export interface Sealer { seal(plain: string, row: string): string; open(sealed: string, row: string): string }
export function sealer(secret: string | undefined): Sealer {
  if (secret === undefined || secret.trim().length < 16) {
    throw new AccountsRefused("set TIRA_SECRET_KEY to a long random string (at least 16 characters), the same on every computer that shares this database: tira seals everyone's GitHub and Jira tokens with it");
  }
  const key = scryptSync(secret, "tira accounts v1", 32);
  return {
    seal(plain, row) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(row));
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    },
    open(sealed, row) {
      const [v, iv, tag, body] = sealed.split(".");
      if (v !== "v1" || iv === undefined || tag === undefined || body === undefined) throw new AccountsRefused(`a sealed account value (${row}) isn't one tira made`);
      try {
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        d.setAAD(Buffer.from(row));
        d.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
      } catch {
        throw new AccountsRefused(`TIRA_SECRET_KEY doesn't open the accounts (${row}): use the same key as everyone sharing this database`);
      }
    },
  };
}

// ---------- the tables ----------
const TABLES = ["account_apps", "account_access", "account_github", "account_atlassian", "account_names", "account_sessions", "account_emails", "account_blocked", "account_projects"];
const ddl = (s: string) => `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.account_apps (
  one BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (one),
  github_client_id TEXT, github_secret TEXT, atlassian_client_id TEXT, atlassian_secret TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ${s}.account_apps ADD COLUMN IF NOT EXISTS github_secret TEXT;
CREATE TABLE IF NOT EXISTS ${s}.account_access (
  one BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (one),
  admin TEXT, members TEXT[] NOT NULL DEFAULT '{}', contact_name TEXT, contact_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ${s}.account_access ADD COLUMN IF NOT EXISTS requests TEXT[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS ${s}.account_github (login TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${s}.account_atlassian (login TEXT PRIMARY KEY, auth TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${s}.account_names (login TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${s}.account_sessions (id_hash TEXT PRIMARY KEY, login TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE ${s}.account_sessions ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS ${s}.account_emails (login TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${s}.account_blocked (login TEXT PRIMARY KEY, by_login TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${s}.account_projects (
  stream TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (stream, login)
);
`;

export class PostgresAccounts {
  readonly schema: string;
  private readonly pool: pg.Pool;
  private readonly key: Sealer;
  private setup: Promise<void> | undefined;
  private now: Accounts | undefined;

  constructor(url: string, schema: string, secret: string | undefined) {
    this.schema = schema;
    if (!SCHEMA_NAME.test(schema)) throw new TypeError(`bad schema name: ${schema}`);
    this.key = sealer(secret); // no key: refused before anything is read or written
    this.pool = new pg.Pool({ connectionString: url, max: 2 });
    this.pool.on("error", () => {}); // a dropped idle connection reconnects on the next query
  }

  // The tables, made on first use when missing. Only then: in production tira may connect as a login
  // that can use these tables but create nothing (the schema's owner made them once), and even an
  // "if not exists" needs the right to create.
  private ready(): Promise<void> {
    this.setup ??= this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tira-accounts:${this.schema}`]);
      const made = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2)", [this.schema, TABLES]);
      // tables made before the GitHub app kept a secret (2026-10-23) get its column the same way,
      // tables made before sign-up requests (2026-10-25) get theirs, and sessions made before a
      // browser could be remembered (2026-10-26) theirs: the columns each must have
      const cols = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND ((table_name = 'account_apps' AND column_name = 'github_secret') OR (table_name = 'account_access' AND column_name = 'requests') OR (table_name = 'account_sessions' AND column_name = 'remember'))", [this.schema]);
      if ((made.rows[0]?.n ?? 0) < TABLES.length || cols.rowCount !== 3) await c.query(ddl(this.schema));
    }).catch((err: unknown) => {
      this.setup = undefined; // try again next time
      throw err;
    });
    return this.setup;
  }

  private async transaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await work(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  // What the accounts hold now (the last refresh); nothing until the first.
  snapshot(): Accounts {
    return this.now ?? {};
  }

  // Read everything again (a few rows per person): each page starts from what's in the database.
  async refresh(): Promise<void> {
    await this.ready();
    const s = this.schema;
    const [apps, acc, gh, at, names, sessions, emails, blocked, projects] = await Promise.all([
      this.pool.query(`SELECT github_client_id, github_secret, atlassian_client_id, atlassian_secret FROM ${s}.account_apps`),
      this.pool.query(`SELECT admin, members, requests, contact_name, contact_email FROM ${s}.account_access`),
      this.pool.query(`SELECT login, token, name FROM ${s}.account_github`),
      this.pool.query(`SELECT login, auth FROM ${s}.account_atlassian`),
      this.pool.query(`SELECT login, name FROM ${s}.account_names`),
      this.pool.query(`SELECT id_hash, login, at, remember FROM ${s}.account_sessions WHERE at > now() - make_interval(days => ${SESSION_DAYS})`),
      this.pool.query(`SELECT login, email FROM ${s}.account_emails`),
      this.pool.query(`SELECT login FROM ${s}.account_blocked ORDER BY at, login`),
      this.pool.query(`SELECT stream, login, role FROM ${s}.account_projects ORDER BY at, login`),
    ]);
    const out: Accounts = {};
    const a = apps.rows[0] as AppsRow | undefined;
    if (a) out.apps = this.appsOf(a);
    const x = acc.rows[0] as AccessRow | undefined;
    if (x) out.access = accessOf(x);
    out.github = Object.fromEntries((gh.rows as { login: string; token: string; name: string | null }[]).map((r) => [r.login, { token: this.key.open(r.token, `github:${r.login}`), ...(r.name ? { name: r.name } : {}) }]));
    out.atlassian = Object.fromEntries((at.rows as { login: string; auth: string }[]).map((r) => [r.login, JSON.parse(this.key.open(r.auth, `atlassian:${r.login}`)) as AtlassianAuth]));
    out.names = Object.fromEntries((names.rows as { login: string; name: string }[]).map((r) => [r.login, r.name]));
    out.sessions = Object.fromEntries((sessions.rows as { id_hash: string; login: string; at: Date; remember: boolean }[]).map((r) => [r.id_hash, { login: r.login, at: r.at.toISOString(), ...(r.remember ? {} : { remember: false as const }) }]));
    out.emails = Object.fromEntries((emails.rows as { login: string; email: string }[]).map((r) => [r.login, this.key.open(r.email, `email:${r.login}`)]));
    out.blocked = (blocked.rows as { login: string }[]).map((r) => r.login);
    out.projects = {};
    for (const r of projects.rows as { stream: string; login: string; role: string }[]) {
      const p = (out.projects[r.stream] ??= { admins: [], members: [] });
      (r.role === "admin" ? p.admins : p.members).push(r.login);
    }
    this.now = out;
  }

  // tira's own apps, from their row: each secret opened from its seal
  private appsOf(a: AppsRow): AppKeys {
    const keys: AppKeys = {};
    if (a.github_client_id) {
      keys.github = { clientId: a.github_client_id };
      if (a.github_secret) keys.github.secret = this.key.open(a.github_secret, "apps:github_secret");
    }
    if (a.atlassian_client_id && a.atlassian_secret) keys.atlassian = { clientId: a.atlassian_client_id, secret: this.key.open(a.atlassian_secret, "apps:atlassian_secret") };
    return keys;
  }

  // ---------- writes: the database first, then this snapshot again ----------
  private async write(sql: string, params: unknown[]): Promise<void> {
    await this.ready();
    await this.pool.query(sql, params);
    await this.refresh();
  }

  // tira's apps: what's given replaces what was, the rest stays
  async saveApps(keys: AppKeys): Promise<void> {
    const s = this.schema;
    await this.write(
      `INSERT INTO ${s}.account_apps (one, github_client_id, github_secret, atlassian_client_id, atlassian_secret) VALUES (TRUE, $1, $4, $2, $3)
       ON CONFLICT (one) DO UPDATE SET github_client_id = COALESCE($1, ${s}.account_apps.github_client_id), github_secret = COALESCE($4, ${s}.account_apps.github_secret),
         atlassian_client_id = COALESCE($2, ${s}.account_apps.atlassian_client_id), atlassian_secret = COALESCE($3, ${s}.account_apps.atlassian_secret), updated_at = now()`,
      [keys.github?.clientId ?? null, keys.atlassian?.clientId ?? null, keys.atlassian ? this.key.seal(keys.atlassian.secret, "apps:atlassian_secret") : null,
        keys.github?.secret ? this.key.seal(keys.github.secret, "apps:github_secret") : null],
    );
  }

  // who may sign in: changed as one, so two admins' changes at once don't undo each other
  async saveAccess(change: (a: Access) => Access): Promise<void> {
    await this.ready();
    const s = this.schema;
    await this.transaction(async (c) => {
      await c.query(`INSERT INTO ${s}.account_access (one) VALUES (TRUE) ON CONFLICT DO NOTHING`);
      const r = (await c.query(`SELECT admin, members, requests, contact_name, contact_email FROM ${s}.account_access WHERE one FOR UPDATE`)).rows[0] as AccessRow;
      const next = change(accessOf(r));
      await c.query(`UPDATE ${s}.account_access SET admin = $1, members = $2, requests = $3, contact_name = $4, contact_email = $5, updated_at = now() WHERE one`,
        [next.admin ?? null, next.members ?? [], next.requests ?? [], next.contact?.name ?? null, next.contact?.email ?? null]);
    });
    await this.refresh();
  }

  async saveGithub(login: string, auth: GitHubAuth): Promise<void> {
    const s = this.schema;
    await this.write(`INSERT INTO ${s}.account_github (login, token, name) VALUES ($1, $2, $3) ON CONFLICT (login) DO UPDATE SET token = $2, name = $3, updated_at = now()`,
      [login, this.key.seal(auth.token, `github:${login}`), auth.name ?? null]);
  }

  async saveAtlassian(login: string, auth: AtlassianAuth | undefined): Promise<void> {
    const s = this.schema;
    if (auth === undefined) return this.write(`DELETE FROM ${s}.account_atlassian WHERE lower(login) = lower($1)`, [login]);
    await this.write(`INSERT INTO ${s}.account_atlassian (login, auth) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET auth = $2, updated_at = now()`,
      [login, this.key.seal(JSON.stringify(auth), `atlassian:${login}`)]);
  }

  async saveName(login: string, name: string | undefined): Promise<void> {
    const s = this.schema;
    if (name === undefined) return this.write(`DELETE FROM ${s}.account_names WHERE login = $1`, [login]);
    await this.write(`INSERT INTO ${s}.account_names (login, name) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET name = $2, updated_at = now()`, [login, name]);
  }

  // the email someone gave (sealed: the database alone doesn't say who anyone is)
  async saveEmail(login: string, email: string): Promise<void> {
    const s = this.schema;
    await this.write(`INSERT INTO ${s}.account_emails (login, email) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET email = $2, updated_at = now()`, [login, this.key.seal(email, `email:${login}`)]);
  }

  // an account the owner removed (by: the owner), or let back in
  async block(login: string, by: string): Promise<void> {
    await this.write(`INSERT INTO ${this.schema}.account_blocked (login, by_login) VALUES ($1, $2) ON CONFLICT (login) DO NOTHING`, [login, by]);
  }
  async unblock(login: string): Promise<void> {
    await this.write(`DELETE FROM ${this.schema}.account_blocked WHERE lower(login) = lower($1)`, [login]);
  }

  // A project's people, changed as one (two admins' changes at once don't undo each other): change
  // gets them as they are (undefined: not set yet) and returns them as they're to be, or undefined to
  // leave them. No one at all: not set. True when they were written.
  async saveProject(stream: string, change: (p: ProjectPeople | undefined) => ProjectPeople | undefined): Promise<boolean> {
    await this.ready();
    const s = this.schema;
    const wrote = await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tira-project:${s}:${stream}`]);
      const rows = (await c.query(`SELECT login, role FROM ${s}.account_projects WHERE stream = $1 ORDER BY at, login`, [stream])).rows as { login: string; role: string }[];
      const now = rows.length === 0 ? undefined : { admins: rows.filter((r) => r.role === "admin").map((r) => r.login), members: rows.filter((r) => r.role === "member").map((r) => r.login) };
      const next = change(now);
      if (next === undefined) return false;
      const roles = new Map<string, string>([...next.members.map((l): [string, string] => [l, "member"]), ...next.admins.map((l): [string, string] => [l, "admin"])]);
      await c.query(`DELETE FROM ${s}.account_projects WHERE stream = $1 AND NOT (login = ANY($2))`, [stream, [...roles.keys()]]);
      // those still in keep when they joined; a new role is only a new role
      await c.query(`INSERT INTO ${s}.account_projects (stream, login, role) SELECT $1, l, r FROM unnest($2::text[], $3::text[]) AS t(l, r) ON CONFLICT (stream, login) DO UPDATE SET role = EXCLUDED.role`, [stream, [...roles.keys()], [...roles.values()]]);
      return true;
    });
    await this.refresh();
    return wrote;
  }

  // remember: whether its browser is remembered (30 days), or not (12 hours at most)
  async addSession(idHash: string, login: string, remember = true): Promise<void> {
    await this.write(`INSERT INTO ${this.schema}.account_sessions (id_hash, login, remember) VALUES ($1, $2, $3) ON CONFLICT (id_hash) DO UPDATE SET login = $2, at = now(), remember = $3`, [idHash, login, remember]);
  }

  async dropSession(idHash: string): Promise<void> {
    await this.write(`DELETE FROM ${this.schema}.account_sessions WHERE id_hash = $1`, [idHash]);
  }

  // someone removed by the admin: every session of theirs ends; their links stay
  async signOutEverywhere(login: string): Promise<void> {
    await this.write(`DELETE FROM ${this.schema}.account_sessions WHERE lower(login) = lower($1)`, [login]);
  }

  // someone unlinking their own GitHub: its token goes, and so do their sessions
  async forgetGithub(login: string): Promise<void> {
    await this.ready();
    const s = this.schema;
    await this.transaction(async (c) => {
      await c.query(`DELETE FROM ${s}.account_github WHERE lower(login) = lower($1)`, [login]);
      await c.query(`DELETE FROM ${s}.account_sessions WHERE lower(login) = lower($1)`, [login]);
    });
    await this.refresh();
  }

  // everything kept for someone
  async forget(login: string): Promise<void> {
    await this.ready();
    const s = this.schema;
    await this.transaction(async (c) => {
      for (const t of ["account_github", "account_atlassian", "account_sessions"]) await c.query(`DELETE FROM ${s}.${t} WHERE lower(login) = lower($1)`, [login]);
    });
    await this.refresh();
  }

  // A computer's old private file, brought over once: what the database doesn't hold yet is added,
  // nothing it holds is changed (run it again: nothing more). Says what it added.
  async importFrom(old: Accounts): Promise<{ apps: boolean; access: boolean; github: number; atlassian: number; names: number; sessions: number }> {
    await this.ready();
    const s = this.schema;
    const added = { apps: false, access: false, github: 0, atlassian: 0, names: 0, sessions: 0 };
    await this.transaction(async (c) => {
      const n = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount ?? 0;
      if (old.apps?.github || old.apps?.atlassian) {
        added.apps = (await n(`INSERT INTO ${s}.account_apps (one, github_client_id, github_secret, atlassian_client_id, atlassian_secret) VALUES (TRUE, $1, $4, $2, $3) ON CONFLICT DO NOTHING`,
          [old.apps.github?.clientId ?? null, old.apps.atlassian?.clientId ?? null, old.apps.atlassian ? this.key.seal(old.apps.atlassian.secret, "apps:atlassian_secret") : null,
            old.apps.github?.secret ? this.key.seal(old.apps.github.secret, "apps:github_secret") : null])) > 0;
      }
      if (old.access?.admin) {
        added.access = (await n(`INSERT INTO ${s}.account_access (one, admin, members, contact_name, contact_email) VALUES (TRUE, $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [old.access.admin, old.access.members ?? [], old.access.contact?.name ?? null, old.access.contact?.email ?? null])) > 0;
      }
      for (const [login, a] of Object.entries(old.github ?? {})) added.github += await n(`INSERT INTO ${s}.account_github (login, token, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [login, this.key.seal(a.token, `github:${login}`), a.name ?? null]);
      for (const [login, a] of Object.entries(old.atlassian ?? {})) added.atlassian += await n(`INSERT INTO ${s}.account_atlassian (login, auth) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [login, this.key.seal(JSON.stringify(a), `atlassian:${login}`)]);
      for (const [login, name] of Object.entries(old.names ?? {})) added.names += await n(`INSERT INTO ${s}.account_names (login, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [login, name]);
      for (const [hash, v] of Object.entries(old.sessions ?? {})) added.sessions += await n(`INSERT INTO ${s}.account_sessions (id_hash, login, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [hash, v.login, v.at]);
    });
    await this.refresh();
    return added;
  }

  // Run SQL as this store's connection (tests: what a row holds, an old session).
  async query(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
    await this.ready();
    return this.pool.query(sql, params);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
