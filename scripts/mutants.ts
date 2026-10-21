// Mutation harness: proves the test suite catches real breaks.
// Each mutant plants one bug in a scratch copy of the repo and runs the tests;
// the suite MUST fail. A mutant whose pattern doesn't match exactly once is an
// error too — a silent no-op mutant would report a catch that never happened.
// The match check (scripts/mutant-anchors.ts) proves that for every one up front,
// in seconds, before any test runs.
// Speed: each bug stops at its first failure. It tries the one test that caught it last
// time (.mutant-catchers.json, kept between CI runs by the cache), then whole test files,
// likely catchers first (scripts/mutant-order.ts). Several bugs run at once, one per core.
// Order is speed only: a bug counts as survived only after every whole file passes.
//   node scripts/mutants.ts            (npm run mutants)
//   node scripts/mutants.ts --check    (npm run mutants:check: the match check alone)
//   MUTANT_JOBS=1 node scripts/mutants.ts    (one bug at a time; default: one per core)
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchorProblems } from "./mutant-anchors.ts";
import { catcherFirst, failedTest, namePattern, suiteOrder } from "./mutant-order.ts";

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
  { name: "write path ignores eventId reuse", file: "src/write/write-path.ts", find: "if (canonicalJson(recordedIntent(prior, this.registry)) !== canonicalJson(asLogged)) {", replace: "if (false) {" },
  { name: "write path has no per-stream queue", file: "src/write/write-path.ts", find: "const prev = queues.get(snapshot.stream) ?? Promise.resolve();", replace: "const prev = Promise.resolve();" },
  { name: "write path queue per instance, not per store", file: "src/write/write-path.ts", find: "const queues = queueFor(this.store);", replace: "const queues = queueFor(this as unknown as EventStore);" },
  { name: "write path evaluates the live command, not a snapshot", file: "src/write/write-path.ts", find: "snapshot = structuredClone(cmd);", replace: "snapshot = cmd;" },
  { name: "canonicalJson sorts by locale (Sonar's suggestion)", file: "src/fold/fold.ts", find: "const members = Object.keys(o).sort(compareCodeUnits)", replace: "const members = Object.keys(o).sort((a, b) => a.localeCompare(b))" },
  { name: "fold derived not nested by stream", file: "src/fold/fold.ts", find: "(derived[stream] ??= {})[ent.key] = values;", replace: '(derived["s"] ??= {})[ent.key] = values;' },
  { name: "write path drops expectedRevision on empty stream", file: "src/write/write-path.ts", find: "const expectedRevision = last ? last.streamRevision : -1;", replace: "const expectedRevision = last ? last.streamRevision : undefined;" },
  { name: "write path never retries a lost race", file: "src/write/write-path.ts", find: "if (err instanceof WrongExpectedRevisionError && attempt < this.maxAttempts) {", replace: "if (false) {" },
  // CLI
  { name: "cli: rejected command exits 0", file: "src/cli/cli.ts", find: 'return r.status === "rejected" || r.status === "refused" ? 2 : 0;', replace: 'return r.status === "refused" ? 2 : 0;' },
  { name: "cli: replay ignores N", file: "src/cli/cli.ts", find: 'return await state(store, registry, stream, seqArg(args[0], "replay N"), values, io);', replace: "return await state(store, registry, stream, undefined, values, io);" },
  { name: "cli: key=value values parsed as JSON", file: "src/cli/cli.ts", find: "payload[p.slice(0, eq)] = p.slice(eq + 1);", replace: "payload[p.slice(0, eq)] = (() => { try { return JSON.parse(p.slice(eq + 1)); } catch { return p.slice(eq + 1); } })();" },
  { name: "cli: key=value splits on the last =", file: "src/cli/cli.ts", find: 'const eq = p.indexOf("=");', replace: 'const eq = p.lastIndexOf("=");' },
  { name: "cli: --actor ignored", file: "src/cli/cli.ts", find: "const actor = values.actor ?? io.env.TIRA_ACTOR;\n  const entity = {", replace: "const actor = io.env.TIRA_ACTOR;\n  const entity = {" },
  { name: "cli: TIRA_STREAM ignored", file: "src/cli/cli.ts", find: 'values.stream ?? io.env.TIRA_STREAM ?? "tasktree-main"', replace: 'values.stream ?? "tasktree-main"' },
  { name: "cli: dump hash ignores the content", file: "src/fold/fold.ts", find: "createHash(\"sha256\").update(canonicalJson(r))", replace: "createHash(\"sha256\").update(\"constant\")" },
  { name: "cli: dump ignores --at", file: "src/cli/cli.ts", find: 'return await dump(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);', replace: "return await dump(store, registry, stream, undefined, values, io);" },
  { name: "cli: stored-form event names not accepted", file: "src/cli/cli.ts", find: "/^[a-z][a-z0-9-]*$/.test(rawEvent) ? tableEventName(rawEvent) : rawEvent", replace: "false ? tableEventName(rawEvent) : rawEvent" },
  // Event naming (D1)
  { name: "stored names keep the table's UPPER_SNAKE", file: "src/fold/events.ts", find: 'export const storedName = (tableEvent: string): string => tableEvent.toLowerCase().replaceAll("_", "-");', replace: "export const storedName = (tableEvent: string): string => tableEvent;" },
  { name: "fold accepts non-kebab stored names", file: "src/fold/events.ts", find: "if (!STORED_EVENT_NAME.test(name)) return undefined;", replace: "" },
  { name: "registry allows a CREATED table event", file: "src/tables/registry.ts", find: 'if (ev === "CREATED" || ev === created || ev === revised) throw', replace: 'if (false) throw' },
  // Track C1: tree, drain, cursor, gates, render
  { name: "c1: children prepended, not appended", file: "src/fold/fold.ts", find: "children: [...parent.tree.children, ev.key]", replace: "children: [ev.key, ...parent.tree.children]" },
  { name: "c1: drain ignores cancelled", file: "src/fold/tree.ts", find: "return kids.length > 0 && kids.every((c) => isTerminal(cfg, c));", replace: 'return kids.length > 0 && kids.every((c) => c.regions[cfg.region] === "done");' },
  { name: "c1: a leaf counts as drained", file: "src/fold/tree.ts", find: "return kids.length > 0 && kids.every(", replace: "return kids.every(" },
  { name: "c1: closing gate off", file: "src/fold/evaluate.ts", find: "if (closing && !allChildrenTerminal(t, current, view)) {", replace: "if (false) {" },
  { name: "c1: CANCEL not gated on open children", file: "src/fold/evaluate.ts", find: "const closing = event === t.completeEvent || event === t.cancelEvent;", replace: "const closing = event === t.completeEvent;" },
  { name: "c1: COMPLETE not gated on open children", file: "src/fold/evaluate.ts", find: "const closing = event === t.completeEvent || event === t.cancelEvent;", replace: "const closing = event === t.cancelEvent;" },
  { name: "c1: re-open allowed under a closed parent", file: "src/fold/evaluate.ts", find: "if (parent && isTerminal(t, parent)) {", replace: "if (false) {" },
  { name: "c1: one-active gate off", file: "src/fold/evaluate.ts", find: "  if (t.oneActive && !(pairedClose && event === t.startEvent && isDrained(t, current, view))) {", replace: "  if (false) {" },
  { name: "c1: one-active gate only on START", file: "src/fold/evaluate.ts", find: "  if (t.oneActive && !(pairedClose && event === t.startEvent && isDrained(t, current, view))) {", replace: '  if (t.oneActive && !(pairedClose && event === t.startEvent && isDrained(t, current, view)) && event === "START") {' },
  { name: "c1: active ignores descendants", file: "src/fold/tree.ts", find: ".filter((e) => isActiveState(e) && !anyDescendant(e, view, isActiveState));", replace: ".filter((e) => isActiveState(e));" },
  { name: "c1: cursor stops at parents", file: "src/fold/tree.ts", find: "if (isActionable(cfg, e) && (e.tree?.children.length ?? 0) === 0) {", replace: "if (isActionable(cfg, e)) {" },
  { name: "c1: cursor parks on parents waiting for tira", file: "src/fold/tree.ts", find: "if (isActionable(cfg, e) && (e.tree?.children.length ?? 0) === 0) {", replace: "if (isActionable(cfg, e) && ((e.tree?.children.length ?? 0) === 0 || isDrained(cfg, e, view))) {" },
  { name: "c1: depth cap off", file: "src/fold/evaluate.ts", find: "if (depth > t.maxDepth) return reject(", replace: "if (false) return reject(" },
  { name: "c1: children cap off", file: "src/fold/evaluate.ts", find: "if (parent.tree.children.length >= t.maxChildren) {", replace: "if (false) {" },
  { name: "c1: parent's table not consulted (child under done)", file: "src/fold/evaluate.ts", find: "    return reject(\"denied\", `${table?.id}: ${parentState} + ${t.childEvent} (re-open ${parent.key} first)`);", replace: "    void 0;" },
  { name: "c1: discovered work without discovered_during", file: "src/fold/evaluate.ts", find: 'if (kind === "discovered" && discoveredDuring === undefined) {', replace: "if (false) {" },
  { name: "c1: node birth name ignored (node.created)", file: "src/tables/registry.ts", find: '      createdAs: "BORN",\n', replace: "" },
  { name: "c1: render drops the cursor flag", file: "src/render/html.ts", find: 'data-cursor="${r.cursor}"', replace: 'data-cursor="false"' },
  { name: "c1: render escapes nothing", file: "src/render/escape.ts", find: "export const esc = (s: string): string => s.replace(/[&<>\"']/g, (c) => `&#${c.codePointAt(0)};`);", replace: "export const esc = (s: string): string => s;" },
  { name: "c1: active looks at direct children only", file: "src/fold/tree.ts", find: "return children(e, view).some((c) => test(c) || anyDescendant(c, view, test));", replace: "return children(e, view).some((c) => test(c));" },
  { name: "c1: roots sorted by key, not birth", file: "src/fold/tree.ts", find: "    .sort(byBirth);", replace: "    .sort((a, b) => (a.key < b.key ? -1 : 1));" },
  { name: "c1: render never shows drained", file: "src/render/tree-view.ts", find: "drained: derived[e.key]?.drained === true,", replace: "drained: false," },
  { name: "c1: discovered work without an actor", file: "src/fold/evaluate.ts", find: 'if (kind === "discovered" && intent.actor === undefined) return reject(', replace: "if (false) return reject(" },
  { name: "c1: parent_id allowed on non-tree types", file: "src/fold/evaluate.ts", find: "if (intent.payload.parent_id !== undefined) return reject(\"unknown-parent\"", replace: "if (false) return reject(\"unknown-parent\"" },
  // tira holds the pen (ruling 2026-10-18)
  { name: "tira: never closes anything", file: "src/write/write-path.ts", find: "const plan = internal ? undefined : this.planTiraCloses(intent, entities, moveId);", replace: "const plan: ClosePlan | undefined = undefined;" },
  { name: "tira: closes on any move, not just starting work", file: "src/write/write-path.ts", find: "if (res.outcome !== \"transition\" || res.to !== t.active) return undefined;", replace: "if (res.outcome !== \"transition\") return undefined;" },
  { name: "tira: the chain doesn't climb", file: "src/write/write-path.ts", find: "for (let guard = 0; guard <= entities.size; guard++) {", replace: "for (let guard = 0; guard < 1; guard++) {" },
  { name: "tira: closes an ancestor of the task being started", file: "src/fold/tree.ts", find: ".filter((e) => awaitingClose(cfg, e, view) && !contains(e, targetKey, view))", replace: ".filter((e) => awaitingClose(cfg, e, view))" },
  { name: "tira: skips the start of an unstarted parent", file: "src/write/write-path.ts", find: "if (parent.regions[t.region] !== t.active) {", replace: "if (false) {" },
  { name: "tira: closes land after the move", file: "src/write/write-path.ts", find: "batch: [...(plan?.records ?? []), move],", replace: "batch: [move, ...(plan?.records ?? [])]," },
  { name: "tira: writes even when the move is rejected", file: "src/write/write-path.ts", find: "batch: [toRejectedEvent(intent, code, detail, moveId)],", replace: "batch: [...(plan?.records ?? []), toRejectedEvent(intent, code, detail, moveId)]," },
  { name: "tira: drops the causationId", file: "src/write/write-path.ts", find: "metadata: { actor: MACHINE_ACTOR, causationId: moveId } });", replace: "metadata: { actor: MACHINE_ACTOR } });" },
  { name: "tira: name not reserved", file: "src/write/write-path.ts", find: "if (!internal && isReserved(intent.actor)) {", replace: "if (false) {" },
  { name: "tira: reserved name is case-sensitive", file: "src/write/write-path.ts", find: "RESERVED.has(skeleton(actor))", replace: "RESERVED.has(actor)" },
  { name: "tira: a retried claim isn't a duplicate", file: "src/write/write-path.ts", find: "canonicalJson(asLogged)", replace: "canonicalJson(intent)" },
  { name: "tira: REOPEN doesn't count as moving on", file: "src/write/write-path.ts", find: "if (res.outcome !== \"transition\" || res.to !== t.active) return undefined;", replace: "if (res.outcome !== \"transition\" || res.to !== t.active || intent.event === \"REOPEN\") return undefined;" },
  { name: "tira: its start judged alone by one-active (write path)", file: "src/write/write-path.ts", find: "{ pairedClose: s.paired === true }", replace: "{}" },
  { name: "tira: rule checker ignores the pair", file: "src/fold/evaluate.ts", find: "  if (t.oneActive && !(pairedClose && event === t.startEvent && isDrained(t, current, view))) {", replace: "  if (t.oneActive) {" },
  { name: "tira: a failed close keeps its start", file: "src/write/write-path.ts", find: "        overlay.set(parent.key, before);\n        records.push(refused);", replace: "        records.push(...mine, refused);" },
  { name: "tira: a failed close isn't logged", file: "src/write/write-path.ts", find: "        overlay.set(parent.key, before);\n        records.push(refused);", replace: "        overlay.set(parent.key, before);" },
  { name: "tira: keeps retrying after a failed close", file: "src/write/write-path.ts", find: "        records.push(refused);\n        break;", replace: "        records.push(refused);\n        continue;" },
  { name: "replay: no paired treatment for tira's start", file: "src/fold/fold.ts", find: "{ pairedClose: paired !== undefined, era }", replace: "{ era }" },
  { name: "replay: any tira start treated as paired", file: "src/fold/fold.ts", find: "{ pairedClose: paired !== undefined, era }", replace: "{ pairedClose: e.metadata?.actor === MACHINE_ACTOR, era }" },
  { name: "replay: pair check ignores the node", file: "src/fold/fold.ts", find: "    entityKey(ia.entity) === entityKey(ib.entity) &&\n", replace: "" },
  { name: "replay: pair check accepts someone else's complete", file: "src/fold/fold.ts", find: "if (a.metadata?.actor !== MACHINE_ACTOR || b.metadata?.actor !== MACHINE_ACTOR) return false;", replace: "if (a.metadata?.actor !== MACHINE_ACTOR) return false;" },
  { name: "replay: pair kept when its complete fails", file: "src/fold/fold.ts", find: "if (ev.ok && paired && !completes(paired, entities, ev))", replace: "if (false)" },
  { name: "replay: tira may write to any node", file: "src/fold/fold.ts", find: "if (!t || !target || !isDrained(t, target, view)) anomaly(", replace: "if (false) anomaly(" },
  { name: "tira: pair treatment for an unfinished node", file: "src/fold/evaluate.ts", find: " && isDrained(t, current, view))) {", replace: ")) {" },
  { name: "tira: invisible characters and lookalikes allowed", file: "src/text.ts", find: "[...s.normalize(\"NFKD\").replace(/[\\p{M}\\p{Cf}\\p{Cc}\\s]/gu, \"\").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join(\"\")", replace: "s.normalize(\"NFKC\").trim().toLowerCase()" },
  { name: "replay: pair check ignores the trigger", file: "src/fold/fold.ts", find: "typeof trigger === \"string\" &&\n    trigger === ib.payload.trigger", replace: "typeof trigger === \"string\"" },
  { name: "replay: a refused event after tira's write isn't checked", file: "src/fold/fold.ts", find: "intent: d.intent,\n      });\n      if (!byTira) settle(e, undefined);", replace: "intent: d.intent,\n      });" },
  { name: "replay: an illegal event after tira's write isn't checked", file: "src/fold/fold.ts", find: "anomaly(`${ev.code}: ${ev.detail}`);\n      if (!byTira) settle(e, undefined);", replace: "anomaly(`${ev.code}: ${ev.detail}`);" },
  { name: "tira: a repeat click wipes the closed-by-tira mark", file: "src/fold/fold.ts", find: "if (ev.outcome !== \"noop\") movedBy.set(", replace: "movedBy.set(" },
  { name: "render: tira's lines cite a raw id, not the seq", file: "src/render/html.ts", find: "return seq === undefined ? `cites ${trigger} (not in this stream)` : `cites seq ${seq}`;", replace: "return `cites ${trigger}`;" },
  { name: "cli: tira's closes not printed", file: "src/cli/cli.ts", find: "const closes = (r.closedByTira ?? []).map(", replace: "const closes = [].map(" },
  { name: "tira: refusal logged under tira's name", file: "src/write/write-path.ts", find: "toRejectedEvent({ ...intent, actor: undefined }, \"reserved-actor\"", replace: "toRejectedEvent(intent, \"reserved-actor\"" },
  { name: "replay: cited move not checked", file: "src/fold/fold.ts", find: "const ok = p.trigger === e.eventId && intoActive && moved !== undefined && parent !== undefined && !contains(parent, moved.key, view);", replace: "const ok = true;" },
  { name: "replay: cited move needn't start work", file: "src/fold/fold.ts", find: "const ok = p.trigger === e.eventId && intoActive && moved", replace: "const ok = p.trigger === e.eventId && moved" },
  { name: "replay: cited move may be inside the closed parent", file: "src/fold/fold.ts", find: " && !contains(parent, moved.key, view);", replace: ";" },
  { name: "replay: a tira write without a trigger passes", file: "src/fold/fold.ts", find: "anomaly(\"tira wrote this without citing a move\");", replace: "void 0;" },
  { name: "replay: a trigger with no move after it passes", file: "src/fold/fold.ts", find: "for (const p of ps) {\n      anomalies.push(", replace: "for (const p of []) {\n      anomalies.push(" },
  { name: "replay: a cut mid-append counts as an anomaly", file: "src/fold/fold.ts", find: "    if (cut) continue;\n", replace: "" },
  { name: "tira: everyone's closes count as tira's", file: "src/fold/fold.ts", find: "values.closedByTira = isTerminal(def.tree, ent) && movedBy.get(", replace: "values.closedByTira = isTerminal(def.tree, ent) || movedBy.get(" },
  { name: "tira: waiting-for-tira flag never set", file: "src/fold/fold.ts", find: "values.awaitingClose = awaitingClose(def.tree, ent, view);", replace: "values.awaitingClose = false;" },
  // B3 divergence watchdog
  { name: "divergence: tira-side duplicates ignored", file: "src/divergence/divergence.ts", find: "if (f.length >= 2 || t.length >= 2) {", replace: "if (f.length >= 2) {" },
  { name: "divergence: DUPLICATE judged after WRONG-ENTITY", file: "src/divergence/divergence.ts", find: "  if (f.length >= 2 || t.length >= 2) {\n    return { verdict: \"DUPLICATE\"", replace: "  if (f.length >= 2 && f[0]?.entity === t[0]?.entity || t.length >= 2) {\n    return { verdict: \"DUPLICATE\"" },
  { name: "divergence: a kind mismatch is not WRONG-ENTITY", file: "src/divergence/divergence.ts", find: "const kindDiffers = ts.kind !== undefined && ts.kind !== fs.kind;", replace: "const kindDiffers = false;" },
  { name: "divergence: entity never compared", file: "src/divergence/divergence.ts", find: "if (ts.entity !== fs.entity || kindDiffers) {", replace: "if (kindDiffers) {" },
  { name: "divergence: ORPHAN never judged", file: "src/divergence/divergence.ts", find: "if (!born.has(subject.entity)) {", replace: "if (false) {" },
  { name: "divergence: a rejected command gives birth", file: "src/divergence/divergence.ts", find: "if (seen.applied && seen.kind !== undefined && BIRTHS.includes(seen.kind))", replace: "if (seen.kind !== undefined && BIRTHS.includes(seen.kind))" },
  { name: "divergence: a rejected command counts as applied", file: "src/divergence/divergence.ts", find: "if (fs !== undefined && (ts === undefined || !ts.applied)) {", replace: "if (fs !== undefined && ts === undefined) {" },
  { name: "divergence: REVISED is not a birth", file: "src/divergence/divergence.ts", find: "export const BIRTHS: readonly string[] = [\"NAMED\", \"CREATED\", \"REVISED\", \"FILED\"];", replace: "export const BIRTHS: readonly string[] = [\"NAMED\", \"CREATED\", \"FILED\"];" },
  { name: "divergence: non-fx tira events judged", file: "src/divergence/divergence.ts", find: "    if (!e.eventId.startsWith(FX)) continue;\n", replace: "" },
  { name: "divergence: ids sorted by locale", file: "src/divergence/divergence.ts", find: "].sort(compareCodeUnits);", replace: "].sort((a, b) => a.localeCompare(b));" },
  { name: "divergence: last record per id wins (order read)", file: "src/divergence/divergence.ts", find: "fac.set(r.event_id, [...(fac.get(r.event_id) ?? []), seen]);", replace: "fac.set(r.event_id, [seen]);" },
  { name: "divergence: atSeq is the last event read, not the highest", file: "src/divergence/divergence.ts", find: "if (e.seq > atSeq) atSeq = e.seq;", replace: "atSeq = e.seq;" },
  { name: "cli: divergences exit 1", file: "src/cli/cli.ts", find: "  else printDivergence(r, io);\n  return 0;", replace: "  else printDivergence(r, io);\n  return r.findings.length > 0 ? 1 : 0;" },
  // "accepts an unhashed input", redefined by the 2026-10-20 ruling: a live run that records a
  // hash it did not compute from the bytes it read, or records none.
  { name: "cli: live run accepts an unhashed factory input (records no hash)", file: "src/cli/cli.ts", find: "  const snapshot = sha256(bytes);\n  const side", replace: "  const snapshot = \"\";\n  const side" },
  { name: "cli: live run accepts an unhashed factory input (hash not of the bytes read)", file: "src/cli/cli.ts", find: "  const snapshot = sha256(bytes);\n  const side", replace: "  const snapshot = sha256(file);\n  const side" },
  { name: "cli: live run accepts an unhashed factory input (sidecar's value recorded, not the bytes')", file: "src/cli/cli.ts", find: "  return { snapshot, pin: \"sha256\", file };", replace: "  return { snapshot: text === undefined ? snapshot : (text.trim().split(/\\s+/)[0] ?? \"\"), pin: \"sha256\", file };" },
  { name: "cli: live run ignores a sidecar mismatch", file: "src/cli/cli.ts", find: "if (declared !== snapshot) throw", replace: "if (false) throw" },
  { name: "cli: live run refuses when no sidecar is present", file: "src/cli/cli.ts", find: "if (code !== \"ENOENT\") throw", replace: "if (true) throw" },
  { name: "cli: live run accepts an unreadable sidecar", file: "src/cli/cli.ts", find: "if (code !== \"ENOENT\") throw", replace: "if (false) throw" },
  { name: "cli: live run refuses a matching sidecar", file: "src/cli/cli.ts", find: "if (declared !== snapshot) throw", replace: "if (declared === snapshot) throw" },
  { name: "cli: live runs not logged", file: "src/cli/cli.ts", find: "  if (live) {\n    const row = {", replace: "  if (false) {\n    const row = {" },
  { name: "cli: fixture runs logged too", file: "src/cli/cli.ts", find: "  if (live) {\n    const row = {", replace: "  if (true) {\n    const row = {" },
  { name: "cli: an empty input reads as a zero report", file: "src/cli/cli.ts", find: "  if (rows.length === 0) throw new UsageError(`${what} ${file} has no records`);\n", replace: "" },
  { name: "cli: an empty stream reads as a zero report", file: "src/cli/cli.ts", find: "    if (events.length === 0) throw new UsageError(`stream ${stream} has no events in ${db}`);\n", replace: "" },
  { name: "render: no closed-by-tira mark", file: "src/render/html.ts", find: "r.closedByTira ? `<span class=\"mark tira\">closed by tira</span>` : \"\",", replace: "\"\"," },
  { name: "render: progress counts only done, not cancelled", file: "src/render/html.ts", find: 'const CLOSED = new Set(["done", "cancelled"]);', replace: 'const CLOSED = new Set(["done"]);' },
  { name: "render: drawer ids don't match the links", file: "src/render/html.ts", find: "<section class=\"drawer\" id=\"t${n.i}\"", replace: "<section class=\"drawer\" id=\"d${n.i}\"" },
  { name: "render: board puts parents in the columns", file: "src/render/html.ts", find: "const leaves = nodes.filter((n) => n.row.children.length === 0 || n.row.state !== \"unstarted\");", replace: "const leaves = nodes;" },
  { name: "render: a blocked or started parent drops off Kanban", file: "src/render/html.ts", find: "n.row.children.length === 0 || n.row.state !== \"unstarted\");", replace: "n.row.children.length === 0);" },
  { name: "render: --at N shows history from after N", file: "src/render/html.ts", find: "  events = events.filter((e) => e.seq <= r.lastSeq);", replace: "" },
  { name: "render: no history per task", file: "src/render/html.ts", find: "byKey, links, (trail.get(n.row.key) ?? []).length);", replace: "byKey, links, 0);" },
  // Track B1: factory tables, handoffs, dispatcher, lanes
  { name: "b1: captures never applied", file: "src/fold/evaluate.ts", find: "const captured = applyCapture(current.context?.[hit.region], res.capture, intent.payload);", replace: "const captured = current.context?.[hit.region];" },
  { name: "b1: guards don't see their region's captured data", file: "src/fold/evaluate.ts", find: "    view,\n    own,\n  });", replace: "    view,\n  });" },
  { name: "b1: superseded versions still take events", file: "src/fold/evaluate.ts", find: "if (def.revisedAs !== undefined && current.version !== undefined && view.get({ type: def.type, id: current.id, version: current.version + 1 })) {", replace: "if (false) {" },
  { name: "b1: a revise needs no predecessor", file: "src/fold/evaluate.ts", find: "      if (!view.get({ type: def.type, id: intent.entity.id, version: v - 1 })) {", replace: "      if (false) {" },
  { name: "b1: births unguarded", file: "src/fold/evaluate.ts", find: "    if (def.createGuard !== undefined) {", replace: "    if (false) {" },
  { name: "b1: revisions stored as brief.created", file: "src/tables/registry.ts", find: "    if (def?.revisedAs !== undefined && version !== undefined && version > 1) return def.revisedAs;\n", replace: "" },
  { name: "b1: dispatcher name not reserved", file: "src/write/write-path.ts", find: "const RESERVED = new Set([MACHINE_ACTOR, DISPATCHER]);", replace: "const RESERVED = new Set([MACHINE_ACTOR]);" },
  { name: "b1: claimant check lets anyone post evidence", file: "src/tables/factory.ts", find: "fromClaimantOrDispatcher: ({ actor, own }) => actor === DISPATCHER || (s(actor) && actor === own?.claimant),", replace: "fromClaimantOrDispatcher: ({ actor }) => s(actor)," },
  { name: "b1: a timeout can end a session", file: "src/tables/factory.ts", find: "    (payload.declared_by === \"user\" && actor === USER),", replace: "    (payload.declared_by === \"user\" && actor === USER) || payload.declared_by === \"timeout\"," },
  { name: "b1: the filer can verify its own drop", file: "src/tables/factory.ts", find: "actor === ORCHESTRATOR && actor !== entity.createdBy && verifies(payload.done_test_result),", replace: "(actor === ORCHESTRATOR || actor === entity.createdBy) && verifies(payload.done_test_result)," },
  { name: "b1: verify without a PASS", file: "src/tables/factory.ts", find: "actor === ORCHESTRATOR && actor !== entity.createdBy && verifies(payload.done_test_result),", replace: "actor === ORCHESTRATOR && actor !== entity.createdBy," },
  { name: "b1: anyone files drops", file: "src/tables/factory.ts", find: "dropFiledBySession: ({ actor }) => s(actor) && !ROLES.has(actor),", replace: "dropFiledBySession: ({ actor }) => s(actor)," },
  { name: "H1: ignores blocked_by", file: "src/fold/handoffs.ts", find: "    const ready = unverifiedDeps(view, b).length === 0;", replace: "    const ready = true;" },
  { name: "H2: doesn't check the filer holds the claim", file: "src/fold/handoffs.ts", find: " && b.context?.claim?.claimant === d.createdBy && b.regions.outcome === \"open\") {\n      if (b.regions.claim", replace: " && b.regions.outcome === \"open\") {\n      if (b.regions.claim" },
  { name: "H2: skips the evidence (silent stays silent)", file: "src/fold/handoffs.ts", find: "      if (b.regions.claim === \"claimed-silent\") on(\"H2\", b, \"EVIDENCE\", { type: \"drop\" }, filed);\n      else on(", replace: "      on(" },
  { name: "H3: drops the done-test result", file: "src/fold/handoffs.ts", find: "{ done_test_result: verified.payload.done_test_result }", replace: "{}" },
  { name: "H4: wrong block reason", file: "src/fold/handoffs.ts", find: "{ block_reason: \"defective\" }, rejected", replace: "{ block_reason: \"verdict\" }, rejected" },
  { name: "H5: releases briefs whose drop already landed", file: "src/fold/handoffs.ts", find: "b.context?.claim?.claimant === s.id && b.regions.outcome === \"open\") {", replace: "b.context?.claim?.claimant === s.id) {" },
  { name: "H6: lifts any block", file: "src/fold/handoffs.ts", find: " && b.context?.outcome?.block_reason === \"dependency\" && ready) {", replace: " && ready) {" },
  { name: "F1: ideas never born", file: "src/fold/handoffs.ts", find: "    if (!approved || view.get({ type: \"node\", id: i.id })) continue;", replace: "    continue;" },
  { name: "replay: dispatcher writes not checked", file: "src/fold/fold.ts", find: "      if (!called) anomaly(`the dispatcher wrote", replace: "      if (false) anomaly(`the dispatcher wrote" },
  { name: "replay: correlation id not checked", file: "src/fold/fold.ts", find: " && r.correlationId === e.metadata.correlationId);", replace: ");" },
  { name: "pending: briefs waiting on dependencies not listed", file: "src/fold/handoffs.ts", find: "    if (dispatched && b.regions.gate === \"gated\" && b.regions.claim === \"waiting\" && waiting.length > 0) {", replace: "    if (false) {" },
  { name: "pending: stray drops not listed", file: "src/fold/handoffs.ts", find: "      if (why) add(\"H2\", ", replace: "      if (false) add(\"H2\", " },
  { name: "block relay: undispatched briefs can be blocked", file: "src/fold/handoffs.ts", find: "  if (b.regions.gate !== \"gated\") return \"undispatched briefs are denied, not blocked: send DENIED\";\n", replace: "" },
  { name: "block relay: verdicts before a claim", file: "src/fold/handoffs.ts", find: "    return HELD.has(b.regions.claim as string) ? undefined : `${show(reason)} blocks need a claimed brief`;", replace: "    return undefined;" },
  { name: "block relay: anyone can ask", file: "src/fold/handoffs.ts", find: "  if (actor !== ORCHESTRATOR) return \"only the orchestrator can ask to block a brief\";\n", replace: "" },
  { name: "dispatcher: writes only the first handoff", file: "src/write/dispatcher.ts", find: "    for (let n = 0; n < MAX_HANDOFFS; n++) {", replace: "    for (let n = 0; n < 1; n++) {" },
  { name: "dispatcher: tries handoffs the rules refuse", file: "src/write/dispatcher.ts", find: "return due(view, idx, this.registry).find((r) => evaluate(this.registry, entities, view, intentOf(r, DISPATCHER)).ok);", replace: "return due(view, idx, this.registry)[0];" },
  { name: "dispatcher: no correlation id", file: "src/write/dispatcher.ts", find: "        correlationId: next.correlationId,\n", replace: "" },
  { name: "render: lanes show the wrong region state", file: "src/render/html.ts", find: "data-region=\"${esc(region)}\" data-state=\"${esc(state)}\">${pill(state)}", replace: "data-region=\"${esc(region)}\" data-state=\"${esc(Object.values(e.regions)[0] as string)}\">${pill(state)}" },
  { name: "render: handoff pairs not grouped by correlation", file: "src/render/html.ts", find: "    if (e.metadata.actor === \"dispatcher\" && c !== undefined) groups.set(c, [...(groups.get(c) ?? []), e]);", replace: "    if (e.metadata.actor === \"dispatcher\" && c !== undefined) groups.set(e.eventId, [e]);" },
  // Found by the adversarial review
  { name: "review: no last-moment due check (concurrent duplicates)", file: "src/write/write-path.ts", find: "      if (stillDue && !stillDue(events)) return { status: \"skipped\", seq: last?.seq ?? 0 };\n", replace: "" },
  { name: "review: drops don't follow brief versions", file: "src/tables/factory.ts", find: "createGuard: \"dropFiledBySession\", followsVersionsOf: \"brief\",", replace: "createGuard: \"dropFiledBySession\"," },
  { name: "review: a retry doesn't catch up", file: "src/write/dispatcher.ts", find: "result.status === \"appended\" || result.status === \"duplicate\" ? await this.catchUp", replace: "result.status === \"appended\" ? await this.catchUp" },
  { name: "review: a verified drop on a blocked brief not listed", file: "src/fold/handoffs.ts", find: "    if (verified && b && taken && b.regions.outcome !== \"done-verified\" && b.regions.outcome !== \"dropped-unverified\") {", replace: "    if (false) {" },
  { name: "review: a taken node id not listed", file: "src/fold/handoffs.ts", find: "    if (approved && node && born?.payload.idea_id !== i.id) {", replace: "    if (false) {" },
  { name: "review: reserved names miss control characters", file: "src/text.ts", find: "[\\p{M}\\p{Cf}\\p{Cc}\\s]", replace: "[\\p{M}\\p{Cf}\\s]" },
  { name: "review: reserved names miss Cyrillic lookalikes", file: "src/text.ts", find: "\"\u0430\": \"a\", \"\u0441\": \"c\", \"\u0435\": \"e\", \"\u0456\": \"i\", \"\u043e\": \"o\", \"\u0440\": \"p\",", replace: "\"\u0430\": \"a\", \"\u0456\": \"i\"," },
  { name: "review: supersedes typed as text refused", file: "src/fold/evaluate.ts", find: "Number(intent.payload.supersedes) !== v - 1", replace: "intent.payload.supersedes !== v - 1" },
  { name: "review: a race-refused receiver is logged as the dispatcher's", file: "src/write/dispatcher.ts", find: " && evaluate(this.registry, entities, view, intentOf(next, DISPATCHER)).ok;", replace: ";" },
  // The board: Kanban | Graph
  { name: "render: the next-task pin rides on the active task, not the cursor", file: "src/render/html.ts", find: "const pin = r.cursor ? `<span class=\"here\">", replace: "const pin = r.active ? `<span class=\"here\">" },
  { name: "render: no waiting ring on graph nodes", file: "src/render/html.ts", find: "const waitRing = r.awaitingClose ?", replace: "const waitRing = false ?" },
  { name: "render: no tira mark on graph nodes", file: "src/render/html.ts", find: "const tiraMark = r.closedByTira ?", replace: "const tiraMark = false ?" },
  { name: "render: the active node isn't marked", file: "src/render/html.ts", find: "r.active ? \"is-active\" : \"\",\n  ].filter(Boolean)", replace: "\"\",\n  ].filter(Boolean)" },
  { name: "render: long names not shortened on the graph", file: "src/render/html.ts", find: "${esc(short(r.id))}</span></span>`", replace: "${esc(r.id)}</span></span>`" },
  { name: "render: a closed child's line never turns green", file: "src/render/html.ts", find: "CLOSED.has(n.row.state) ? \"e done\" : \"e\"", replace: "\"e\"" },
  { name: "render: parent nodes count what's left wrong", file: "src/render/html.ts", find: "  const left = ks.length - closed;", replace: "  const left = ks.length;" },
  { name: "fx: the canvas formats its own numbers", file: "src/serve/graph.mjs", find: "    b.style.left = `${fx(p.x)}px`;", replace: "    b.style.left = `${p.x.toFixed(2)}px`;" },
  { name: "fx: the page's graph formats its own numbers", file: "src/render/html.ts", find: "style=\"left:${fx(p.x)}px;", replace: "style=\"left:${p.x.toFixed(2)}px;" },
  { name: "fx: the graph's lines skip the formatter", file: "src/serve/layout.mjs", find: "return `M${fx(p.x)} ${y1}C", replace: "return `M${p.x} ${y1}C" },
  { name: "fx: two decimals instead of one", file: "src/serve/layout.mjs", find: "export const fx = (n) => n.toFixed(1);", replace: "export const fx = (n) => n.toFixed(2);" },
  { name: "layout: a parent isn't centred over its children", file: "src/serve/layout.mjs", find: "const centre = (p.offs[0] + p.offs.at(-1)) / 2;", replace: "const centre = p.offs[0];" },
  { name: "layout: rows aren't spaced by depth", file: "src/serve/layout.mjs", find: "y: up === undefined ? G.top : up.y + G.level }", replace: "y: up === undefined ? G.top : up.y + G.box }" },
  { name: "layout: siblings packed with no gap", file: "src/serve/layout.mjs", find: "right[d] - s.left[d] + G.gap", replace: "right[d] - s.left[d]" },
  { name: "layout: siblings packed on the first row only", file: "src/serve/layout.mjs", find: "for (let d = 0; d < Math.min(right.length, s.left.length); d++)", replace: "for (let d = 0; d < 1; d++)" },
  { name: "layout: a fold hides nothing", file: "src/serve/layout.mjs", find: "(shown.has(n.parent) && !folded.has(n.parent))", replace: "shown.has(n.parent)" },
  { name: "layout: big trees never compact", file: "src/serve/layout.mjs", find: "const compact = shown.size > STACK.compact;", replace: "const compact = false;" },
  { name: "layout: a column reserves one row only", file: "src/serve/layout.mjs", find: "const rows = Math.floor((end - STACK.pitch + G.box - 1) / G.level);", replace: "const rows = 1;" },
  { name: "layout: column tasks not indented", file: "src/serve/layout.mjs", find: "out.push([c, dx + STACK.dx, y]);", replace: "out.push([c, dx, y]);" },
  { name: "zoom: not around the pointer", file: "src/serve/layout.mjs", find: "return { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, s };", replace: "return { x: view.x * k, y: view.y * k, s };" },
  { name: "zoom: no limits", file: "src/serve/layout.mjs", find: "const clamp = (s) => Math.min(ZOOM.max, Math.max(ZOOM.min, s));", replace: "const clamp = (s) => s;" },
  { name: "fit: blows a small tree up past life size", file: "src/serve/layout.mjs", find: "clamp(Math.min(1, (vw - 2 * pad) / width", replace: "clamp(Math.min(4, (vw - 2 * pad) / width" },
  { name: "finished branches: an open task inside counts as finished", file: "src/serve/layout.mjs", find: "subtree(nodes, n.key).every((k) => isClosed(k))", replace: "subtree(nodes, n.key).some((k) => isClosed(k))" },
  { name: "render: no found-while line", file: "src/render/html.ts", find: "n.row.discoveredDuring !== n.parent?.row.key && byKey.has(n.row.discoveredDuring)", replace: "false" },
  { name: "render: the board opens on Graph, not Kanban", file: "src/render/html.ts", find: "${s === \"kanban\" ? \" checked\" : \"\"}", replace: "${s === \"graph\" ? \" checked\" : \"\"}" },
  // Dependency graph, frontier, scenario runner
  { name: "dag: cycle check off", file: "src/fold/evaluate.ts", find: "      if (loop) return reject(\"cycle\"", replace: "      if (false) return reject(\"cycle\"" },
  { name: "dag: a new version's own dependencies ignored", file: "src/fold/evaluate.ts", find: "  edges.set(id, Array.isArray(deps) ? deps.filter((x): x is string => typeof x === \"string\") : []);\n", replace: "" },
  { name: "frontier: claimed briefs stay on it", file: "src/tables/factory.ts", find: " && b.regions.claim === \"unclaimed\"", replace: "" },
  { name: "frontier: superseded versions stay on it", file: "src/tables/factory.ts", find: "    .filter((b) => !isSuperseded(view, b) && b.regions.gate", replace: "    .filter((b) => b.regions.gate" },
  { name: "frontier: waitingOn not derived", file: "src/tables/factory.ts", find: "        waitingOn: (b, { view }) => unverifiedDeps(view, b),", replace: "        waitingOn: () => []," },
  { name: "page: no claimable-now mark", file: "src/render/html.ts", find: "const tag = ready.has(e.key) ? `<span class=\"ready\">claimable now</span>`", replace: "const tag = false ? `<span class=\"ready\">claimable now</span>`" },
  { name: "cli: frontier not printed", file: "src/cli/cli.ts", find: "  if (ready !== undefined) {\n    io.out(\"\");\n    io.out(`claimable now", replace: "  if (false) {\n    io.out(\"\");\n    io.out(`claimable now" },
  { name: "scenarios: step outcomes not checked", file: "src/scenario/run.ts", find: "      if (got !== want) failures.push(", replace: "      if (false) failures.push(" },
  { name: "scenarios: replay snapshots not checked", file: "src/scenario/run.ts", find: "    failures.push(...check(`replay to ${snap.after}", replace: "    void (`replay to ${snap.after}`, check(`replay to ${snap.after}" },
  { name: "scenarios: handoffs not checked", file: "src/scenario/run.ts", find: "        if (canonicalJson(wrote) !== canonicalJson(step.handoffs)) failures.push(", replace: "        if (false) failures.push(" },
  { name: "scenarios: prerequisites skipped", file: "src/scenario/run.ts", find: "    out.push(...stepsOf(pre, all, seen));", replace: "    void pre;" },
  { name: "frontier: dependencies ignored", file: "src/tables/factory.ts", find: " && unverifiedDeps(view, b).length === 0)\n    .sort(", replace: ")\n    .sort(" }, // only a tampered log can trip it
  { name: "scenarios: absent not checked", file: "src/scenario/run.ts", find: "  for (const key of x.absent ?? []) if (ents.has(key)) bad.push(", replace: "  for (const key of x.absent ?? []) if (false) bad.push(" },
  { name: "scenarios: drained not checked", file: "src/scenario/run.ts", find: "  for (const k of x.drained ?? []) if (d[k]?.drained !== true) bad.push(", replace: "  for (const k of x.drained ?? []) if (false) bad.push(" },
  { name: "scenarios: notDrained not checked", file: "src/scenario/run.ts", find: "  for (const k of x.notDrained ?? []) if (d[k]?.drained === true) bad.push(", replace: "  for (const k of x.notDrained ?? []) if (false) bad.push(" },
  { name: "scenarios: awaitingClose not checked", file: "src/scenario/run.ts", find: "  if (x.awaitingClose !== undefined) eq(", replace: "  if (false) eq(" },
  { name: "scenarios: closedByTira not checked", file: "src/scenario/run.ts", find: "  if (x.closedByTira !== undefined) eq(", replace: "  if (false) eq(" },
  { name: "scenarios: anomalies not checked", file: "src/scenario/run.ts", find: "  if (anomalies.length !== (x.anomalies ?? 0)) bad.push(", replace: "  if (false) bad.push(" },
  { name: "scenarios: frontier not checked", file: "src/scenario/run.ts", find: "  if (x.frontier !== undefined) eq(", replace: "  if (false) eq(" },
  { name: "scenarios: provenance not checked", file: "src/scenario/run.ts", find: "    eq(`${key}'s provenance`,", replace: "    void (`${key}'s provenance`," },
  { name: "scenarios: pairs not checked", file: "src/scenario/run.ts", find: "    if (!from || !to) bad.push(`${where}: no pair", replace: "    if (false) bad.push(`${where}: no pair" },
  { name: "scenarios: multi-region one-word states allowed", file: "src/scenario/run.ts", find: "    if (typeof want === \"string\" && Object.keys(regionsOf(e)).length > 1) bad.push(", replace: "    if (false) bad.push(" },
  // Ruling 2026-10-18: the two holes closed
  { name: "ruling: an unnamed session can claim", file: "src/tables/factory.ts", find: "      mustExist: [{ on: \"CLAIMED\", type: \"session\", from: \"payload.session\" }], // ruling 2026-10-18: a named session claims\n", replace: "" },
  { name: "ruling: an unnamed session can file a drop", file: "src/tables/factory.ts", find: "      mustExist: [{ on: \"birth\", type: \"session\", from: \"actor\" }], // ruling 2026-10-18: a named session files\n", replace: "" },
  { name: "ruling: anyone can rename a session", file: "src/tables/factory.ts", find: "renamedByAllowed: ({ actor, entity }) => s(actor) && (actor === entity.id || actor === ORCHESTRATOR || actor === MAC),", replace: "renamedByAllowed: ({ actor }) => s(actor)," },
  { name: "runner: guarded no-ops ignore their guard", file: "src/tables/table.ts", find: "  if (pair.guard) {\n    const impl = guards[pair.guard];", replace: "  if (pair.guard && pair.outcome !== \"noop\") {\n    const impl = guards[pair.guard];" },
  { name: "identity checks never run", file: "src/fold/evaluate.ts", find: "    if (m.on !== on) continue;", replace: "    continue;" },
  // SonarCloud gate fixes (2026-10-19)
  { name: "region-scan: any path accepted", file: "docs/tools/region-scan.py", find: "    if resolved != base_dir and not resolved.startswith(base_dir + os.sep):\n", replace: "    if False:\n" },
  { name: "region-scan: a path that only starts like the repo accepted", file: "docs/tools/region-scan.py", find: "    if resolved != base_dir and not resolved.startswith(base_dir + os.sep):\n", replace: "    if resolved != base_dir and not resolved.startswith(base_dir):\n" },
  { name: "store: throws escape the promise", file: "src/store/sqlite-store.ts", find: "    return Promise.reject(err as Error);\n", replace: "    throw err;\n" },
  // B2: factory transitions write their events (ruling 2026-10-19)
  { name: "b2: a refusal id needn't be an fx: key", file: "src/tables/factory.ts", find: "return s(actor) && FX_KEY.test(entity.id) && isObj(t)", replace: "return s(actor) && isObj(t)" },
  { name: "b2: a refusal needs no actor", file: "src/tables/factory.ts", find: "return s(actor) && FX_KEY.test(entity.id)", replace: "return FX_KEY.test(entity.id)" },
  { name: "b2: a refusal needs no journal time", file: "src/tables/factory.ts", find: " && s(payload.reason) && isIsoTime(payload.journaled_at);", replace: " && s(payload.reason);" },
  { name: "b2: anyone can invoke an override", file: "src/tables/factory.ts", find: "    if (actor !== USER && actor !== ORCHESTRATOR) return false;\n", replace: "" },
  { name: "b2: overrides have no 4-hour cap", file: "src/tables/factory.ts", find: "    return expires > invoked && expires - invoked <= OVERRIDE_MAX_MS;", replace: "    return expires > invoked;" },
  { name: "b2: anyone can expire an override", file: "src/tables/factory.ts", find: "    return (actor === USER || actor === ORCHESTRATOR || actor === MAC) && at !== undefined", replace: "    return at !== undefined" },
  { name: "b2: an override can expire before it was invoked", file: "src/tables/factory.ts", find: " && invoked !== undefined && at >= invoked;", replace: ";" },
  { name: "b2: a repeat expiry is unguarded", json: "charts/override.json", edit: (t) => { delete (t.pairs.find((p) => p.from === "expired" && p.event === "EXPIRED") as { guard?: string }).guard; } },
  { name: "b2: overdue never flagged", file: "src/tables/factory.ts", find: "        overdue: (o, { now }) =>", replace: "        overdue: () => false, _o: (o, { now }) =>" },
  { name: "b2: late expiry never flagged", file: "src/tables/factory.ts", find: "        late: (o) =>", replace: "        late: () => false, _l: (o) =>" },
  { name: "b2: malformed fx: ids accepted", file: "src/write/write-path.ts", find: "  if (cmd.eventId?.startsWith(\"fx:\") && !FX_KEY.test(cmd.eventId)) throw", replace: "  if (false) throw" },
  { name: "b2: an fx: id needn't be its transition's key", file: "src/write/write-path.ts", find: "  if (cmd.eventId !== want) throw new TypeError(", replace: "  if (false) throw new TypeError(" },
  { name: "b2: a relayed block's fx: id isn't checked", file: "src/write/dispatcher.ts", find: "    if (relay) checkCommand(cmd, this.registry);", replace: "" },
  { name: "b2: births hash the wrong name", file: "src/write/fxkey.ts", find: "cmd.kind === \"create\" ? birthName(cmd.entity.type, cmd.entity.version) :", replace: "cmd.kind === \"create\" ? birthName(cmd.entity.type) :" },
  { name: "b2: the fx: key ignores the payload", file: "src/write/fxkey.ts", find: "payload: t.payload ?? {} });", replace: "payload: {} });" },
  { name: "b2: the fx: key ignores the actor", file: "src/write/fxkey.ts", find: "actor: t.actor ?? null,", replace: "actor: null," },
  { name: "b2: tira key skips the version rule", file: "src/cli/cli.ts", find: "  if (!def.versioned && cmd.entity.version !== undefined) throw new UsageError(", replace: "  if (false) throw new UsageError(" },
  { name: "b2: tira key skips the shape check", file: "src/cli/cli.ts", find: "  checkCommand(cmd, registry);\n", replace: "" },
  { name: "b2: tira key opens the store", file: "src/cli/cli.ts", find: "    if (cmd === \"key\") return key(args, values, registry, stream, io);\n", replace: "    if (cmd === \"key\") { new SqliteEventStore({ path: db }).close(); return key(args, values, registry, stream, io); }\n" },
  { name: "b2: --now takes any time", file: "src/cli/cli.ts", find: "    if (values.now !== undefined && !isIsoTime(values.now)) throw", replace: "    if (false) throw" },
  { name: "b2: the page doesn't mark automatic rows", file: "src/render/html.ts", find: "${x.auto ? `<span class=\"auto\"", replace: "${false ? `<span class=\"auto\"" },
  { name: "scenarios: a step's event id ignored", file: "src/scenario/run.ts", find: "      const cmd = { ...plain, ...(eventId ? { eventId } : {}) } as Command;", replace: "      const cmd = plain;" },
  // B2: times (src/time.ts), strict so replay can't depend on the time zone
  { name: "times: the zone is optional", file: "src/time.ts", find: "(?:Z|([+-])(\\d{2}):(\\d{2}))$/;", replace: "(?:Z|([+-])(\\d{2}):(\\d{2}))?$/;" },
  { name: "times: Date.parse instead of by hand", file: "src/time.ts", find: "  if (typeof v !== \"string\") return undefined;\n  const m = ISO_TIME.exec(v);", replace: "  if (typeof v !== \"string\" || !/^\\d{4}-\\d{2}-\\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) return undefined;\n  if (v) return Date.parse(v);\n  const m = ISO_TIME.exec(v);" },
  { name: "times: impossible dates roll over", file: "src/time.ts", find: "  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return undefined;", replace: "" },
  { name: "times: T24:00 accepted", file: "src/time.ts", find: "if (h > 23 || mi > 59", replace: "if (h > 24 || mi > 59" },
  { name: "times: the offset's sign is flipped", file: "src/time.ts", find: "const sign = m[8] === \"-\" ? -1 : 1;", replace: "const sign = m[8] === \"-\" ? 1 : -1;" },
  { name: "times: fractions ignored", file: "src/time.ts", find: "const ms = m[7] === undefined ? 0 : Math.floor(Number(`0${m[7]}`) * 1000);", replace: "const ms = 0;" },
  { name: "times: two-digit years mapped to the 1900s", file: "src/time.ts", find: "  t.setUTCFullYear(y, mo - 1, d); // no two-digit-year mapping, unlike Date.UTC", replace: "  t.setTime(Date.UTC(y, mo - 1, d));" },
  // Blind round 1 (scored 5/10 on 2026-10-20): the five faults the suite let through,
  // planted again as written (adapted to today's code), so each stays caught.
  { name: "blind 1, fault 2: canonicalJson sorts arrays", file: "src/fold/fold.ts", find: "Array.from(v, (x) => canonical(x) ?? \"null\").join(\",\")", replace: "Array.from(v, (x) => canonical(x) ?? \"null\").sort(compareCodeUnits).join(\",\")" },
  { name: "blind 1, fault 3: entity order by locale", file: "src/fold/view.ts", find: "const byKey = (a: EntityState, b: EntityState) => compareCodeUnits(a.key, b.key);", replace: "const byKey = (a: EntityState, b: EntityState) => a.key.localeCompare(b.key);" },
  { name: "blind 1, fault 6: claimable now sorted by key", file: "src/tables/factory.ts", find: "    .sort(byBirth);", replace: "    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));" },
  { name: "blind 1, fault 7: any casing of PASS verifies", file: "src/tables/factory.ts", find: "export const verifies = (result: unknown): boolean => result === PASS;", replace: "export const verifies = (result: unknown): boolean => String(result).toUpperCase() === PASS;" },
  { name: "blind 1, fault 9: page escaping drops the quote", file: "src/render/escape.ts", find: "s.replace(/[&<>\"']/g,", replace: "s.replace(/[&<>']/g," },
  // The five representation classes, made structural (2026-10-21): one definition each, one class-level test each.
  { name: "classes: canonicalJson prints integer-like keys in numeric order (a key-sorted copy through JSON.stringify)", file: "src/fold/fold.ts", find: "return canonical(value) ?? \"undefined\";", replace: "return JSON.stringify(value, (_k, v) => (v && typeof v === \"object\" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort(compareCodeUnits).map((k) => [k, v[k]])) : v)) ?? \"undefined\";" },
  { name: "classes: the fingerprint hashes a non-canonical form", file: "src/fold/fold.ts", find: "createHash(\"sha256\").update(canonicalJson(r))", replace: "createHash(\"sha256\").update(JSON.stringify(r))" },
  { name: "classes: the escape drops the apostrophe", file: "src/render/escape.ts", find: "s.replace(/[&<>\"']/g,", replace: "s.replace(/[&<>\"]/g," },
  { name: "classes: the served pages get their own escape again, one that escapes nothing", file: "src/serve/server.ts", find: "import { esc } from \"../render/escape.ts\";", replace: "const esc = (s: string) => s;" },
  { name: "classes: birth order is name order", file: "src/fold/view.ts", find: "export const byBirth = (a: EntityState, b: EntityState): number => a.createdSeq - b.createdSeq;", replace: "export const byBirth = (a: EntityState, b: EntityState): number => compareCodeUnits(a.key, b.key);" },
  { name: "classes: the verdict is trimmed before it is read", file: "src/tables/factory.ts", find: "export const verifies = (result: unknown): boolean => result === PASS;", replace: "export const verifies = (result: unknown): boolean => typeof result === \"string\" && result.trim() === PASS;" },
  { name: "classes: handoff ties broken by locale", file: "src/fold/handoffs.ts", find: "a.since - b.since || compareCodeUnits(a.key, b.key)", replace: "a.since - b.since || a.key.localeCompare(b.key)" },
  { name: "classes: confirm links skip the escape (a raw ' in a URL-encoded id)", file: "src/render/html.ts", find: "=> esc(`/confirm?type=${encodeURIComponent(r.type)}&id=${encodeURIComponent(r.id)}&event=${event}`);", replace: "=> `/confirm?type=${encodeURIComponent(r.type)}&amp;id=${encodeURIComponent(r.id)}&amp;event=${event}`;" },
  // health sweeps (src/sweep/sweep.ts)
  { name: "sweep: anomalies not reported", file: "src/sweep/sweep.ts", find: "  for (const a of r.anomalies) add(out, \"rules\",", replace: "  for (const a of []) add(out, \"rules\"," },
  { name: "sweep: missing parents not reported", file: "src/sweep/sweep.ts", find: "      if (!parent) add(out, \"orphans\",", replace: "      if (false) add(out, \"orphans\"," },
  { name: "sweep: a parent of another type accepted", file: "src/sweep/sweep.ts", find: "      else if (parent.type !== def.type) add(out, \"orphans\",", replace: "      else if (false) add(out, \"orphans\"," },
  { name: "sweep: tasks with no tree place accepted", file: "src/sweep/sweep.ts", find: "      if (!e.tree) { add(out, \"orphans\", { key: e.key, detail: \"has no place in the tree\" }); continue; }", replace: "      if (!e.tree) continue;" },
  { name: "sweep: parent loops not reported", file: "src/sweep/sweep.ts", find: "          add(out, \"loops\", { key: loop[0] as string,", replace: "          if (false) add(out, \"loops\", { key: loop[0] as string," },
  { name: "sweep: blocked_by loops not reported", file: "src/sweep/sweep.ts", find: "          add(out, \"loops\", { key: `${def.type}:${ordered[0]}`,", replace: "          if (false) add(out, \"loops\", { key: `${def.type}:${ordered[0]}`," },
  { name: "sweep: superseded versions' blocked_by counted", file: "src/sweep/sweep.ts", find: "const current = all.filter((e) => e.version === undefined || !all.some((n) => n.id === e.id && n.version === (e.version as number) + 1));", replace: "const current = all;" },
  { name: "sweep: a child listed twice accepted", file: "src/sweep/sweep.ts", find: "        if (listed.has(c)) { add(out, \"links\", { key: p.key, detail: `lists ${c} twice` }); continue; }", replace: "        if (listed.has(c)) continue;" },
  { name: "sweep: a listed child that doesn't exist accepted", file: "src/sweep/sweep.ts", find: "        if (!child) add(out, \"links\",", replace: "        if (false) add(out, \"links\"," },
  { name: "sweep: a listed child with another parent accepted", file: "src/sweep/sweep.ts", find: "        else if (parentOf(child) !== p.key) add(out, \"links\",", replace: "        else if (false) add(out, \"links\"," },
  { name: "sweep: an unlisted child accepted", file: "src/sweep/sweep.ts", find: "      if (parent?.type === def.type && !kidsOf(parent).includes(c.key)) add(out, \"links\",", replace: "      if (false) add(out, \"links\"," },
  { name: "sweep: unreached tasks not counted", file: "src/sweep/sweep.ts", find: "    if (unreached > 0) add(out, \"counts\",", replace: "    if (false) add(out, \"counts\"," },
  { name: "sweep: tasks reached twice not counted", file: "src/sweep/sweep.ts", find: "    for (const [k, n] of reached) if (n > 1) add(out, \"counts\",", replace: "    for (const [k, n] of reached) if (n > 2) add(out, \"counts\"," },
  { name: "sweep: two tasks in progress allowed", file: "src/sweep/sweep.ts", find: "      if (active.length > 1) add(out, \"counts\",", replace: "      if (active.length > 2) add(out, \"counts\"," },
  { name: "sweep: the children cap ignored", file: "src/sweep/sweep.ts", find: "      if (n > cfg.maxChildren) add(out, \"counts\",", replace: "      if (false) add(out, \"counts\"," },
  { name: "sweep: recorded depths not compared", file: "src/sweep/sweep.ts", find: "      if (e.tree.depth !== d) add(out, \"depth\",", replace: "      if (false) add(out, \"depth\"," },
  { name: "sweep: the depth cap ignored", file: "src/sweep/sweep.ts", find: "      if (d > cfg.maxDepth) add(out, \"depth\",", replace: "      if (d > cfg.maxDepth + 1) add(out, \"depth\"," },
  { name: "sweep: closed parents with open work accepted", file: "src/sweep/sweep.ts", find: "        if (child && !closed(cfg, child)) add(out, \"closed-parents\",", replace: "        if (false) add(out, \"closed-parents\"," },
  { name: "sweep: blank definitions count as written", file: "src/sweep/sweep.ts", find: "const written = (v: unknown) => typeof v === \"string\" && v.trim().length > 0;", replace: "const written = (v: unknown) => typeof v === \"string\" && v.length > 0;" },
  { name: "sweep: any value counts as a definition", file: "src/sweep/sweep.ts", find: "const written = (v: unknown) => typeof v === \"string\" && v.trim().length > 0;", replace: "const written = (v: unknown) => v !== undefined && String(v).trim().length > 0;" },
  { name: "sweep: attention counted as broken", file: "src/sweep/sweep.ts", find: "  const count = (s: Severity) => checks.filter((c) => c.severity === s)", replace: "  const count = (s: Severity) => checks.filter((c) => s === \"broken\" || c.severity === s)" },
  { name: "sweep: a parent above the working task counts as working", file: "src/sweep/sweep.ts", find: "      const active = nodes.filter((e) => working(e) && !above.has(e.key)).map((e) => e.key);", replace: "      const active = nodes.filter((e) => working(e)).map((e) => e.key);" },
  { name: "sweep: regrowth never flagged", file: "src/sweep/sweep.ts", find: "    if (intent.kind === \"create\" && p !== undefined && was !== undefined) {", replace: "    if (false) {" },
  { name: "sweep: closes not remembered", file: "src/sweep/sweep.ts", find: "    if (ev.outcome === \"transition\" && cfg.terminal.includes(state)) closedAt.set(ev.key, { seq: e.seq, state });", replace: "" },
  { name: "sweep: a no-op close counts as a close", file: "src/sweep/sweep.ts", find: "    if (ev.outcome === \"transition\" && cfg.terminal.includes(state)) closedAt.set", replace: "    if (cfg.terminal.includes(state)) closedAt.set" },
  { name: "sweep: --at ignored", file: "src/sweep/sweep.ts", find: "{ ...(opts.upToSeq === undefined ? {} : { upToSeq: opts.upToSeq }), onApply: history }", replace: "{ onApply: history }" },
  { name: "sweep: --at cuts the log instead of the replay", file: "src/sweep/sweep.ts", find: "  const events = log.filter((e) => e.stream === stream).sort((a, b) => a.seq - b.seq);\n  const out: Findings = new Map();\n  const history = regrown(registry, out);\n  const r = fold(events, registry, { ...(opts.upToSeq === undefined ? {} : { upToSeq: opts.upToSeq }), onApply: history });", replace: "  const events = log.filter((e) => e.stream === stream && (opts.upToSeq === undefined || e.seq <= opts.upToSeq)).sort((a, b) => a.seq - b.seq);\n  const out: Findings = new Map();\n  const history = regrown(registry, out);\n  const r = fold(events, registry, { onApply: history });" },
  { name: "sweep: an idea-born task ignores its idea", file: "src/sweep/sweep.ts", find: "    const idea = typeof own.idea_id === \"string\" ? birthOf(byKey.get(`idea:${own.idea_id}`)) : {};", replace: "    const idea: Record<string, unknown> = {};" },
  { name: "sweep: loops spelled from where they were entered", file: "src/sweep/sweep.ts", find: "  const start = loop.indexOf([...loop].sort(compareCodeUnits)[0] as string);\n  return [...loop.slice(start), ...loop.slice(0, start)];", replace: "  return loop;" },
  { name: "sweep: the root walk re-walks shared children", file: "src/sweep/sweep.ts", find: "      if (n > 1) continue;\n", replace: "" },
  { name: "sweep: another type in a child list reads as a root", file: "src/sweep/sweep.ts", find: "        else if (child.type !== def.type) add(out, \"links\", { key: p.key, detail: `lists ${c}, which isn't a ${def.type}` });\n", replace: "" },
  { name: "scenarios: a misspelt sweep check passes", file: "src/scenario/run.ts", find: "    if (!CHECKS.some((c) => c.id === id)) {", replace: "    if (false) {" },
  { name: "fold: onApply never called", file: "src/fold/fold.ts", find: "    opts.onApply?.(e, intent, ev, view);\n    idsOf(appliedIds, e.stream).set(e.eventId, e);", replace: "    idsOf(appliedIds, e.stream).set(e.eventId, e);" },
  { name: "scenarios: the sweep isn't checked", file: "src/scenario/run.ts", find: "  if (health.broken !== (x.sweep?.broken ?? 0)) {", replace: "  if (false) {" },
  { name: "cli: tira sweep always exits 0", file: "src/cli/cli.ts", find: "  return r.broken > 0 ? 3 : 0;", replace: "  return 0;" },
  // A reason to block a task (Isha's call, 2026-10-20)
  { name: "block reason: unstarted tasks block without one", json: "charts/node-lifecycle.json", edit: (t) => { delete (t.pairs.find((p) => p.from === "unstarted" && p.event === "BLOCK") as { guard?: string }).guard; } },
  { name: "block reason: in-progress tasks block without one", json: "charts/node-lifecycle.json", edit: (t) => { delete (t.pairs.find((p) => p.from === "in_progress" && p.event === "BLOCK") as { guard?: string }).guard; } },
  // The page, live: tira serve, needs attention, the palette (D1 UI brief, 2026-10-20)
  { name: "serve: any Host answers", file: "src/serve/server.ts", find: "    if (!LOCAL_HOST.test(host)) return send(res, 403,", replace: "    if (false) return send(res, 403," },
  { name: "serve: cross-origin writes accepted", file: "src/serve/server.ts", find: "    if (origin !== undefined && origin !== `http://${host}`) { send(res, 403,", replace: "    if (false) { send(res, 403," },
  { name: "serve: writes need no token", file: "src/serve/server.ts", find: "    if (!safeEqual(form.get(\"token\") ?? \"\", token)) { send(res, 403, text,", replace: "    if (false) { send(res, 403, text," },
  { name: "serve: any entity type accepted", file: "src/serve/server.ts", find: "  if (!verb || !verbFits(verb, type, (t) => registry.get(t)?.tree !== undefined) || id === \"\") return undefined;", replace: "  if (!verb || id === \"\") return undefined;" },
  { name: "serve: a posted actor is honoured", file: "src/serve/server.ts", find: "const cmd = commandOf(ask, opts.stream, opts.actor);", replace: "const cmd = commandOf(ask, opts.stream, form.get(\"actor\") ?? opts.actor);" },
  { name: "serve: inline scripts allowed", file: "src/serve/server.ts", find: "script-src 'self';", replace: "script-src 'self' 'unsafe-inline';" },
  { name: "serve: Origin null on the page's own posts", file: "src/serve/server.ts", find: "\"Referrer-Policy\": \"same-origin\"", replace: "\"Referrer-Policy\": \"no-referrer\"" },
  { name: "serve: the dry run ignores fields still to fill", file: "src/serve/server.ts", find: "payload: verb.field ? { [verb.field.name]: \"(you fill this in)\" } : {} })", replace: "payload: {} })" },
  { name: "serve: confirm form without the token", file: "src/serve/server.ts", find: "const hidden = [[\"token\", opts.token], ", replace: "const hidden = [" },
  { name: "brief: the blocked reason not shown", file: "src/serve/server.ts", find: "since: since ? { seq: since.seq, reason: since.reason } : undefined,", replace: "since: since ? { seq: since.seq } : undefined," },
  { name: "page: live parts in the rendered file", file: "src/render/html.ts", find: "  const live = opts.live !== undefined;", replace: "  const live = true;" },
  { name: "page: attention ignores the reason", file: "src/render/html.ts", find: "    const why = whyLabel(blocked.get(n.row.key)?.reason);", replace: "    const why = \"blocked\";" },
  { name: "page: attention dates a block by its last no-op", file: "src/render/html.ts", find: "  if (ev === \"block\" && !blocked.has(key)) blocked.set(key,", replace: "  if (ev === \"block\") blocked.set(key," },
  { name: "page: attention rows carry data-key", file: "src/render/html.ts", find: "`<li class=\"att-row\" data-attention-key=\"${esc(n.row.key)}\"", replace: "`<li class=\"att-row\" data-key=\"${esc(n.row.key)}\"" },
  { name: "page: attention shows parents in progress", file: "src/render/html.ts", find: "  const busy = nodes.filter((n) => n.row.active && !n.row.awaitingClose);", replace: "  const busy = nodes.filter((n) => n.row.state === \"in_progress\" && !n.row.awaitingClose);" },
  { name: "page: the theme switch starts on Dark", file: "src/render/html.ts", find: "id=\"th-${t}\"${t === \"system\" ? \" checked\" : \"\"}", replace: "id=\"th-${t}\"${t === \"dark\" ? \" checked\" : \"\"}" },
  { name: "page: a picked Light doesn't beat a dark system", file: "src/render/html.ts", find: ":root:has(#th-light:checked){color-scheme:light;${LIGHT}}", replace: ":root:has(#th-light:checked){color-scheme:light}" },
  { name: "page: a picked Dark prints dark", file: "src/render/html.ts", find: "@media screen{:root:has(#th-dark:checked)", replace: "@media all{:root:has(#th-dark:checked)" },
  { name: "serve: the confirm page forgets the theme", file: "src/serve/server.ts", find: "<script type=\"module\" src=\"/theme.mjs\"></script></body>", replace: "</body>" },
  { name: "serve: the page forgets the theme", file: "src/serve/app.mjs", find: "import \"./theme.mjs\";\n", replace: "" },
  { name: "page: the guide gets a fourth paragraph", file: "src/render/html.ts", find: "<p><b>The hash.</b>", replace: "<p>More.</p><p><b>The hash.</b>" },
  { name: "palette: initials don't match", file: "src/serve/rank.mjs", find: "  if (ws.map((w) => w[0]).join(\"\").startsWith(q)) return 800 - ws.length;", replace: "" },
  { name: "palette: a verb doesn't filter by state", file: "src/serve/rank.mjs", find: "    if (verb && !(VERBS_BY_STATE[task.state] ?? []).includes(verb)) return;", replace: "" },
  { name: "palette: ties lose tree order", file: "src/serve/rank.mjs", find: "  scored.sort((a, b) => b.s - a.s || a.order - b.order);", replace: "  scored.sort((a, b) => b.s - a.s || b.order - a.order);" },
  { name: "palette: a verb needs a task word after it", file: "src/serve/rank.mjs", find: "  return verb ? { verb, q: s.slice(cut).trim() } : { verb: undefined, q: query.trim() };", replace: "  return verb && s.slice(cut).trim() ? { verb, q: s.slice(cut).trim() } : { verb: undefined, q: query.trim() };" },
  { name: "brief: tira's closes not announced", file: "src/serve/brief.ts", find: "  if (pv.ok && pv.closes.length > 0) s += ", replace: "  if (false) s += " },
  { name: "serve: the packet judges without tira's closes", file: "src/write/write-path.ts", find: "    return this.decide(intent, await this.store.readStream(cmd.stream), false, \"preview\").verdict;", replace: "    return this.decide(intent, await this.store.readStream(cmd.stream), true, \"preview\").verdict;" },
  { name: "serve: a moved log is written anyway", file: "src/serve/server.ts", find: "    if (a.seen !== String((await now()).r.lastSeq)) {", replace: "    if (false) {" },
  { name: "serve: the confirm form forgets what it saw", file: "src/serve/server.ts", find: ", [\"seen\", String(p.seen)]]", replace: "]" },
  { name: "serve: reserved actors can serve", file: "src/serve/server.ts", find: "  if (isReservedActor(opts.actor)) throw new Error(", replace: "  if (false) throw new Error(" },
  { name: "serve: a result shows on every reload", file: "src/serve/server.ts", find: "    flashes.delete(rk); // a result shows once", replace: "" },
  { name: "serve: the body cap is lifted", file: "src/serve/server.ts", find: "const MAX_BODY = 16 * 1024;", replace: "const MAX_BODY = 1024 * 1024;" },
  { name: "page: refused blocks start a stretch", file: "src/render/html.ts", find: "    if (e.stream !== stream || e.type === REJECTED || skip.has(e.seq)) continue;", replace: "    if (e.stream !== stream || e.type === REJECTED) continue;" },
  { name: "palette: separators must match exactly", file: "src/serve/rank.mjs", find: String.raw`const norm = (s) => s.toLowerCase().replace(/[\s_.\-/›]+/g, " ").trim();`, replace: "const norm = (s) => s.toLowerCase();" },
  // Versioned rules and the reason check (rulings 2026-10-20)
  { name: "eras: replay judges every event by today's rules", file: "src/fold/fold.ts", find: "{ pairedClose: paired !== undefined, era });", replace: "{ pairedClose: paired !== undefined, era: registry.era });" },
  { name: "eras: new writes aren't stamped", file: "src/write/write-path.ts", find: "metadata: { ...x.metadata, era: this.registry.era }", replace: "metadata: { ...x.metadata }" },
  { name: "eras: the legacy era runs today's task table", file: "src/tables/registry.ts", find: "      eras: { [LEGACY_ERA]: { lifecycle: chart(\"eras/node-lifecycle.era1.json\") } },\n", replace: "" },
  { name: "eras: an unknown era replays anyway", file: "src/fold/fold.ts", find: "Number.isInteger(era) && (era as number) >= LEGACY_ERA && (era as number) <= registry.era;", replace: "true;" },
  { name: "eras: a future era is accepted", file: "src/fold/fold.ts", find: "(era as number) <= registry.era;", replace: "(era as number) <= registry.era + 1;" },
  { name: "eras: an earlier era may change the shape", file: "src/tables/registry.ts", find: "if (table.initial !== now.initial || !same(table.states, now.states) || !same(table.events, now.events)) {", replace: "if (false) {" },
  { name: "reason check: only spaces counts as a reason", file: "src/tables/table.ts", find: "hasReasonText: ({ payload }) => typeof payload.reason === \"string\" && payload.reason.trim().length > 0,", replace: "hasReasonText: ({ payload }) => typeof payload.reason === \"string\" && payload.reason.length > 0," },
  { name: "page: a finished active parent needs you", file: "src/render/html.ts", find: "const busy = nodes.filter((n) => n.row.active && !n.row.awaitingClose);", replace: "const busy = nodes.filter((n) => n.row.active);" },
  { name: "page: legacy events unlabelled", file: "src/render/html.ts", find: "legacy: e.metadata.era === undefined, key: `${type}:${d.entity.id}`", replace: "legacy: false, key: `${type}:${d.entity.id}`" },
  { name: "command: a value of only spaces gets through", file: "src/serve/command.ts", find: "if (typeof v === \"string\" && v.trim() !== \"\") return undefined;", replace: "if (typeof v === \"string\" && v !== \"\") return undefined;" },
  // B3 round 1, published: the scorer and the generator
  { name: "b3 score: any non-OK verdict counts as caught", file: "scripts/b3-score.ts", find: "if (m.verdict !== \"OK\" && got === m.verdict) caught++;", replace: "if (m.verdict !== \"OK\" && got !== \"OK\") caught++;" },
  { name: "b3 score: false positives not counted", file: "scripts/b3-score.ts", find: "    if (m.verdict === \"OK\" && got !== \"OK\") falsePositives++;\n", replace: "" },
  { name: "b3 build: the retried dispatch journaled once", file: "scripts/b3-fixture.ts", find: "return [record, { ...record, ts: ts() }]; // journaled twice", replace: "return [record]; // journaled twice" },
  { name: "cli paths: anything outside the run folder is allowed", file: "scripts/cli-path.ts", find: "if (resolved !== baseDir && !resolved.startsWith(baseDir + sep)) {", replace: "if (false) {" },
  { name: "cli paths: a sibling folder that starts the same passes", file: "scripts/cli-path.ts", find: "!resolved.startsWith(baseDir + sep)", replace: "!resolved.startsWith(baseDir)" },
  // Task dialogs (Isha, 2026-10-21): a task opens over the page, never a side panel or a new page
  { name: "dialog: no click-outside to close", file: "src/render/html.ts", find: "aria-label=\"${esc(r.id)}\" role=\"dialog\" aria-modal=\"true\">${SCRIM}<div", replace: "aria-label=\"${esc(r.id)}\" role=\"dialog\" aria-modal=\"true\"><div" },
  { name: "dialog: not marked as a modal dialog", file: "src/render/html.ts", find: "aria-label=\"${esc(r.id)}\" role=\"dialog\" aria-modal=\"true\">", replace: "aria-label=\"${esc(r.id)}\">" },
  { name: "dialog: the page behind scrolls", file: "src/render/html.ts", find: "body:has(.drawer:target){overflow:hidden}\n", replace: "" },
  { name: "dialog: slides in from the side", file: "src/render/html.ts", find: ".drawer{position:fixed;inset:0;z-index:10;display:grid;place-items:center;", replace: ".drawer{position:fixed;top:0;right:0;bottom:0;z-index:10;display:block;" },
  { name: "live: Esc doesn't close a dialog", file: "src/serve/app.mjs", find: "{ location.hash = \"_\"; e.preventDefault(); }", replace: "{ e.preventDefault(); }" },
  { name: "live: the palette's Esc also closes the dialog behind it", file: "src/serve/app.mjs", find: "e.key === \"Escape\" && !e.defaultPrevented && root.hidden", replace: "e.key === \"Escape\" && root.hidden" },
  // The task flow on the page (Isha, 2026-10-21): confirm as a dialog, hints, suggestions, new verbs, subtasks, proof
  { name: "confirm: the dialog fetches the whole page", file: "src/serve/app.mjs", find: "fetch(`${href}&fragment=1`,", replace: "fetch(href," },
  { name: "confirm: no fallback when the packet can't load", file: "src/serve/app.mjs", find: "  } catch {\n    location.href = href;\n  }", replace: "  } catch {\n  }" },
  { name: "confirm: action links leave the page", file: "src/serve/app.mjs", find: "  e.preventDefault();\n  void openConfirm(link.getAttribute(\"href\"));", replace: "  void openConfirm(link.getAttribute(\"href\"));" },
  { name: "confirm: the palette's verbs leave the page", file: "src/serve/app.mjs", find: "if (verb) void openConfirm(", replace: "if (verb) location.assign(" },
  { name: "confirm: the fragment comes wrapped in a page", file: "src/serve/server.ts", find: "fragment ? packetBody(p, co, true) : confirmPage(p, co)", replace: "confirmPage(p, co)" },
  { name: "hints: never shown", file: "src/serve/server.ts", find: "const hint = p.hint ? `<p class=\"hint\"", replace: "const hint = false ? `<p class=\"hint\"" },
  { name: "hints: one-active names the task itself", file: "src/serve/server.ts", find: "Complete or block ${others.join(\", \")} first", replace: "Complete or block ${id} first" },
  { name: "suggestions: none offered", file: "src/serve/server.ts", find: "return [...used.slice(0, 8), ...waiting.filter((w) => !used.includes(w)).slice(0, 8)];", replace: "return [];" },
  { name: "suggestions: a task waits on itself", file: "src/serve/server.ts", find: "x.id !== id && ", replace: "" },
  { name: "suggestions: done tasks are waited on", file: "src/serve/server.ts", find: "!above.has(x.id) && !CLOSED.has(x.state)", replace: "!above.has(x.id)" },
  { name: "suggestions: a task waits on its own parent", file: "src/serve/server.ts", find: "x.id !== id && !above.has(x.id) &&", replace: "x.id !== id &&" },
  { name: "add subtask: a blank name accepted", file: "src/serve/command.ts", find: "return name.length > 0 && name.length <= 80", replace: "return name.length <= 80" },
  { name: "command: any key accepted", file: "src/serve/command.ts", find: "    if (!allowed.includes(key)) return", replace: "    if (false) return" },
  { name: "command: a key given twice keeps the last", file: "src/serve/command.ts", find: "    if (key in out) return", replace: "    if (false) return" },
  { name: "command: an escaped quote is lost", file: "src/serve/command.ts", find: String.raw`dq.replaceAll(/\\(.)/g, "$1")`, replace: "dq" },
  { name: "command: an unclosed quote is run", file: "src/serve/command.ts", find: "  if (text.replaceAll(WORD, \"\").trim() !== \"\") return { why: \"a quote is never closed\" };\n", replace: "" },
  { name: "command: found work under another task", file: "src/serve/command.ts", find: "(kv.kind !== \"discovered\" || kv.discovered_during !== parent)", replace: "kv.kind !== \"discovered\"" },
  { name: "command: a missing proof isn't caught", file: "src/serve/command.ts", find: "  if (!field || PAGE_VERBS[a.event]?.creates) return undefined;", replace: "  return undefined;" },
  { name: "command: the value to fill isn't offered", file: "src/serve/command.ts", find: "const toFill = verb?.field ? \" \" + pair(verb.field.name, value) : \"\";", replace: "const toFill = \"\";" },
  { name: "act: an edited action runs without its preview", file: "src/serve/server.ts", find: "if (target.type !== opened.type || target.id !== opened.id || target.event !== opened.event) {", replace: "if (false) {" },
  { name: "act: a typed refusal is written to the log", file: "src/serve/server.ts", find: "      if (pv.ok) continue;\n", replace: "      continue;\n" },
  { name: "brief: tira's close promised for a blocked parent", file: "src/serve/brief.ts", find: "  if (p.closable) return", replace: "  if (true) return" },
  { name: "brief: every start looks like the next task", file: "src/serve/brief.ts", find: "  if (f.next === f.id) return", replace: "  if (true) return" },
  { name: "brief: the wait looks over whatever it waited on", file: "src/serve/brief.ts", find: "  if (w && CLOSED.has(w.state)) return", replace: "  if (w) return" },
  { name: "brief: open subtasks not mentioned on unblock", file: "src/serve/brief.ts", find: "  const then = open.length > 0 ?", replace: "  const then = false ?" },
  { name: "command: a ticket and a block that don't belong together run", file: "src/serve/command.ts", find: " || blockerOf(b) !== t.child) return no(pairNote);", replace: ") return no(pairNote);" },
  { name: "command: a task blocked by itself", file: "src/serve/command.ts", find: "  if (blocker?.trim() === id.trim()) return no(", replace: "  if (false) return no(" },
  { name: "command: a block on a ticket still asks for a reason", file: "src/serve/command.ts", find: "  if (a.event === \"BLOCK\" && blockerOf(a) !== undefined) return undefined;\n", replace: "" },
  { name: "command: no reason defaults from the ticket", file: "src/serve/command.ts", find: "reason: `waiting on ${blocker}` } };", replace: "reason: \"\" } };" },
  { name: "command: a block opens without a ticket", file: "src/serve/command.ts", find: "  if (event === \"BLOCK\") return commandFor(type, id, \"ADD_SUBTASK\", true)", replace: "  if (false) return commandFor(type, id, \"ADD_SUBTASK\", true)" },
  { name: "act: a block waits on a task that isn't there", file: "src/serve/server.ts", find: "  if (!target) return `there is no task", replace: "  if (false) return `there is no task" },
  { name: "act: a block waits on a closed task", file: "src/serve/server.ts", find: "  if (CLOSED.has(target.state)) return `${blocker} is already", replace: "  if (false) return `${blocker} is already" },
  { name: "act: a block waits on a task it sits under", file: "src/serve/server.ts", find: "    if (up?.key === target.key) return", replace: "    if (false) return" },
  { name: "act: a new ticket isn't checked before it's written", file: "src/serve/server.ts", find: "for (const c of first === undefined ? [cmd] : [first, cmd]) {", replace: "for (const c of [cmd]) {" },
  { name: "act: the block is written without its ticket", file: "src/serve/server.ts", find: "    if (!done.ok) return { ok: false, text: said.join(\" \") };\n", replace: "" },
  { name: "links: a block forgets its ticket", file: "src/render/html.ts", find: "...(typeof reason === \"string\" ? { reason } : {}), ...blocker });", replace: "...(typeof reason === \"string\" ? { reason } : {}) });" },
  { name: "links: blocked-by not shown", file: "src/render/html.ts", find: "    blockedBy.set(key, since.blocker);\n", replace: "" },
  { name: "links: what a ticket blocks not shown", file: "src/render/html.ts", find: "    blocks.set(since.blocker, [...(blocks.get(since.blocker) ?? []), key]);\n", replace: "" },
  { name: "links: never ready to unblock", file: "src/render/html.ts", find: "const ready = blocker !== undefined && CLOSED.has(blocker.state) ?", replace: "const ready = false ?" },
  { name: "links: the blocks line looks like any line", file: "src/render/html.ts", find: "    const blocking = links.blockedBy.get(p.row.key) === n.row.key;", replace: "    const blocking = false;" },
  { name: "links: no arc to a blocker elsewhere", file: "src/render/html.ts", find: "${found.join(\"\")}${blockArcs.join(\"\")}${ideaLines.join(\"\")}</svg>", replace: "${found.join(\"\")}${ideaLines.join(\"\")}</svg>" },
  { name: "brief: the blocker ticket's state ignored", file: "src/serve/server.ts", find: "  const ticket = state === \"blocked\" ? since?.blocker : undefined;", replace: "  const ticket = undefined;" },
  { name: "brief: a refusal recommended anyway", file: "src/serve/brief.ts", find: "  if (!pv.ok) return `Don't run it:", replace: "  if (false) return `Don't run it:" },
  { name: "add subtask: the discovered box ignored", file: "src/serve/server.ts", find: "form.get(\"discovered\") === \"1\" ? { kind: \"discovered\", discovered_during: id } : {}", replace: "{}" },
  { name: "dialog: no subtasks list", file: "src/render/html.ts", find: "<ul class=\"kids-list\" aria-label=\"Subtasks\">${kidsList}</ul>", replace: "" },
  { name: "dialog: a re-open keeps the old proof", file: "src/render/html.ts", find: "    if (ev === \"reopen\") proofs.delete(key);\n", replace: "" },
  { name: "dialog: actions in the rendered file", file: "src/render/html.ts", find: "const verbs = ctx.live ? DIALOG_ACTIONS[r.state] ?? [] : [];", replace: "const verbs = DIALOG_ACTIONS[r.state] ?? [];" },
  { name: "dialog: a done task can't be reopened from it", file: "src/render/html.ts", find: "  done: [[\"REOPEN\", \"Reopen\"]],", replace: "  done: []," },
  { name: "lanes: an empty Lanes tab shows", file: "src/render/html.ts", find: "const views = VIEWS.filter(([t]) => t !== \"lanes\" || lanes !== \"\");", replace: "const views = VIEWS;" },
  { name: "history: still called Activity", file: "src/render/html.ts", find: "[\"log\", \"History\"]", replace: "[\"log\", \"Activity\"]" },
  // KAN-8 label channel (2026-10-21): the enforcement the labels suite exists to hold —
  // planted when the coverage hole was found (the suite did not run here, and nothing
  // targeted the label source, so each of these survived by construction).
  { name: "labels: the approver may label its own approval", file: "src/fold/labels.ts", find: "oracleName(intent.actor) === skeleton(approver)", replace: "oracleName(intent.actor) !== skeleton(approver)" },
  { name: "labels: dangling evidence resolves", file: "src/fold/labels.ts", find: "|| !log.seen(ev)) return", replace: "|| log.seen(ev)) return" },
  { name: "labels: the judged event need not be an approval", file: "src/fold/labels.ts", find: "approval.type !== APPROVAL", replace: "approval.type === APPROVAL" },
  { name: "labels: a label may judge another brief's approval", file: "src/fold/labels.ts", find: "if (judged !== p.brief)", replace: "if (judged === p.brief)" },
  { name: "labels: a confirmed-good label marks the approval bad", file: "src/fold/labels.ts", find: "if (verdict === \"found-bad\") a.verdict = \"found-bad\";", replace: "if (verdict === \"confirmed-good\") a.verdict = \"found-bad\";" },
  { name: "labels: anyone may write a label", file: "src/tables/factory.ts", find: "isOracle(actor) && s(payload.brief)", replace: "true && s(payload.brief)" },
  { name: "labels: an oracle may write non-label events at the write path", file: "src/write/write-path.ts", find: "if (!internal && isOracle(intent.actor) && !isLabelBirth(intent)) {", replace: "if (!internal && isOracle(intent.actor) && isLabelBirth(intent)) {" },
  { name: "labels: an oracle may write non-label events in the fold", file: "src/fold/fold.ts", find: "if (isOracle(intent.actor) && !isLabelBirth(intent)) {", replace: "if (isOracle(intent.actor) && isLabelBirth(intent)) {" },
  { name: "labels: a refused self-label still appends a rejection", file: "src/write/write-path.ts", find: "batch: [] as NewEvent[],", replace: "batch: [toRejectedEvent(intent, \"bad-label\", problem.detail, moveId)]," },
  // Ideas to tickets (D5, the vapor catch): tira's two writes, where it puts an idea, the agent's
  // command, the approvals' guards and plain refusals, and the idea on the board
  { name: "ideas: tira never drafts the file", file: "src/fold/handoffs.ts", find: "if (born && said && i.regions.lifecycle === \"declared\") on(\"V1\", i, \"DRAFT_FILE\", { ...said }, born);", replace: "" },
  { name: "ideas: tira drafts a file for an idea that said nothing", file: "src/fold/handoffs.ts", find: "if (born && said && i.regions.lifecycle === \"declared\")", replace: "if (born && i.regions.lifecycle === \"declared\")" },
  { name: "ideas: tira never proposes the parent", file: "src/fold/handoffs.ts", find: "if (approved && file) on(\"V2\"", replace: "if (false) on(\"V2\"" },
  { name: "ideas/placement: the declared parent wins over a text that disagrees", file: "src/fold/ideas.ts", find: "return { candidates: [named, ...usable], basis: `needs you: it was declared under ${named}, but its text names ${list(usable)}` };", replace: "return { parent: named, candidates: [named], basis: `declared under ${named}` };" },
  { name: "ideas/placement: a declared parent that can't take it is proposed", file: "src/fold/ideas.ts", find: "if (problem !== undefined) return { candidates: usable, basis:", replace: "if (false) return { candidates: usable, basis:" },
  { name: "ideas/placement: a closed task the text names is proposed", file: "src/fold/ideas.ts", find: "const usable = hits.filter((h) => parentProblem(view, registry, h) === undefined);", replace: "const usable = hits;" },
  { name: "ideas/placement: a task and the one under it both count", file: "src/fold/ideas.ts", find: "return hits.filter((h) => !hits.some((o) => o !== h && above(h, o))).map((h) => h.id).sort(compareCodeUnits);", replace: "return hits.map((h) => h.id).sort(compareCodeUnits);" },
  { name: "ideas/placement: one-letter and filler task names match", file: "src/fold/ideas.ts", find: "    if (name.trim().length < 3 || FILLER.has(name.trim())) return false;\n", replace: "" },
  { name: "ideas/placement: a name inside a longer word matches", file: "src/fold/ideas.ts", find: "return t.includes(name) || t.includes(`${name.trimEnd()}s `);", replace: "return t.includes(name.trim());" },
  { name: "ideas/placement: the why outranks the summary", file: "src/fold/ideas.ts", find: "const hits = summaryHits.length > 0 || file.why === undefined ? summaryHits : mentioned(view, file.why);", replace: "const hits = file.why === undefined ? summaryHits : mentioned(view, file.why);" },
  { name: "ideas: an idea's id may be a task's", file: "src/fold/ideas.ts", find: "const free = (id: string) => !view.get({ type: IDEA, id }) && !view.get({ type: TASK, id });", replace: "const free = (id: string) => !view.get({ type: IDEA, id });" },
  { name: "ideas/cli: an idea without a why is pushed", file: "src/cli/cli.ts", find: "  if (why === \"\") throw new UsageError(", replace: "  if (false) throw new UsageError(" },
  { name: "ideas/serve: an idea's parent isn't checked before the placement is approved", file: "src/serve/server.ts", find: "    return placeProblem(viewOf((await now()).r, opts.stream), opts.registry, a.ask.id, parent.trim());", replace: "    return undefined;" },
  { name: "ideas/serve: a stage skip is refused in the rules' words only", file: "src/serve/server.ts", find: "  if (refusal) verdict = `tira would refuse this: ${refusal.why}", replace: "  if (false) verdict = `tira would refuse this: ${refusal.why}" },
  { name: "ideas/refusal: placing before the file reads as 'already approved'", file: "src/serve/brief.ts", find: "if (stage === \"declared\" || stage === \"file_pending\") return {", replace: "if (stage === \"declared\") return {" },
  { name: "ideas/command: an idea's verbs taken on a task", file: "src/serve/command.ts", find: "(verb.on === undefined ? isTreeType(type) : type === verb.on)", replace: "(isTreeType(type) || type === verb.on)" },
  { name: "ideas/brief: the placement's candidates not offered", file: "src/serve/server.ts", find: "{ parents: (idea.proposal?.candidates ?? []).filter((c) => c !== parent) }", replace: "{ parents: [] }" },
  { name: "ideas/render: a placed ghost floats on the top row", file: "src/render/html.ts", find: "...(p !== undefined && onTree.has(p) ? { parent: p } : {})", replace: "...{}" },
  { name: "ideas/render: dropped and born ideas stay on the board", file: "src/render/html.ts", find: "ideaRows(r, events, stream).filter((i) => OPEN_STAGES.has(i.stage))", replace: "ideaRows(r, events, stream)" },
  { name: "ideas/render: a ghost isn't marked as an idea", file: "src/render/html.ts", find: "    + `<span class=\"tag\">idea</span><span class=\"gt\">", replace: "    + `<span class=\"gt\">" },
  { name: "ideas/render: no Ideas column", file: "src/render/html.ts", find: "  return `<div class=\"cols\">${ideasColumn(ghosts, trail)}${cols}</div>`;", replace: "  return `<div class=\"cols\">${cols}</div>`;" },
  { name: "ideas/render: an idea's approvals in the rendered file", file: "src/render/html.ts", find: "const verbs = live ? IDEA_ACTIONS[i.stage] ?? [] : [];", replace: "const verbs = IDEA_ACTIONS[i.stage] ?? [];" },
];
// Equivalent, so not listed: dropping the chunks of an oversized body (server.ts readBody)
// only saves memory; the 413 is the same either way.
// Known gap, deliberately not listed: BEGIN IMMEDIATE -> BEGIN in sqlite-store.ts
// cannot be observed from a single in-process connection.
// Equivalent, so not listed: dropping the "done" check on a task dialog's proof of work
// (html.ts drawerHtml). A task leaves done only by a re-open, and a re-open already clears
// its proof (proofsOf), so only done tasks ever have one.
// Equivalent since 2026-10-18, so not listed: the cursor skipping closed branches
// (tree.ts `isTerminal` in cursor's walk). The closing gate, the re-open order and
// ADD_CHILD being denied on done/cancelled mean no open task can sit under a closed
// node, so the skip is only a speed-up — no log can tell the two apart.

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "tira-mutant-"));
  for (const p of ["src", "test", "charts", "scenarios", "scripts", "docs", "tira-docs", "fixtures", "package.json", "tsconfig.json", "README.md"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

const SUITES = ["store", "runner", "registry", "write-path", "fold", "stack", "cli", "tree", "machine", "render", "factory", "scenarios", "region-scan", "sweep", "serve", "docs", "eras", "fixture-b3", "divergence", "layout", "decision", "labels", "ideas"];
// a planted bug can make a test loop forever: a test file that doesn't finish in a minute failed
const SUITE_TIMEOUT = 60_000;
const CATCHERS = join(ROOT, ".mutant-catchers.json");
const running = new Set<number>();

interface Run { passed: boolean; failed?: string | undefined }
interface Catcher { suite: string; test?: string | undefined }

// One test file (or just the test named `only` in it) in its own process group, so a
// timeout takes down the file's test process too. A failure names its first failing test.
function runSuite(dir: string, suite: string, only?: string): Promise<Run> {
  return new Promise((resolve) => {
    const pick = only === undefined ? [] : [`--test-name-pattern=${namePattern(only)}`];
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...pick, `test/${suite}.test.ts`], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    const pid = child.pid;
    if (pid !== undefined) running.add(pid);
    const timer = setTimeout(() => killGroup(pid), SUITE_TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pid !== undefined) running.delete(pid);
      resolve(code === 0 ? { passed: true } : { passed: false, failed: failedTest(out) });
    });
  });
}

