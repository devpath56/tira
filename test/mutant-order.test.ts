// The mutation harness's test-file order (scripts/mutant-order.ts): likely catchers first,
// so a planted bug stops at its first failing file. The order is speed only: every file is
// always in it, so a bug still counts as survived only after all of them pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catcherFirst, failedTest, importsOf, namePattern, suiteOrder } from "../scripts/mutant-order.ts";

test("imports: static, re-export, side-effect and dynamic specifiers resolve to repo paths; packages are skipped", () => {
  const text = [
    `import { a } from "./a.ts";`,
    `export { b } from "../fold/b.ts";`,
    `import "./side.mjs";`,
    `const c = await import("../../charts/c.mjs");`,
    `import { test } from "node:test";`,
  ].join("\n");
  assert.deepEqual(importsOf("src/serve/x.ts", text), ["src/serve/a.ts", "src/fold/b.ts", "src/serve/side.mjs", "charts/c.mjs"]);
});

const tree: Record<string, string> = {
  "test/near.test.ts": `import "../src/fold/fold.ts";`,
  "test/far.test.ts": `import "../src/cli/cli.ts";`,
  "test/fold.test.ts": `import "../src/fold/fold.ts";`,
  "test/page.test.ts": `import "../src/serve/server.ts";`,
  "test/none.test.ts": `import "../src/time.ts";`,
  "src/cli/cli.ts": `import "../fold/fold.ts";`,
  "src/fold/fold.ts": `export const fold = 1;`,
  "src/serve/server.ts": `const page = new URL("./app.mjs", import.meta.url);`,
  "src/time.ts": `export const now = 0;`,
};
const read = (path: string) => tree[path];
const suites = ["far", "none", "near", "fold", "page"];
const cost = { far: 10, none: 1, near: 5, fold: 7, page: 2 };

test("nearest first: a test importing the bug's file beats one that reaches it through another file; one that never reaches it goes last", () => {
  const order = suiteOrder(["src/fold/fold.ts"], suites, cost, read);
  assert.ok(order.indexOf("near") < order.indexOf("far"));
  assert.ok(order.indexOf("far") < order.indexOf("none"));
});

test("at the same distance, the test named after the file or its folder goes first, then the cheapest", () => {
  assert.deepEqual(suiteOrder(["src/fold/fold.ts"], suites, cost, read).slice(0, 2), ["fold", "near"]);
  assert.deepEqual(suiteOrder(["src/fold/fold.ts"], ["near", "fold"], cost, read, new Map()).slice(0, 2), ["fold", "near"]);
});

test("a file read by name, not imported (a page script, a chart), is reached through the file that names it", () => {
  const order = suiteOrder(["src/serve/app.mjs"], suites, cost, read);
  assert.equal(order[0], "page");
});

test("a re-extracted chart counts its JSON as a target too", () => {
  const charts: Record<string, string> = { ...tree, "test/rules.test.ts": `const t = "node-lifecycle.json";` };
  const order = suiteOrder(["charts/node-lifecycle.mjs", "charts/node-lifecycle.json"], ["none", "rules"], {}, (p) => charts[p]);
  assert.equal(order[0], "rules");
});

test("the order never drops or repeats a test file, whatever the map sees, so no bug can survive untried", () => {
  for (const target of ["src/fold/fold.ts", "src/serve/app.mjs", "src/time.ts", "nowhere.ts"]) {
    const order = suiteOrder([target], suites, cost, read);
    assert.deepEqual([...order].sort(), [...suites].sort(), target);
  }
});

test("the file that caught a bug last time goes first; an unknown or stale one changes nothing", () => {
  assert.deepEqual(catcherFirst(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(catcherFirst(["a", "b", "c"], "a"), ["a", "b", "c"]);
  assert.deepEqual(catcherFirst(["a", "b", "c"], undefined), ["a", "b", "c"]);
  assert.deepEqual(catcherFirst(["a", "b", "c"], "gone"), ["a", "b", "c"]);
});

test("a failing run names its first failing top-level test, unescaped; todo tests and subtests don't count", () => {
  const tap = [
    "ok 1 - passes",
    "not ok 2 - later work # TODO pending",
    "    not ok 1 - a child",
    String.raw`not ok 3 - ranks \# 1,000 tasks \\ well ≤ 100 ms ("x")`,
    "not ok 4 - another",
  ].join("\n");
  assert.equal(failedTest(tap), String.raw`ranks # 1,000 tasks \ well ≤ 100 ms ("x")`);
  assert.equal(failedTest("ok 1 - fine\n# pass 1"), undefined);
});

test("a remembered test is picked by a pattern that matches its exact name, not a longer or shorter one", () => {
  for (const name of [String.raw`ranks 1,000 tasks well under 100 ms (best of 3) [a|b] $x ^y \z /w/`, "plain"]) {
    const re = new RegExp(namePattern(name));
    assert.ok(re.test(name), name);
    assert.ok(!re.test(name + " more") && !re.test("x" + name), name);
  }
});
