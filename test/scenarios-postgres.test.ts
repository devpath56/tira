// The scenario suite again, on the Postgres store, when TIRA_PG_URL names a database (CI sets it):
// every script must pass on both stores. Each script runs in a fresh schema, dropped after it.
// Not among the planted-bug suites (scripts/mutants.ts): it re-runs every scenario over a
// network, and the store's own planted bugs are caught by its contract tests (store.test.ts).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadScenarios, runScenario } from "../src/scenario/run.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { PostgresEventStore } from "../src/store/postgres-store.ts";

const url = process.env.TIRA_PG_URL;
const skip = url ? false : "set TIRA_PG_URL to a Postgres database to run these (CI does)";
const all = loadScenarios();
let admin: pg.Pool | undefined;
after(() => admin?.end());

for (const s of all.values()) {
  if (s.status === "seed" || s.status === "pending") continue;
  test(`postgres: ${s.id}: ${s.title}`, { skip }, async () => {
    const schema = `tira_s_${randomBytes(6).toString("hex")}`;
    const store = new PostgresEventStore({ url: url as string, schema });
    admin ??= new pg.Pool({ connectionString: url });
    try {
      const { failures, log } = await runScenario(s, all, defaultRegistry(), store);
      assert.deepEqual(failures, [], `${s.id} (${log.length} events)`);
    } finally {
      await store.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
}
