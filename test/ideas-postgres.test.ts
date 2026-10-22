// The ideas tests again, on the Postgres store, when TIRA_PG_URL names a database (CI sets it):
// the agent's push, tira's draft and proposal, and both approvals on the page, each test in a
// fresh schema, dropped after. Not among the planted-bug suites: the ideas suite runs them on
// SQLite, and the store's own planted bugs are caught by its contract tests.
import { test } from "node:test";

if (process.env.TIRA_PG_URL) {
  process.env.TIRA_TEST_STORE = "postgres";
  await import("./ideas.test.ts");
} else {
  test("postgres: the ideas tests", { skip: "set TIRA_PG_URL to a Postgres database to run these (CI does)" }, () => {});
}
