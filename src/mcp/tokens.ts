// Agents' tokens (Project settings → Connect agents): each connected agent has its own, for one
// project and under one name; `tira mcp` starts only with a valid one, and acts as that agent in
// that project. Only a fingerprint of each token is kept (SHA-256 of a random value, shown once
// when it's made), with who made it, when, and when it was last used. Revoking one stops that
// agent at its next call. In Postgres beside the accounts (the same database and schema), with no
// sealing key needed: a fingerprint opens nothing.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { isPostgresUrl, liveDatabase } from "../store/open.ts";

export interface AgentToken { id: string; project: string; agent: string; createdBy: string; createdAt: string; lastUsedAt?: string }

export interface AgentTokens {
  // a new token for this agent in this project: the token itself (shown once) and its row
  create(project: string, agent: string, createdBy: string): Promise<{ token: string; row: AgentToken }>;
  // the project's agents still connected, oldest first
  list(project: string): Promise<AgentToken[]>;
  // the agent a token belongs to, unless it was revoked (or never made here)
  find(token: string): Promise<AgentToken | undefined>;
  // it was just used (written at most once a minute)
  used(id: string): Promise<void>;
  // revoke it: true if it was connected
  revoke(id: string): Promise<boolean>;
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
// tira_<id>_<secret>: the id is what lists show; the secret makes it unguessable
const newToken = () => {
  const id = randomBytes(4).toString("hex");
  return { id, token: `tira_${id}_${randomBytes(24).toString("hex")}` };
};
const USED_EVERY_MS = 60_000;

// A name for a new agent that no connected agent of the project has: base, base-2, base-3…
export function freeName(base: string, taken: readonly string[]): string {
  let n = 1;
  let name = base;
  while (taken.includes(name)) name = `${base}-${++n}`;
  return name;
}

// In memory: for tests, and tira run without Postgres.
export class MemoryAgentTokens implements AgentTokens {
  private readonly rows = new Map<string, AgentToken & { hash: string; revoked: boolean }>();
  async create(project: string, agent: string, createdBy: string) {
    const { id, token } = newToken();
    const row = { id, project, agent, createdBy, createdAt: new Date().toISOString() };
    this.rows.set(id, { ...row, hash: tokenHash(token), revoked: false });
    return { token, row };
  }
  async list(project: string) {
    return [...this.rows.values()].filter((r) => r.project === project && !r.revoked).map(({ hash: _h, revoked: _r, ...row }) => row);
  }
  async find(token: string) {
    const hash = tokenHash(token);
    const r = [...this.rows.values()].find((x) => x.hash === hash && !x.revoked);
    if (!r) return undefined;
    const { hash: _h, revoked: _r, ...row } = r;
    return row;
  }
  async used(id: string) {
    const r = this.rows.get(id);
    if (r) r.lastUsedAt = new Date().toISOString();
  }
  async revoke(id: string) {
    const r = this.rows.get(id);
    if (!r || r.revoked) return false;
    r.revoked = true;
    return true;
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
type Row = { id: string; project: string; agent: string; created_by: string; created_at: Date; last_used_at: Date | null };
const rowOf = (r: Row): AgentToken => ({ id: r.id, project: r.project, agent: r.agent, createdBy: r.created_by, createdAt: r.created_at.toISOString(), ...(r.last_used_at ? { lastUsedAt: r.last_used_at.toISOString() } : {}) });

export class PostgresAgentTokens implements AgentTokens {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly table: string;
  private made: Promise<void> | undefined;
  private readonly lastWrite = new Map<string, number>();
  constructor(url: string, schema: string) {
    if (!SCHEMA_NAME.test(schema)) throw new TypeError(`bad schema name: ${schema}`);
    this.table = `${schema}.agent_tokens`;
    this.pool = new pg.Pool({ connectionString: url, max: 2 });
    this.pool.on("error", () => {}); // a dropped idle connection reconnects on the next query
    this.schema = schema;
  }
  private ready(): Promise<void> {
    this.made ??= (async () => {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (id text PRIMARY KEY, hash text NOT NULL UNIQUE, project text NOT NULL, agent text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz)`);
      await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_connected ON ${this.table} (project, agent) WHERE revoked_at IS NULL`);
    })();
    return this.made;
  }
  async create(project: string, agent: string, createdBy: string) {
    await this.ready();
    const { id, token } = newToken();
    const r = await this.pool.query<Row>(`INSERT INTO ${this.table} (id, hash, project, agent, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, project, agent, created_by, created_at, last_used_at`, [id, tokenHash(token), project, agent, createdBy]);
    return { token, row: rowOf(r.rows[0] as Row) };
  }
  async list(project: string) {
    await this.ready();
    const r = await this.pool.query<Row>(`SELECT id, project, agent, created_by, created_at, last_used_at FROM ${this.table} WHERE project = $1 AND revoked_at IS NULL ORDER BY created_at, id`, [project]);
    return r.rows.map(rowOf);
  }
  async find(token: string) {
    await this.ready();
    const r = await this.pool.query<Row>(`SELECT id, project, agent, created_by, created_at, last_used_at FROM ${this.table} WHERE hash = $1 AND revoked_at IS NULL`, [tokenHash(token)]);
    return r.rows[0] ? rowOf(r.rows[0]) : undefined;
  }
  async used(id: string) {
    const now = Date.now();
    if (now - (this.lastWrite.get(id) ?? 0) < USED_EVERY_MS) return;
    this.lastWrite.set(id, now);
    await this.ready();
    await this.pool.query(`UPDATE ${this.table} SET last_used_at = now() WHERE id = $1`, [id]);
  }
  async revoke(id: string) {
    await this.ready();
    const r = await this.pool.query(`UPDATE ${this.table} SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  close(): Promise<void> {
    return this.pool.end();
  }
}

// The tokens in tira's database (the accounts' schema), one pool per database; undefined without
// Postgres.
const pools = new Map<string, PostgresAgentTokens>();
export function agentTokensFor(env: Record<string, string | undefined>): PostgresAgentTokens | undefined {
  const db = env.TIRA_DATABASE_URL ?? env.TIRA_DB;
  if (db === undefined || !isPostgresUrl(db)) return undefined;
  const u = new URL(liveDatabase(undefined, env)); // the same rules as the log's (TLS off this machine)
  const schema = u.searchParams.get("schema") ?? (env.TIRA_SCHEMA?.trim() || "tira");
  u.searchParams.delete("schema"); // tira's, not the driver's
  const at = `${u.toString()}|${schema}`;
  let p = pools.get(at);
  if (p === undefined) pools.set(at, (p = new PostgresAgentTokens(u.toString(), schema)));
  return p;
}

// On the way out (scripts/tira.ts): an open pool would hold the process for its idle timeout.
export async function closeAgentTokens(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.close()));
}
