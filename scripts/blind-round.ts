// Blind planted-bug round (build plan §7, decided 2026-10-19): Isha plants faults on a
// scratch branch and shares only its name; the reviewer runs the full suite against
// each fault without reading them. The branch holds one commit "blind round N: scorer"
// (this file, on top of main), then one commit per fault, each = scorer commit + that one
// fault alone. This script checks out each commit into a scratch folder, runs every
// test file there, and scores it: killed if the suite fails, survived if it passes. A
// failure is re-run once; only a second failure counts as killed, so a flaky test can't
// inflate the score (a fail-then-pass is reported as flaky and counted as survived). It
// prints no diffs.
//   node scripts/blind-round.ts [branch]      (default: the current branch)
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const branch = process.argv[2] ?? "HEAD";
const git = (args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
};

// The round's commits, oldest first: the scorer, then the faults.
const commits = git(["log", "--reverse", "--format=%H%x09%s", branch, "-n", "50"])
  .trim()
  .split("\n")
  .map((l) => l.split("\t") as [string, string])
  .filter(([, s]) => /^blind round \d+: /.test(s));
const base = commits.find(([, s]) => s.endsWith(": scorer"));
const faults = commits.filter(([, s]) => /: fault \d+$/.test(s));
if (!base || faults.length === 0) throw new Error(`${branch}: no "blind round N: scorer" / "fault N" commits`);

function run(sha: string): { status: number; failing: number; names: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "tira-blind-"));
  try {
    const x = spawnSync("sh", ["-c", `git archive ${sha} | tar -x -C "${dir}"`], { cwd: ROOT, encoding: "utf8" });
    if (x.status !== 0) throw new Error(`extract ${sha}: ${x.stderr}`);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const tests = readdirSync(join(dir, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`);
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...tests], { cwd: dir, encoding: "utf8" });
    const names = (r.stdout ?? "").split("\n").filter((l) => /^not ok /.test(l));
    if (r.status !== 0 && names.length === 0) names.push((r.stderr || r.error?.message || "no output").slice(0, 400));
    return { status: r.status ?? 1, failing: names.length, names };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let b = run(base[0]);
if (b.status !== 0) {
  console.log(`baseline failed once, re-running: ${b.names.join("; ")}`);
  b = run(base[0]);
}
if (b.status !== 0) {
  console.error(`baseline (${base[1]}) fails on its own: ${b.failing} tests failing. Fix that first.\n${b.names.join("\n")}`);
  process.exit(1);
}
console.log(`baseline passes (${base[1]})`);
let killed = 0;
for (const [sha, subject] of faults) {
  const first = run(sha);
  const again = first.status === 0 ? first : run(sha);
  const k = again.status !== 0;
  if (k) killed++;
  const flaky = first.status !== 0 && !k;
  console.log(`${k ? "killed  " : "SURVIVED"}  ${subject}${k ? `  (${again.failing} tests fail)` : flaky ? `  (flaky: failed once, then passed: ${first.names.join("; ")})` : ""}`);
}
console.log(`\n${killed}/${faults.length} killed, ${faults.length - killed} survived`);
process.exit(killed === faults.length ? 0 : 1);
