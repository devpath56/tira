// The mutation harness's match check (scripts/mutant-anchors.ts): a planted bug that would
// plant nothing is named in seconds, before any test runs, so a moved anchor fails CI in its
// first minute instead of its last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchorProblems, type Anchored } from "../scripts/mutant-anchors.ts";

const files: Record<string, string> = {
  "src/a.ts": "const x = 1;\nconst y = 2;\nconst y = 2;\n",
  "charts/t.json": JSON.stringify({ pairs: [{ from: "done", event: "START", outcome: "denied" }] }),
  "charts/broken.json": "{ not json",
};
const read = (path: string) => files[path];
type Table = { pairs: { from: string; event: string; outcome: string }[] };
const flip = (from: string, outcome: string) => (t: Table) => {
  const p = t.pairs.find((x) => x.from === from);
  if (!p) throw new Error(`no pair from ${from}`);
  p.outcome = outcome;
};
const json = (name: string, path: string, edit: (t: Table) => void): Anchored => ({ name, json: path, edit: edit as (t: never) => void });

test("a planted bug whose text appears exactly once, or whose table edit changes the table, passes", () => {
  assert.deepEqual(anchorProblems([
    { name: "x", file: "src/a.ts", find: "const x = 1;" },
    json("flip", "charts/t.json", flip("done", "noop")),
  ], read), []);
});

test("a moved anchor is named: the text appears zero times, twice, or its file is gone", () => {
  assert.deepEqual(anchorProblems([
    { name: "gone", file: "src/a.ts", find: "const z = 3;" },
    { name: "twice", file: "src/a.ts", find: "const y = 2;" },
    { name: "no file", file: "src/b.ts", find: "anything" },
  ], read), [
    "gone: pattern matched 0 times in src/a.ts (must be exactly 1)",
    "twice: pattern matched 2 times in src/a.ts (must be exactly 1)",
    "no file: src/b.ts does not exist",
  ]);
});

test("a table edit that no longer applies, or changes nothing, is named; so is a reused name", () => {
  assert.deepEqual(anchorProblems([
    json("missing pair", "charts/t.json", flip("blocked", "noop")),
    json("no change", "charts/t.json", flip("done", "denied")),
    json("not json", "charts/broken.json", flip("done", "noop")),
    json("no table", "charts/none.json", flip("done", "noop")),
    { name: "x", file: "src/a.ts", find: "const x = 1;" },
    { name: "x", file: "src/a.ts", find: "const x = 1;" },
  ], read), [
    "missing pair: the edit no longer applies to charts/t.json (no pair from blocked)",
    "no change: the edit changes nothing in charts/t.json",
    "not json: charts/broken.json is not JSON",
    "no table: charts/none.json does not exist",
    "x: the name is used twice (each planted bug needs its own)",
  ]);
});

test("the repo's own planted bugs all land: npm run mutants:check passes in seconds, without running a test", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "scripts", "mutants.ts"), "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^match check: every one of \d+ planted bugs lands exactly once\n$/);
  assert.ok(performance.now() - t0 < 30_000, "seconds, not a test run");
  assert.ok(existsSync(join(root, "scripts", "mutant-anchors.ts")) && readFileSync(join(root, "package.json"), "utf8").includes('"mutants:check"'));
});
