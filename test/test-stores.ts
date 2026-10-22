// Stores for tests. Live, tira keeps its data in Postgres only (src/store/open.ts); tests keep a
// throwaway SQLite of their own for the CLI (`sqliteFile`, passed as Io.openStore), and a
// throwaway Postgres schema when they run tira as its own process (`freshPgDb`, dropped when the
// test file ends; such tests are skipped without TIRA_PG_URL, and CI sets it).
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";

export const sqliteFile = (db: string) => new SqliteEventStore({ path: db });

const PG = process.env.TIRA_PG_URL;
export const needsPg: false | string = PG ? false : "set TIRA_PG_URL to a Postgres database to run these (CI does)";

const made: string[] = [];
// a connection string with a schema of its own: what tira's real entry script is given
export function freshPgDb(): string {
  const schema = `tira_t_${randomBytes(6).toString("hex")}`;
  made.push(schema);
  const u = new URL(PG as string);
  u.searchParams.set("schema", schema);
  return u.toString();
}

after(async () => {
  if (made.length === 0 || !PG) return;
  const admin = new pg.Pool({ connectionString: PG });
  try {
    await Promise.all(made.map((s) => admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`)));
  } finally {
    await admin.end();
  }
});
