// docs/tools/region-scan.py reads chart and pairs files named on its command line and
// appends to a log it is given: it refuses any path outside the current directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scan = (...args: string[]) => spawnSync("python3", ["docs/tools/region-scan.py", ...args], { cwd: ROOT, encoding: "utf8" });

test("region-scan reads charts inside the repo, and refuses paths that leave it", () => {
  const ok = scan("--all", "charts/node-lifecycle.json", "charts/idea-lifecycle.json");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^PASS: 2 regions/);
  for (const args of [
    ["--all", "../outside.json"],
    ["--all", "/etc/hosts"],
    ["--all", "charts/../../outside.json"],
    ["--all", `../${basename(ROOT)}-sibling/chart.json`], // a sibling whose name starts like the repo's
    ["--all", "charts/node-lifecycle.json", "--handoff-pairs", "/etc/hosts"],
    ["--all", "charts/node-lifecycle.json", "--log-decisions", "/tmp/region-scan-log.jsonl"],
  ]) {
    const r = scan(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /is outside/, args.join(" "));
  }
});
