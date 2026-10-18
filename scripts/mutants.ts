// Mutation harness: proves the test suite catches real breaks.
// Each mutant plants one bug in a scratch copy of the repo and runs the tests;
// the suite MUST fail. A mutant whose pattern doesn't match exactly once is an
// error too — a silent no-op mutant would report a catch that never happened.
//   node scripts/mutants.ts            (npm run mutants)
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Mutant =
  | { name: string; file: string; find: string; replace: string; reextract?: boolean }
  | { name: string; json: string; edit: (t: { pairs: { from: string; event: string; outcome: string }[] }) => void };

const flip = (from: string, event: string, outcome: string) => (t: { pairs: { from: string; event: string; outcome: string }[] }) => {
  const p = t.pairs.find((x) => x.from === from && x.event === event);
  if (!p) throw new Error(`no pair ${from}+${event}`);
  p.outcome = outcome;
};

const MUTANTS: Mutant[] = [
  // Tables: the no-op vs denied distinction the chart checks cannot see
  { name: "JSON node done+ADD_CHILD denied->noop", json: "charts/node-lifecycle.json", edit: flip("done", "ADD_CHILD", "noop") },
  { name: "JSON node in_progress+START noop->denied", json: "charts/node-lifecycle.json", edit: flip("in_progress", "START", "denied") },
  { name: "JSON idea dropped+REJECT_NODE noop->denied", json: "charts/idea-lifecycle.json", edit: flip("dropped", "REJECT_NODE", "denied") },
  { name: "chart allows ADD_CHILD on done (re-extracted)", file: "charts/node-lifecycle.mjs", find: "COMPLETE: {}, // idempotent: already done, no-op.", replace: "COMPLETE: {}, ADD_CHILD: {},", reextract: true },
  // Store
  { name: "store: no-delete trigger dropped", file: "src/store/sqlite-store.ts", find: "CREATE TRIGGER IF NOT EXISTS no_delete_events BEFORE DELETE ON events\n  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;", replace: "" },
  { name: "store: no-update trigger dropped", file: "src/store/sqlite-store.ts", find: "CREATE TRIGGER IF NOT EXISTS no_update_events BEFORE UPDATE ON events\n  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;", replace: "" },
  { name: "store: duplicate eventId not deduped", file: "src/store/sqlite-store.ts", find: "e.eventId !== undefined ? (findById.get(eventId)", replace: "false ? (findById.get(eventId)" },
  { name: "store: subscribe ignores fromSeq", file: "src/store/sqlite-store.ts", find: "let next = opts.fromSeq ?? 1;", replace: "let next = 1;" },
  { name: "store: subscribe advances before handler", file: "src/store/sqlite-store.ts", find: "if (source === ALL || e.stream === source) await handler(e);\n          next = e.seq + 1;", replace: "next = e.seq + 1;\n          if (source === ALL || e.stream === source) await handler(e);" },
  { name: "store: async handler not awaited", file: "src/store/sqlite-store.ts", find: "if (source === ALL || e.stream === source) await handler(e);", replace: "if (source === ALL || e.stream === source) void handler(e);" },
  // Runner
  { name: "runner ignores guards", file: "src/tables/table.ts", find: "if (!impl(ctx)) return", replace: "if (false && !impl(ctx)) return" },
  { name: "guard accepts non-strings", file: "src/tables/table.ts", find: 'const nonEmptyString = (v: unknown) => typeof v === "string" && v.length > 0;', replace: "const nonEmptyString = (v: unknown) => !!v;" },
  // Evaluate
  { name: "version allowed on unversioned type", file: "src/fold/evaluate.ts", find: "  if (!def.versioned && intent.entity.version !== undefined) {", replace: "  if (false) {" },
  // Event mapping
  { name: "actor dropped on replay", file: "src/fold/events.ts", find: "const actor = e.metadata.actor;", replace: "const actor = undefined;" },
  { name: "version dropped from stored event", file: "src/fold/events.ts", find: "e.version !== undefined ? { id: e.id, version: e.version } : { id: e.id }", replace: "{ id: e.id }" },
  // Fold
  { name: "fold ignores upToSeq", file: "src/fold/fold.ts", find: "if (opts.upToSeq !== undefined && e.seq > opts.upToSeq) break;", replace: "" },
  { name: "fold trusts input order", file: "src/fold/fold.ts", find: "const ordered = [...events].sort((a, b) => a.seq - b.seq);", replace: "const ordered = [...events];" },
  { name: "fold createdSeq = lastSeq", file: "src/fold/fold.ts", find: "createdSeq: prev?.createdSeq ?? e.seq,", replace: "createdSeq: e.seq," },
  { name: "fold not stream-scoped", file: "src/fold/fold.ts", find: "const { entities, view } = scope(e.stream);", replace: 'const { entities, view } = scope("all");' },
  { name: "fold trusts malformed command.rejected", file: "src/fold/fold.ts", find: "if (!isRejectedData(e.data)) {", replace: "if (false) {" },
  // Write path
  { name: "write path skips eventId dedupe", file: "src/write/write-path.ts", find: "if (cmd.eventId !== undefined) {", replace: "if (false) {" },
  { name: "write path ignores eventId reuse", file: "src/write/write-path.ts", find: "if (canonicalJson(recordedIntent(prior, this.registry)) !== canonicalJson(intent)) {", replace: "if (false) {" },
  { name: "write path has no per-stream queue", file: "src/write/write-path.ts", find: "const prev = queues.get(snapshot.stream) ?? Promise.resolve();", replace: "const prev = Promise.resolve();" },
  { name: "write path queue per instance, not per store", file: "src/write/write-path.ts", find: "const queues = queueFor(this.store);", replace: "const queues = queueFor(this as unknown as EventStore);" },
  { name: "write path evaluates the live command, not a snapshot", file: "src/write/write-path.ts", find: "snapshot = structuredClone(cmd);", replace: "snapshot = cmd;" },
  { name: "canonicalJson sorts by locale (Sonar's suggestion)", file: "src/fold/fold.ts", find: "          .sort(compareCodeUnits)\n", replace: "          .sort((a, b) => a.localeCompare(b))\n" },
  { name: "fold derived not nested by stream", file: "src/fold/fold.ts", find: "(derived[stream] ??= {})[ent.key] = values;", replace: '(derived["s"] ??= {})[ent.key] = values;' },
  { name: "write path drops expectedRevision on empty stream", file: "src/write/write-path.ts", find: "const expectedRevision = last ? last.streamRevision : -1;", replace: "const expectedRevision = last ? last.streamRevision : undefined;" },
  { name: "write path never retries a lost race", file: "src/write/write-path.ts", find: "if (err instanceof WrongExpectedRevisionError && attempt < this.maxAttempts) {", replace: "if (false) {" },
  // CLI
  { name: "cli: rejected command exits 0", file: "src/cli/cli.ts", find: 'return r.status === "rejected" ? 2 : 0;', replace: "return 0;" },
  { name: "cli: replay ignores N", file: "src/cli/cli.ts", find: 'return await state(store, registry, stream, seqArg(args[0], "replay N"), values, io);', replace: "return await state(store, registry, stream, undefined, values, io);" },
  { name: "cli: key=value values parsed as JSON", file: "src/cli/cli.ts", find: "payload[p.slice(0, eq)] = p.slice(eq + 1);", replace: "payload[p.slice(0, eq)] = (() => { try { return JSON.parse(p.slice(eq + 1)); } catch { return p.slice(eq + 1); } })();" },
  { name: "cli: key=value splits on the last =", file: "src/cli/cli.ts", find: 'const eq = p.indexOf("=");', replace: 'const eq = p.lastIndexOf("=");' },
  { name: "cli: --actor ignored", file: "src/cli/cli.ts", find: "const actor = values.actor ?? io.env.TIRA_ACTOR;", replace: "const actor = io.env.TIRA_ACTOR;" },
  { name: "cli: TIRA_STREAM ignored", file: "src/cli/cli.ts", find: 'values.stream ?? io.env.TIRA_STREAM ?? "tasktree-main"', replace: 'values.stream ?? "tasktree-main"' },
  { name: "cli: dump hash ignores the content", file: "src/cli/cli.ts", find: 'createHash("sha256").update(s)', replace: 'createHash("sha256").update("constant")' },
  { name: "cli: dump ignores --at", file: "src/cli/cli.ts", find: 'return await dump(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);', replace: "return await dump(store, registry, stream, undefined, values, io);" },
  { name: "cli: stored-form event names not accepted", file: "src/cli/cli.ts", find: "/^[a-z][a-z0-9-]*$/.test(rawEvent) ? tableEventName(rawEvent) : rawEvent", replace: "false ? tableEventName(rawEvent) : rawEvent" },
  // Event naming (D1)
  { name: "stored names keep the table's UPPER_SNAKE", file: "src/fold/events.ts", find: 'export const storedName = (tableEvent: string): string => tableEvent.toLowerCase().replaceAll("_", "-");', replace: "export const storedName = (tableEvent: string): string => tableEvent;" },
  { name: "fold accepts non-kebab stored names", file: "src/fold/events.ts", find: "if (!STORED_EVENT_NAME.test(name)) return undefined;", replace: "" },
  { name: "registry allows a CREATED table event", file: "src/tables/registry.ts", find: 'if (ev === "CREATED" || ev === created) throw', replace: 'if (false) throw' },
  // Track C1: tree, drain, cursor, gates, render
  { name: "c1: children prepended, not appended", file: "src/fold/fold.ts", find: "children: [...parent.tree.children, ev.key]", replace: "children: [ev.key, ...parent.tree.children]" },
  { name: "c1: drain ignores cancelled", file: "src/fold/tree.ts", find: "return kids.length > 0 && kids.every((c) => isTerminal(cfg, c));", replace: 'return kids.length > 0 && kids.every((c) => c.regions[cfg.region] === "done");' },
  { name: "c1: a leaf counts as drained", file: "src/fold/tree.ts", find: "return kids.length > 0 && kids.every(", replace: "return kids.every(" },
  { name: "c1: COMPLETE gate off", file: "src/fold/evaluate.ts", find: "if (t.completeEvent !== undefined && event === t.completeEvent && !allChildrenTerminal(t, current, view)) {", replace: "if (false) {" },
  { name: "c1: one-active gate off", file: "src/fold/evaluate.ts", find: "  if (t.oneActive) {", replace: "  if (false) {" },
  { name: "c1: one-active gate only on START", file: "src/fold/evaluate.ts", find: "  if (t.oneActive) {", replace: '  if (t.oneActive && event === "START") {' },
  { name: "c1: active ignores descendants", file: "src/fold/tree.ts", find: ".filter((e) => isActiveState(e) && !anyDescendant(e, view, isActiveState));", replace: ".filter((e) => isActiveState(e));" },
  { name: "c1: cursor enters closed branches", file: "src/fold/tree.ts", find: "if (found || isTerminal(cfg, e)) return;", replace: "if (found) return;" },
  { name: "c1: cursor ignores completability", file: "src/fold/tree.ts", find: "if (isActionable(cfg, e) && allChildrenTerminal(cfg, e, view)) {", replace: "if (isActionable(cfg, e)) {" },
  { name: "c1: depth cap off", file: "src/fold/evaluate.ts", find: "if (depth > t.maxDepth) return reject(", replace: "if (false) return reject(" },
  { name: "c1: children cap off", file: "src/fold/evaluate.ts", find: "if (parent.tree.children.length >= t.maxChildren) {", replace: "if (false) {" },
  { name: "c1: parent's table not consulted (child under done)", file: "src/fold/evaluate.ts", find: "    return reject(\"denied\", `${table?.id}: ${parentState} + ${t.childEvent} (re-open ${parent.key} first)`);", replace: "    void 0;" },
  { name: "c1: discovered work without discovered_during", file: "src/fold/evaluate.ts", find: 'if (kind === "discovered" && discoveredDuring === undefined) {', replace: "if (false) {" },
  { name: "c1: node birth name ignored (node.created)", file: "src/tables/registry.ts", find: '      createdAs: "BORN",\n', replace: "" },
  { name: "c1: render drops the cursor flag", file: "src/render/html.ts", find: 'data-cursor="${r.cursor}"', replace: 'data-cursor="false"' },
  { name: "c1: render escapes nothing", file: "src/render/html.ts", find: "const esc = (s: string) => s.replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`);", replace: "const esc = (s: string) => s;" },
  { name: "c1: active looks at direct children only", file: "src/fold/tree.ts", find: "return children(e, view).some((c) => test(c) || anyDescendant(c, view, test));", replace: "return children(e, view).some((c) => test(c));" },
  { name: "c1: roots sorted by key, not birth", file: "src/fold/tree.ts", find: ".sort((a, b) => a.createdSeq - b.createdSeq);", replace: ".sort((a, b) => (a.key < b.key ? -1 : 1));" },
  { name: "c1: render never shows drained", file: "src/render/tree-view.ts", find: "drained: derived[e.key]?.drained === true,", replace: "drained: false," },
  { name: "c1: discovered work without an actor", file: "src/fold/evaluate.ts", find: 'if (kind === "discovered" && intent.actor === undefined) return reject(', replace: "if (false) return reject(" },
  { name: "c1: parent_id allowed on non-tree types", file: "src/fold/evaluate.ts", find: "if (intent.payload.parent_id !== undefined) return reject(\"unknown-parent\"", replace: "if (false) return reject(\"unknown-parent\"" },
];
// Known gap, deliberately not listed: BEGIN IMMEDIATE -> BEGIN in sqlite-store.ts
// cannot be observed from a single in-process connection.

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "tira-mutant-"));
  for (const p of ["src", "test", "charts", "scripts", "package.json", "tsconfig.json"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runTests(dir: string): number {
  const tests = ["store", "runner", "registry", "write-path", "fold", "stack", "cli", "tree", "render"].map((n) => `test/${n}.test.ts`);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...tests], { cwd: dir, encoding: "utf8" });
  return r.status ?? 1;
}

