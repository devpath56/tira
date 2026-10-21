// The convention home's checker: conventions/conventions.jsonl is the one place a
// convention is stated, one record per convention per surface it binds. A convention
// rests compiled (an assertion in the suite pins it), blind-listed (nothing pins it yet)
// or struck (retired by a ruling). `stated` is the moment of stating, never a rest.
// Exit 1 names every record that breaks the home's rules; exit 0 prints the standing
// count, never a bare rate.
// Run: node scripts/check-conventions.mjs [--home FILE]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIELDS = ["id", "statement", "source", "surface", "dimension", "state", "assertion", "stated_at", "compiled_at"];
export const STATES = ["compiled", "blind-listed", "struck"];
// Always carry a value; assertion and compiled_at may be null outside `compiled`.
const NON_EMPTY = ["id", "statement", "source", "surface", "dimension", "state", "stated_at"];
const empty = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// The names of the tests a file declares: test("...", ...) with a double-quoted name.
const testNames = (text) => new Set([...text.matchAll(/\btest\(\s*"((?:[^"\\\n]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)));

// An assertion is "<file>::<test name>", the file relative to the repo root.
export function resolveAssertion(assertion, root = ROOT) {
  const at = assertion.indexOf("::");
  if (at < 0) return `assertion ${JSON.stringify(assertion)} is not <file>::<test name>`;
  const file = assertion.slice(0, at);
  const name = assertion.slice(at + 2);
  const path = resolve(root, file);
  if (!path.startsWith(resolve(root) + "/") || !existsSync(path)) return `assertion file ${file} does not exist`;
  if (!testNames(readFileSync(path, "utf8")).has(name)) return `assertion test ${JSON.stringify(name)} is not in ${file}`;
  return null;
}

export function checkHome(text, root = ROOT) {
  const errors = [];
  const seen = new Map();
  const counts = { compiled: 0, "blind-listed": 0, struck: 0 };
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const where = `line ${i + 1}`;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return errors.push(`${where}: malformed (not JSON)`);
    }
    if (!r || typeof r !== "object" || Array.isArray(r)) return errors.push(`${where}: malformed (not a JSON object)`);
    const name = `${where} (${r.id ?? "?"} @ ${r.surface ?? "?"})`;
    const missing = FIELDS.filter((f) => !(f in r));
    const extra = Object.keys(r).filter((f) => !FIELDS.includes(f));
    if (missing.length > 0) errors.push(`${name}: missing field(s) ${missing.join(", ")}`);
    if (extra.length > 0) errors.push(`${name}: unknown field(s) ${extra.join(", ")}`);
    const blank = NON_EMPTY.filter((f) => f in r && empty(r[f]));
    if (blank.length > 0) errors.push(`${name}: empty field(s) ${blank.join(", ")}`);
    if (r.state === "stated") errors.push(`${name}: rests in state stated; stating is a moment, so it must be compiled or blind-listed`);
    else if (!empty(r.state) && !STATES.includes(r.state)) errors.push(`${name}: state ${JSON.stringify(r.state)} is not one of ${STATES.join(", ")}`);
    if (r.state === "compiled") {
      if (empty(r.assertion)) errors.push(`${name}: compiled with no assertion`);
      else {
        const why = typeof r.assertion === "string" ? resolveAssertion(r.assertion, root) : "assertion is not a string";
        if (why) errors.push(`${name}: ${why}`);
      }
      if (empty(r.compiled_at)) errors.push(`${name}: compiled with no compiled_at`);
    }
    if (r.state === "blind-listed" && !empty(r.assertion)) errors.push(`${name}: blind-listed but carries an assertion; a pinned convention is compiled`);
    const pair = `${r.id}\u0000${r.surface}`;
    if (seen.has(pair)) errors.push(`${name}: duplicate (id, surface) pair, first at line ${seen.get(pair)}`);
    else seen.set(pair, i + 1);
    if (r.state in counts) counts[r.state]++;
  });
  return { errors, counts };
}

export const countLine = (c) => `compiled ${c.compiled} / blind-listed ${c["blind-listed"]} / struck ${c.struck}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--home");
  const home = flag >= 0 ? resolve(process.argv[flag + 1]) : join(ROOT, "conventions", "conventions.jsonl");
  if (!existsSync(home)) {
    console.error(`FAIL: no convention home at ${home}`);
    process.exit(1);
  }
  const { errors, counts } = checkHome(readFileSync(home, "utf8"));
  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  console.log(`PASS: ${countLine(counts)}`);
}
