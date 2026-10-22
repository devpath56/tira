// Where tira's live data is: Postgres only (decided by Isha, 2026-10-22, with Devansh's
// agreement; docs/decision-log.md). The database is a postgres:// connection string, from
// `--db` or, better, $TIRA_DATABASE_URL (a password on the command line lands in the shell's
// history). A SQLite file is refused: no second store beside the real one, and no ./tira.db
// made in whatever folder a command ran from. SQLite stays for tests, in memory or in a
// throwaway file they open themselves, and as the source of `tira import`.
//
// A database on another machine needs TLS (sslmode=require or stricter); one on this machine
// (tests, CI's service container, a local Docker) may go without. `?schema=NAME` on the string,
// or $TIRA_SCHEMA, picks the schema (default "tira"): several tiras, a demo or a trial run can
// share one database without touching each other.
//
// The connection string is never printed: messages say what to set, not what is set.
import type { EventStore } from "./types.ts";
import { PostgresEventStore } from "./postgres-store.ts";

export type ClosableStore = EventStore & { close(): void | Promise<void> };

export const DATABASE_ENV = "TIRA_DATABASE_URL";

export const isPostgresUrl = (db: string): boolean => /^postgres(ql)?:\/\//i.test(db);

// Why a database was refused, in plain words; it never holds the connection string.
export class DatabaseRefused extends Error {}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

// The live database, from --db or the environment ($TIRA_DATABASE_URL; $TIRA_DB, its old
// name, still read). Throws DatabaseRefused for anything tira won't keep its data in.
export function liveDatabase(flag: string | undefined, env: Record<string, string | undefined>): string {
  const db = flag ?? env[DATABASE_ENV] ?? env.TIRA_DB;
  if (db === undefined || db.trim() === "") {
    throw new DatabaseRefused(`no database: set ${DATABASE_ENV} to your Postgres connection string (README, "Running on Postgres")`);
  }
  if (!isPostgresUrl(db)) {
    throw new DatabaseRefused(`tira keeps its data in Postgres only, and ${flag !== undefined ? "--db" : "the database setting"} names a file. Set ${DATABASE_ENV} to your Postgres connection string; to bring an old SQLite log over, run tira import <file>.`);
  }
  let u: URL;
  try {
    u = new URL(db);
  } catch {
    throw new DatabaseRefused(`${DATABASE_ENV} isn't a connection string tira can read`);
  }
  const tls = TLS_MODES.has(u.searchParams.get("sslmode") ?? "") || ["true", "1"].includes(u.searchParams.get("ssl") ?? "");
  if (!LOCAL.has(u.hostname) && !tls) {
    throw new DatabaseRefused(`a database on another machine needs TLS: end ${DATABASE_ENV} with ?sslmode=require (or verify-full)`);
  }
  return db;
}

// The Postgres store a connection string names, in its ?schema= (else `schema`, else "tira").
export function openStore(db: string, schema?: string): PostgresEventStore {
  if (!isPostgresUrl(db)) throw new DatabaseRefused("tira keeps its data in Postgres only");
  const u = new URL(db);
  const named = u.searchParams.get("schema") ?? (schema?.trim() || null);
  u.searchParams.delete("schema"); // tira's, not the driver's
  return new PostgresEventStore({ url: u.toString(), ...(named ? { schema: named } : {}) });
}