let survived = 0;
let broken = 0;
const base = scratchCopy();
if (runTests(base) !== 0) {
  console.error("baseline suite fails on an unmutated copy — fix that first");
  process.exit(2);
}
rmSync(base, { recursive: true, force: true });

for (const m of MUTANTS) {
  const dir = scratchCopy();
  try {
    if ("json" in m) {
      const path = join(dir, m.json);
      const t = JSON.parse(readFileSync(path, "utf8"));
      m.edit(t);
      writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
    } else {
      const path = join(dir, m.file);
      const src = readFileSync(path, "utf8");
      const hits = src.split(m.find).length - 1;
      if (hits !== 1) {
        console.log(`BROKEN   ${m.name}: pattern matched ${hits} times (must be exactly 1)`);
        broken++;
        continue;
      }
      writeFileSync(path, src.replace(m.find, m.replace));
      if (m.reextract) spawnSync(process.execPath, ["charts/extract-tables.mjs"], { cwd: dir });
    }
    const code = runTests(dir);
    if (code === 0) survived++;
    console.log(`${code === 0 ? "SURVIVED" : "killed  "} ${m.name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\n${MUTANTS.length - survived - broken}/${MUTANTS.length} killed, ${survived} survived, ${broken} broken`);
process.exit(survived || broken ? 1 : 0);
