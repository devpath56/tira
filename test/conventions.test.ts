// The convention home (conventions/conventions.jsonl) and its checker. The seeded home
// must pass; each refusal below is one checker rule, and goes green only while that
// rule is in scripts/check-conventions.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECKER = join(ROOT, "scripts", "check-conventions.mjs");
const HOME = join(ROOT, "conventions", "conventions.jsonl");

const check = (home?: string) => {
  const r = spawnSync(process.execPath, [CHECKER, ...(home ? ["--home", home] : [])], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const withHome = (records: object[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "conventions-")), "conventions.jsonl");
  writeFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return check(f);
};
const seeded = () => readFileSync(HOME, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const compiledRow = () => seeded().find((r) => r.state === "compiled") as Record<string, unknown>;
// The home has no blind-listed record left (2026-10-21), so the checker's blind-listed rules are
// tested on a compiled record turned back into one.
const blindRow = (): Record<string, unknown> => ({ ...compiledRow(), state: "blind-listed", assertion: null, compiled_at: null });

test("the seeded home passes the checker and prints its standing count", () => {
  const r = check();
  assert.equal(r.code, 0, r.err);
  const rows = seeded();
  const n = (s: string) => rows.filter((x) => x.state === s).length;
  assert.equal(r.out.trim(), `PASS: compiled ${n("compiled")} / blind-listed ${n("blind-listed")} / struck ${n("struck")}`);
  assert.ok(n("compiled") > 0, "the seed holds compiled conventions");
  assert.equal(withHome([blindRow()]).code, 0, "a blind-listed record rests too");
});

test("a record resting at stated is refused", () => {
  const r = withHome([{ ...blindRow(), state: "stated" }]);
  assert.equal(r.code, 1);
  assert.match(r.err, /rests in state stated/);
});

test("a compiled record whose assertion names no real test is refused", () => {
  const row = compiledRow();
  const file = String(row.assertion).split("::")[0];
  const noTest = withHome([{ ...row, assertion: `${file}::no test is called this` }]);
  assert.equal(noTest.code, 1);
  assert.match(noTest.err, /is not in test\//);
  const noFile = withHome([{ ...row, assertion: "test/no-such.test.ts::anything" }]);
  assert.equal(noFile.code, 1);
  assert.match(noFile.err, /assertion file test\/no-such\.test\.ts does not exist/);
});

test("a duplicate (id, surface) pair is refused, naming the first line", () => {
  const row = blindRow();
  const r = withHome([row, { ...row, statement: "the same convention, stated twice" }]);
  assert.equal(r.code, 1);
  assert.match(r.err, /line 2 .*duplicate \(id, surface\) pair, first at line 1/);
});

test("a blind-listed record carrying an assertion is refused", () => {
  const r = withHome([{ ...blindRow(), assertion: compiledRow().assertion }]);
  assert.equal(r.code, 1);
  assert.match(r.err, /blind-listed but carries an assertion/);
});

test("malformed lines and missing or empty fields are refused", () => {
  const { surface: _, ...noSurface } = blindRow();
  for (const [records, why] of [
    [[noSurface], /missing field\(s\) surface/],
    [[{ ...blindRow(), source: "  " }], /empty field\(s\) source/],
    [[{ ...compiledRow(), compiled_at: null }], /compiled with no compiled_at/],
  ] as const) {
    const r = withHome([...records]);
    assert.equal(r.code, 1);
    assert.match(r.err, why);
  }
  const f = join(mkdtempSync(join(tmpdir(), "conventions-")), "conventions.jsonl");
  writeFileSync(f, "{not json\n");
  const r = check(f);
  assert.equal(r.code, 1);
  assert.match(r.err, /line 1: malformed/);
});