function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const pid of running) killGroup(pid);
    process.exit(130);
  });
}

// Up to `jobs` workers take the next item until none is left.
async function pool<T>(items: readonly T[], jobs: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async (): Promise<void> => {
    const i = next++;
    if (i >= items.length) return;
    await work(items[i] as T);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

// Optional filter: node scripts/mutants.ts <substring of a name> runs only the matching ones.
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
const selected = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS;

// The match check: a refactor that moved an anchor fails here in seconds, not after a
// 40-minute run. Every problem is listed at once, so one fix round covers them all.
const readRepo = (path: string) => {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return undefined;
  }
};
const problems = anchorProblems(selected, readRepo);
for (const p of problems) console.log(`BROKEN   ${p}`);
if (problems.length > 0) {
  console.error(`\nmatch check: ${problems.length} of ${selected.length} planted bugs would plant nothing — fix their anchors first`);
  process.exit(1);
}
if (args.includes("--check")) {
  console.log(`match check: every one of ${selected.length} planted bugs lands exactly once`);
  process.exit(0);
}

const jobs = Math.max(1, Number(process.env.MUTANT_JOBS) || availableParallelism());
const t0 = performance.now();

// Baseline: every test file passes alone on an unmutated copy, timed for the ordering.
const cost: Record<string, number> = {};
const base = scratchCopy();
const failing: string[] = [];
await pool(SUITES, jobs, async (suite) => {
  const t = performance.now();
  if (!(await runSuite(base, suite)).passed) failing.push(suite);
  cost[suite] = performance.now() - t;
});
rmSync(base, { recursive: true, force: true });
if (failing.length > 0) {
  console.error(`baseline fails on an unmutated copy (${failing.join(", ")}) — fix that first`);
  process.exit(2);
}

const texts = new Map<string, string | undefined>();
const readCached = (path: string) => {
  if (!texts.has(path)) texts.set(path, readRepo(path));
  return texts.get(path);
};
const memo = new Map<string, string[]>();
// What caught each bug last time; a missing, unreadable or odd entry only means a slower run.
const catchers: Record<string, Catcher> = {};
try {
  const saved: unknown = existsSync(CATCHERS) ? JSON.parse(readFileSync(CATCHERS, "utf8")) : {};
  for (const [name, c] of Object.entries(saved as Record<string, Partial<Catcher>>)) {
    if (typeof c?.suite === "string" && SUITES.includes(c.suite)) catchers[name] = typeof c.test === "string" ? { suite: c.suite, test: c.test } : { suite: c.suite };
  }
} catch {
  // start from nothing
}
let survived = 0;
let broken = 0;
const how = { test: 0, file: 0, later: 0 };

type Caught = Catcher & { how: keyof typeof how; note: string };

// Plants the bug in the scratch copy: the files it changed, or undefined when it can't land.
function plant(dir: string, m: Mutant): string[] | undefined {
  if ("json" in m) {
    const path = join(dir, m.json);
    const t = JSON.parse(readFileSync(path, "utf8"));
    m.edit(t);
    writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
    return [m.json];
  }
  const path = join(dir, m.file);
  const src = readFileSync(path, "utf8");
  const hits = src.split(m.find).length - 1;
  if (hits !== 1) {
    console.log(`BROKEN   ${m.name}: pattern matched ${hits} times (must be exactly 1)`);
    return undefined;
  }
  writeFileSync(path, src.replace(m.find, m.replace));
  if (!m.reextract) return [m.file];
  spawnSync(process.execPath, ["charts/extract-tables.mjs"], { cwd: dir });
  return [m.file, m.file.replace(/\.[^.]+$/, ".json")];
}

// The first whole test file in `order` that fails, from position i on.
async function firstFailing(dir: string, order: readonly string[], i = 0): Promise<Caught | undefined> {
  const suite = order[i];
  if (suite === undefined) return undefined;
  const r = await runSuite(dir, suite);
  if (r.passed) return firstFailing(dir, order, i + 1);
  return { suite, test: r.failed, how: i === 0 ? "file" : "later", note: `file ${i + 1} of ${order.length}` };
}

// Last time's test first, then whole files: what caught the bug, or undefined if nothing did.
async function hunt(dir: string, m: Mutant, target: readonly string[]): Promise<Caught | undefined> {
  const known = catchers[m.name];
  if (known?.test !== undefined) {
    const r = await runSuite(dir, known.suite, known.test);
    if (!r.passed) return { suite: known.suite, test: r.failed ?? known.test, how: "test", note: "the test that caught it last time" };
  }
  return firstFailing(dir, catcherFirst(suiteOrder(target, SUITES, cost, readCached, memo), known?.suite));
}

await pool(selected, jobs, async (m) => {
  const dir = scratchCopy();
  try {
    const target = plant(dir, m);
    if (target === undefined) {
      broken++;
      return;
    }
    const caught = await hunt(dir, m, target);
    if (caught === undefined) {
      delete catchers[m.name];
      survived++;
      console.log(`SURVIVED ${m.name}`);
    } else {
      catchers[m.name] = caught.test === undefined ? { suite: caught.suite } : { suite: caught.suite, test: caught.test };
      how[caught.how]++;
      console.log(`killed   ${m.name} (by ${caught.suite}, ${caught.note})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const names = new Set(MUTANTS.map((m) => m.name));
writeFileSync(CATCHERS, JSON.stringify(Object.fromEntries(Object.entries(catchers).filter(([k]) => names.has(k)).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
const seconds = Math.round((performance.now() - t0) / 1000);
console.log(`\n${selected.length - survived - broken}/${selected.length} killed, ${survived} survived, ${broken} broken`);
console.log(`${jobs} at a time, ${seconds}s; caught by last time's test: ${how.test}, by the first file tried: ${how.file}, later: ${how.later}`);
process.exit(survived || broken ? 1 : 0);
