// The store a test writes to: SQLite in memory, or, under TIRA_TEST_STORE=postgres (with
// TIRA_PG_URL), a fresh Postgres schema of its own, dropped when the test file ends. So a suite
// can run on both stores (test/ideas-postgres.test.ts) without touching anyone's data.
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { PostgresEventStore } from "../src/store/postgres-store.ts";
import type { ClosableStore } from "../src/store/open.ts";

const onPostgres = () => process.env.TIRA_TEST_STORE === "postgres" && !!process.env.TIRA_PG_URL;
const schemas: string[] = [];
const open: ClosableStore[] = [];

const fresh = () => {
  const s = `tira_t_${randomBytes(6).toString("hex")}`;
  schemas.push(s);
  return s;
};

export function freshStore(): ClosableStore {
  const store: ClosableStore = onPostgres() ? new PostgresEventStore({ url: process.env.TIRA_PG_URL as string, schema: fresh() }) : new SqliteEventStore();
  open.push(store);
  return store;
}

// a --db value for the CLI: a SQLite file in `dir`, or the database with a schema of its own
export function freshDb(dir: string): string {
  if (!onPostgres()) return join(dir, "t.db");
  const u = new URL(process.env.TIRA_PG_URL as string);
  u.searchParams.set("schema", fresh());
  return u.toString();
}

after(async () => {
  for (const s of open) await s.close();
  if (schemas.length === 0 || !onPostgres()) return;
  const admin = new pg.Pool({ connectionString: process.env.TIRA_PG_URL as string });
  try {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  } finally {
    await admin.end();
  }
});
