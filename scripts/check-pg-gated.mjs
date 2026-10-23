// Spec A leg 1 (spec-postgres-native-core-20261022.md, delta D-Q1): the
// Postgres-gated tests must EXECUTE in CI, not merely not fail. A green suite
// in which the gated tests skipped proves nothing about the live store —
// the cheapest way to fake leg 1 is to drop TIRA_PG_URL from the workflow,
// and this script is the counter: it runs the two fully-gated files, counts
// what actually ran, and fails if any of them skipped or none executed.
//
// The gated files register their tests with a skip reason when TIRA_PG_URL
// is unset, so this also fails (by design) on a machine without a database:
// locally, leg 1 is UNEVALUABLE, never a pass.
import { spawnSync } from "node:child_process";

const FILES = ["test/scenarios-postgres.test.ts", "test/ideas-postgres.test.ts"];

const run = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", ...FILES],
  { encoding: "utf8", env: process.env },
);
const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

const count = (label) => {
  const m = out.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return m ? Number(m[1]) : 0;
};
const tests = count("tests");
const pass = count("pass");
const fail = count("fail");
const skipped = count("skipped");
const executed = pass + fail;

console.log(
  `pg-gated: executed ${executed} (pass ${pass}, fail ${fail}, skipped ${skipped}) of ${tests} registered`,
);

if (run.status !== 0 || tests === 0 || executed === 0 || skipped > 0 || fail > 0) {
  console.error(
    "Spec A leg 1 FAIL: the Postgres-gated tests did not all execute and pass. " +
      "In CI this means TIRA_PG_URL is unset, the service is down, or a gated test regressed; " +
      "locally without a database this leg is UNEVALUABLE, not passed.",
  );
  process.exit(1);
}
console.log("Spec A leg 1: Postgres-gated tests executed and passed.");
