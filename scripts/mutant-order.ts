// Which test files to try first for a planted bug (scripts/mutants.ts). The harness
// stops at the first file that fails, so trying the likely catchers first is the whole
// speed-up — the order never changes a verdict: a bug counts as survived only after
// every file has passed with it in place. Pure: files are read only through `read`.
//
// A test file reaches a planted bug when it, or anything it imports (all the way down),
// imports the bug's file or names it in its text: a page script served by path, a chart
// read as JSON, a Python tool run by name. Files that reach it go first, nearest first;
// files that don't go last, cheapest first, so a bug the map can't see is still caught,
// only later.

// Relative import specifiers in a TS/JS file: static, re-export, side-effect and dynamic.
const IMPORT = /\b(?:from|import)\s*(?:\(\s*)?["'](\.{1,2}\/[^"']+)["']/g;

export function importsOf(path: string, text: string): string[] {
  const dir = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (const [, spec = ""] of text.matchAll(IMPORT)) {
    const parts = [...dir];
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    out.push(parts.join("/"));
  }
  return out;
}

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");

// How many import steps a test is from each file it pulls in (the test itself: 0).
function depths(test: string, read: (path: string) => string | undefined, memo: Map<string, string[]>): Map<string, number> {
  const depth = new Map([[test, 0]]);
  const queue = [test];
  for (const f of queue) {
    let next = memo.get(f);
    if (next === undefined) {
      const text = /\.(?:ts|mts|mjs|js)$/.test(f) ? read(f) : undefined;
      next = text === undefined ? [] : importsOf(f, text);
      memo.set(f, next);
    }
    for (const n of next) {
      if (depth.has(n)) continue;
      depth.set(n, (depth.get(f) ?? 0) + 1);
      queue.push(n);
    }
  }
  return depth;
}

// targets: the planted bug's file, plus anything rebuilt from it (a re-extracted chart's JSON).
// suites: test names ("fold" for test/fold.test.ts); cost: each one's measured run time.
// Related tests go nearest first (fewest import steps to the bug's file, or to a file that
// names it), then the one named after the file or its folder, then cheapest.
export function suiteOrder(
  targets: readonly string[],
  suites: readonly string[],
  cost: Readonly<Record<string, number>>,
  read: (path: string) => string | undefined,
  memo = new Map<string, string[]>(),
): string[] {
  const names = targets.map(baseName);
  const near = new Set(targets.flatMap((t) => [stem(t), t.split("/").at(-2) ?? ""]));
  const reach = new Map<string, number>();
  for (const suite of suites) {
    let best = Infinity;
    for (const [f, d] of depths(`test/${suite}.test.ts`, read, memo)) {
      if (targets.includes(f)) best = Math.min(best, d);
      else if (names.some((n) => (read(f) ?? "").includes(n))) best = Math.min(best, d + 1);
    }
    reach.set(suite, best);
  }
  const by = (a: string, b: string) =>
    (reach.get(a) ?? Infinity) - (reach.get(b) ?? Infinity) ||
    Number(!near.has(a)) - Number(!near.has(b)) ||
    (cost[a] ?? Infinity) - (cost[b] ?? Infinity) ||
    a.localeCompare(b);
  return [...suites].sort(by);
}

// The file that caught this bug last time goes first; everything else keeps its place.
// An unknown or stale name changes nothing, so the order still holds every file once.
export function catcherFirst(order: readonly string[], catcher: string | undefined): string[] {
  return catcher !== undefined && order.includes(catcher) ? [catcher, ...order.filter((s) => s !== catcher)] : [...order];
}

// The first test a TAP report (node --test, piped) says failed, unescaped; todo tests and
// subtests don't count (a failing subtest fails its top-level test too).
export function failedTest(tap: string): string | undefined {
  for (const line of tap.split("\n")) {
    const name = /^not ok \d+ - (.*)$/.exec(line)?.[1];
    if (name !== undefined && !/ # TODO\b/.test(name)) return name.replaceAll(/\\([\\#])/g, "$1");
  }
  return undefined;
}

// A --test-name-pattern that matches exactly this test name and nothing longer.
export function namePattern(name: string): string {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
  return "^" + escaped + "$";
}
