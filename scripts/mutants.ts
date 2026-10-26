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

// `needs: "postgres"`: a bug in the Postgres store, which only its Postgres contract tests can
// catch: run when TIRA_PG_URL names a database (CI sets it), listed as not run otherwise.
type Mutant =
  | { name: string; file: string; find: string; replace: string; reextract?: boolean; needs?: "postgres" }
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
  { name: "store: subscribe ignores fromSeq", file: "src/store/poll.ts", find: "let next = opts.fromSeq ?? 1;", replace: "let next = 1;" },
  { name: "store: subscribe advances before handler", file: "src/store/poll.ts", find: "if (source === ALL || e.stream === source) await handler(e);\n        next = e.seq + 1;", replace: "next = e.seq + 1;\n        if (source === ALL || e.stream === source) await handler(e);" },
  { name: "store: async handler not awaited", file: "src/store/poll.ts", find: "if (source === ALL || e.stream === source) await handler(e);", replace: "if (source === ALL || e.stream === source) void handler(e);" },
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
  { name: "tira: invisible characters and lookalikes allowed", file: "src/text.ts", find: String.raw`[...s.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Cc}\s]/gu, "").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join("")`, replace: "s.normalize(\"NFKC\").trim().toLowerCase()" },
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
  { name: "cli: live run accepts an unhashed factory input (sidecar's value recorded, not the bytes')", file: "src/cli/cli.ts", find: "  return { snapshot, pin: \"sha256\", file };", replace: String.raw`  return { snapshot: text === undefined ? snapshot : (text.trim().split(/\s+/)[0] ?? ""), pin: "sha256", file };` },
  { name: "cli: live run ignores a sidecar mismatch", file: "src/cli/cli.ts", find: "if (declared !== snapshot) throw", replace: "if (false) throw" },
  { name: "cli: live run refuses when no sidecar is present", file: "src/cli/cli.ts", find: "if (code !== \"ENOENT\") throw", replace: "if (true) throw" },
  { name: "cli: live run accepts an unreadable sidecar", file: "src/cli/cli.ts", find: "if (code !== \"ENOENT\") throw", replace: "if (false) throw" },
  { name: "cli: live run refuses a matching sidecar", file: "src/cli/cli.ts", find: "if (declared !== snapshot) throw", replace: "if (declared === snapshot) throw" },
  { name: "cli: live runs not logged", file: "src/cli/cli.ts", find: "  if (live) {\n    const row = {", replace: "  if (false) {\n    const row = {" },
  { name: "cli: fixture runs logged too", file: "src/cli/cli.ts", find: "  if (live) {\n    const row = {", replace: "  if (true) {\n    const row = {" },
  { name: "cli: an empty input reads as a zero report", file: "src/cli/cli.ts", find: "  if (rows.length === 0) throw new UsageError(`${what} ${file} has no records`);\n", replace: "" },
  { name: "cli: an empty stream reads as a zero report", file: "src/cli/cli.ts", find: "    if (events.length === 0) throw new UsageError(`stream ${stream} has no events in the database`);\n", replace: "" },
  { name: "render: no closed-by-tira mark", file: "src/render/html.ts", find: "r.closedByTira ? `<span class=\"mark tira\">closed by tira</span>` : \"\",", replace: "\"\"," },
  { name: "render: progress counts only done, not cancelled", file: "src/render/html.ts", find: 'const CLOSED = new Set(["done", "cancelled"]);', replace: 'const CLOSED = new Set(["done"]);' },
  { name: "render: drawer ids don't match the links", file: "src/render/html.ts", find: "<section class=\"drawer\" id=\"t${n.i}\"", replace: "<section class=\"drawer\" id=\"d${n.i}\"" },
  { name: "render: board puts parents in the columns", file: "src/render/html.ts", find: "const leaves = nodes.filter((n) => n.row.children.length === 0 || n.row.state !== \"unstarted\");", replace: "const leaves = nodes;" },
  { name: "render: a blocked or started parent drops off Kanban", file: "src/render/html.ts", find: "n.row.children.length === 0 || n.row.state !== \"unstarted\");", replace: "n.row.children.length === 0);" },
  { name: "render: --at N shows history from after N", file: "src/render/html.ts", find: "  events = events.filter((e) => e.seq <= r.lastSeq);", replace: "" },
  { name: "render: no history per task", file: "src/render/html.ts", find: "byKey, links, (trail.get(n.row.key) ?? []).length, changed.has(n.row.key));", replace: "byKey, links, 0, changed.has(n.row.key));" },
  // Track B1: factory tables, handoffs, dispatcher, lanes
  { name: "b1: captures never applied", file: "src/fold/evaluate.ts", find: "const captured = applyCapture(current.context?.[hit.region], res.capture, intent.payload);", replace: "const captured = current.context?.[hit.region];" },
  { name: "b1: guards don't see their region's captured data", file: "src/fold/evaluate.ts", find: "    view,\n    own,\n  });", replace: "    view,\n  });" },
  { name: "b1: superseded versions still take events", file: "src/fold/evaluate.ts", find: "if (def.revisedAs !== undefined && current.version !== undefined && view.get({ type: def.type, id: current.id, version: current.version + 1 })) {", replace: "if (false) {" },
  { name: "b1: a revise needs no predecessor", file: "src/fold/evaluate.ts", find: "      if (!view.get({ type: def.type, id: intent.entity.id, version: v - 1 })) {", replace: "      if (false) {" },
  { name: "b1: births unguarded", file: "src/fold/evaluate.ts", find: "    if (def.createGuard !== undefined) {", replace: "    if (false) {" },
  { name: "b1: revisions stored as brief.created", file: "src/tables/registry.ts", find: "    if (def?.revisedAs !== undefined && version !== undefined && version > 1) return def.revisedAs;\n", replace: "" },
  { name: "b1: dispatcher name not reserved", file: "src/write/write-path.ts", find: "const RESERVED = new Set([MACHINE_ACTOR, DISPATCHER, SYNC]);", replace: "const RESERVED = new Set([MACHINE_ACTOR, SYNC]);" },
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
  { name: "review: reserved names miss control characters", file: "src/text.ts", find: String.raw`[\p{M}\p{Cf}\p{Cc}\s]`, replace: String.raw`[\p{M}\p{Cf}\s]` },
  { name: "review: reserved names miss Cyrillic lookalikes", file: "src/text.ts", find: "\"\u0430\": \"a\", \"\u0441\": \"c\", \"\u0435\": \"e\", \"\u0456\": \"i\", \"\u043e\": \"o\", \"\u0440\": \"p\",", replace: "\"\u0430\": \"a\", \"\u0456\": \"i\"," },
  { name: "review: supersedes typed as text refused", file: "src/fold/evaluate.ts", find: "Number(intent.payload.supersedes) !== v - 1", replace: "intent.payload.supersedes !== v - 1" },
  { name: "review: a race-refused receiver is logged as the dispatcher's", file: "src/write/dispatcher.ts", find: " && evaluate(this.registry, entities, view, intentOf(next, DISPATCHER)).ok;", replace: ";" },
  // The board: Kanban | Graph
  { name: "render: the next-task pin rides on the active task, not the cursor", file: "src/render/html.ts", find: "const pin = r.cursor ? `<span class=\"here\">", replace: "const pin = r.active ? `<span class=\"here\">" },
  { name: "render: no waiting ring on graph nodes", file: "src/render/html.ts", find: "const waitRing = r.awaitingClose ?", replace: "const waitRing = false ?" },
  { name: "render: no tira mark on graph nodes", file: "src/render/html.ts", find: "const tiraMark = r.closedByTira ?", replace: "const tiraMark = false ?" },
  { name: "render: the active node isn't marked", file: "src/render/html.ts", find: "r.active ? \"is-active\" : \"\", changed ? \"changed\" : \"\",", replace: "\"\", changed ? \"changed\" : \"\"," },
  { name: "render: long names keep their underscores on the graph", file: "src/render/html.ts", find: "${esc(spaced(r.id))}</span></span>`", replace: "${esc(r.id)}</span></span>`" },
  { name: "render: a closed child's line never turns green", file: "src/render/html.ts", find: "CLOSED.has(n.row.state) ? \"e done\" : \"e\"", replace: "\"e\"" },
  { name: "render: a parent with nothing left says 0 left", file: "src/render/html.ts", find: "const progress = left > 0 ? `${left} left` : word(r.state);", replace: "const progress = ks.length > 0 ? `${left} left` : word(r.state);" },
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
  { name: "b2: tira key opens the store", file: "src/cli/cli.ts", find: "    if (cmd === \"key\") return key(args, values, registry, stream, io);\n", replace: "    if (cmd === \"key\") { void openStore(db).close(); return key(args, values, registry, stream, io); }\n" },
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
  { name: "classes: confirm links skip the escape (a raw ' in a URL-encoded id)", file: "src/render/html.ts", find: "=> esc(`/confirm?type=${encodeURIComponent(r.type)}&id=${encodeURIComponent(r.id)}&event=${event}${q ? `&${q}` : \"\"}`);", replace: "=> `/confirm?type=${encodeURIComponent(r.type)}&amp;id=${encodeURIComponent(r.id)}&amp;event=${event}${q ? `&amp;${q}` : \"\"}`;" },
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
  { name: "serve: any Host answers", file: "src/serve/server.ts", find: "    if (!LOCAL_HOST.test(host) && host !== opts.site?.host) return send(res, 403,", replace: "    if (false) return send(res, 403," },
  { name: "serve: cross-origin writes accepted", file: "src/serve/server.ts", find: "    if (origin !== undefined && origin !== own) { send(res, 403,", replace: "    if (false) { send(res, 403," },
  { name: "serve: writes need no token", file: "src/serve/server.ts", find: "    if (!safeEqual(form.get(\"token\") ?? \"\", token)) { send(res, 403, text,", replace: "    if (false) { send(res, 403, text," },
  { name: "serve: any entity type accepted", file: "src/serve/server.ts", find: "  if (!verb || !verbFits(verb, type, (t) => registry.get(t)?.tree !== undefined) || id === \"\") return undefined;", replace: "  if (!verb || id === \"\") return undefined;" },
  { name: "serve: a posted actor is honoured", file: "src/serve/server.ts", find: "const cmd = commandOf(ask, ws.stream, actor);", replace: "const cmd = commandOf(ask, ws.stream, form.get(\"actor\") ?? actor);" },
  { name: "serve: inline scripts allowed", file: "src/serve/csp.ts", find: "script-src 'self';", replace: "script-src 'self' 'unsafe-inline';" },
  { name: "serve: Origin null on the page's own posts", file: "src/serve/server.ts", find: "\"Referrer-Policy\": \"same-origin\"", replace: "\"Referrer-Policy\": \"no-referrer\"" },
  { name: "serve: the dry run ignores fields still to fill", file: "src/serve/server.ts", find: "payload: verb.field ? { [verb.field.name]: \"(you fill this in)\" } : {} })", replace: "payload: {} })" },
  { name: "serve: confirm form without the token", file: "src/serve/server.ts", find: "const hidden = [[\"token\", opts.token], ", replace: "const hidden = [" },
  { name: "brief: the blocked reason not shown", file: "src/serve/server.ts", find: "since: since ? { seq: since.seq, reason: since.reason } : undefined,", replace: "since: since ? { seq: since.seq } : undefined," },
  { name: "page: live parts in the rendered file", file: "src/render/html.ts", find: "  const live = opts.live !== undefined;", replace: "  const live = true;" },
  { name: "page: attention ignores the reason", file: "src/render/html.ts", find: "    const why = whyLabel(blocked.get(n.row.key)?.reason);", replace: "    const why = \"blocked\";" },
  { name: "page: attention dates a block by its last no-op", file: "src/render/html.ts", find: "  if (ev === \"block\" && !blocked.has(key)) blocked.set(key,", replace: "  if (ev === \"block\") blocked.set(key," },
  { name: "page: attention rows carry data-key", file: "src/render/html.ts", find: "\" changed\" : \"\"}\" data-attention-key=\"${esc(n.row.key)}\"", replace: "\" changed\" : \"\"}\" data-key=\"${esc(n.row.key)}\"" },
  { name: "page: attention shows parents in progress", file: "src/render/html.ts", find: "  const busy = nodes.filter((n) => n.row.active && !n.row.awaitingClose);", replace: "  const busy = nodes.filter((n) => n.row.state === \"in_progress\" && !n.row.awaitingClose);" },
  { name: "page: the theme switch starts on Dark", file: "src/render/html.ts", find: "id=\"th-${t}\"${t === \"system\" ? \" checked\" : \"\"}", replace: "id=\"th-${t}\"${t === \"dark\" ? \" checked\" : \"\"}" },
  { name: "page: a picked Light doesn't beat a dark system", file: "src/render/html.ts", find: ":root:has(#th-light:checked){color-scheme:light;${LIGHT}}", replace: ":root:has(#th-light:checked){color-scheme:light}" },
  { name: "page: a picked Dark prints dark", file: "src/render/html.ts", find: "@media screen{:root:has(#th-dark:checked)", replace: "@media all{:root:has(#th-dark:checked)" },
  { name: "serve: the confirm page forgets the theme", file: "src/serve/server.ts", find: "    + body + `</main><script type=\"module\" src=\"/theme.mjs\"></script></body></html>\\n`;\n}\n\nconst confirmPage", replace: "    + body + `</main></body></html>\\n`;\n}\n\nconst confirmPage" },
  { name: "serve: the page forgets the theme", file: "src/serve/app.mjs", find: "import \"./theme.mjs\";\n", replace: "" },
  { name: "page: the guide gets a fourth paragraph", file: "src/render/html.ts", find: "<p><b>The fingerprint.</b>", replace: "<p>More.</p><p><b>The fingerprint.</b>" },
  { name: "palette: initials don't match", file: "src/serve/rank.mjs", find: "  if (ws.map((w) => w[0]).join(\"\").startsWith(q)) return 800 - ws.length;", replace: "" },
  { name: "palette: a verb doesn't filter by state", file: "src/serve/rank.mjs", find: "    if (verb && !(VERBS_BY_STATE[task.state] ?? []).includes(verb)) return;", replace: "" },
  { name: "palette: ties lose tree order", file: "src/serve/rank.mjs", find: "  scored.sort((a, b) => b.s - a.s || a.order - b.order);", replace: "  scored.sort((a, b) => b.s - a.s || b.order - a.order);" },
  { name: "palette: a verb needs a task word after it", file: "src/serve/rank.mjs", find: "  return verb ? { verb, q: s.slice(cut).trim() } : { verb: undefined, q: query.trim() };", replace: "  return verb && s.slice(cut).trim() ? { verb, q: s.slice(cut).trim() } : { verb: undefined, q: query.trim() };" },
  { name: "brief: tira's closes not announced", file: "src/serve/brief.ts", find: "  if (pv.ok && pv.closes.length > 0) s += ", replace: "  if (false) s += " },
  { name: "serve: the packet judges without tira's closes", file: "src/write/write-path.ts", find: "    return this.decide(intent, await this.store.readStream(cmd.stream), false, \"preview\").verdict;", replace: "    return this.decide(intent, await this.store.readStream(cmd.stream), true, \"preview\").verdict;" },
  { name: "serve: a moved log is written anyway", file: "src/serve/server.ts", find: "    if (a.seen !== String((await now(a.ws.stream)).r.lastSeq)) {", replace: "    if (false) {" },
  { name: "serve: the confirm form forgets what it saw", file: "src/serve/server.ts", find: ", [\"seen\", String(p.seen)], [\"dialog\", \"1\"]]", replace: ", [\"dialog\", \"1\"]]" },
  { name: "serve: reserved actors can serve", file: "src/serve/server.ts", find: "  if (opts.actor !== undefined && isReservedActor(opts.actor)) throw new Error(", replace: "  if (false) throw new Error(" },
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
  // The PASS gap, closed as rules era 3 (ruling 2026-10-21): a brief is done-verified only on a PASS
  { name: "PASS gap: the table takes the dispatcher's word again", file: "charts/brief-outcome.json", find: "\"guard\": \"dispatcherWithPass\"", replace: "\"guard\": \"fromDispatcher\"" },
  { name: "PASS gap: the guard reads no verdict", file: "src/tables/factory.ts", find: "dispatcherWithPass: ({ actor, payload }) => actor === DISPATCHER && verifies(payload.done_test_result),", replace: "dispatcherWithPass: ({ actor }) => actor === DISPATCHER," },
  { name: "PASS gap: a trimmed verdict verifies a brief", file: "src/tables/factory.ts", find: "actor === DISPATCHER && verifies(payload.done_test_result),", replace: "actor === DISPATCHER && verifies(typeof payload.done_test_result === \"string\" ? payload.done_test_result.trim() : payload.done_test_result)," },
  { name: "PASS gap: a lowercase verdict verifies a brief", file: "src/tables/factory.ts", find: "actor === DISPATCHER && verifies(payload.done_test_result),", replace: "actor === DISPATCHER && verifies(String(payload.done_test_result).toUpperCase())," },
  { name: "PASS gap: the new version isn't registered (new writes run the frozen table)", file: "src/tables/factory.ts", find: "outcome: chart(\"brief-outcome.json\") },", replace: "outcome: outcomeEra1 }," },
  { name: "PASS gap: old logs replay under the new version", file: "src/tables/factory.ts", find: "      eras: { 1: { outcome: outcomeEra1 }, 2: { outcome: outcomeEra1 } },\n", replace: "" },
  { name: "PASS gap: era 2 logs replay under the new version", file: "src/tables/factory.ts", find: "eras: { 1: { outcome: outcomeEra1 }, 2: { outcome: outcomeEra1 } },", replace: "eras: { 1: { outcome: outcomeEra1 } }," },
  { name: "PASS gap: the frozen table is the new version", file: "src/tables/factory.ts", find: "const outcomeEra1 = chart(\"eras/brief-outcome.era1.json\");", replace: "const outcomeEra1 = chart(\"brief-outcome.json\");" },
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
  { name: "confirm: no fallback when the packet can't load", file: "src/serve/app.mjs", find: "    show(packet);\n  } catch {\n    location.href = href;\n  }", replace: "    show(packet);\n  } catch {\n  }" },
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
  { name: "dialog: no subtasks list", file: "src/render/html.ts", find: "<ul class=\"kids-list\" aria-label=\"Subtasks\">${rows}</ul>", replace: "" },
  { name: "dialog: a subtask's row shows no estimate", file: "src/render/html.ts", find: "  const est = t?.estimate ? `<span class=\"sub-est\">${esc(t.estimate)}</span>` : `<span class=\"sub-est\"></span>`;", replace: "  const est = `<span class=\"sub-est\"></span>`;" },
  { name: "dialog: a subtask's row shows its id, not its title", file: "src/render/html.ts", find: "const nameOf = (ext: Ext, row: TreeRow) => ext.tickets.get(row.id)?.title ?? row.id;", replace: "const nameOf = (_ext: Ext, row: TreeRow) => row.id;" },
  { name: "dialog: an assignee's mark is anyone's", file: "src/render/html.ts", find: "  if (!name) return `<span class=\"who none\" title=\"Nobody yet\" aria-label=\"Nobody yet\">\u2013</span>`;\n", replace: "" },
  { name: "dialog: subtasks' estimates not added up", file: "src/render/html.ts", find: "  const sum = n.row.children.reduce((h, c) => h + hoursOf(ctx.ext.tickets.get(c.id)?.estimate), 0);", replace: "  const sum = 0;" },
  { name: "dialog: a day is counted as 24 hours", file: "src/render/html.ts", find: "const HOURS: Record<string, number> = { m: 1 / 60, h: 1, d: 8, w: 40 };", replace: "const HOURS: Record<string, number> = { m: 1 / 60, h: 1, d: 24, w: 168 };" },
  { name: "dialog: no way back up to the parent", file: "src/render/html.ts", find: "  const links = up.map((p) => `<a href=\"#t${p.i}\">${esc(nameOf(ctx.ext, p.row))}</a>${sep}`).join(\"\");", replace: "  const links = \"\";" },
  { name: "dialog: no stepping through sister subtasks", file: "src/render/html.ts", find: "  if (at < 0) return \"\";", replace: "  if (true) return \"\";" },
  { name: "dialog: the next sister subtask is the one before", file: "src/render/html.ts", find: "${step(sibs[at + 1]?.key, \"The subtask after\", \"\u2193\")}", replace: "${step(sibs[at - 1]?.key, \"The subtask after\", \"\u2193\")}" },
  { name: "dialog: a ticket's parent isn't linked", file: "src/render/html.ts", find: "  return `<a href=\"#t${p.i}\">${esc(nameOf(ctx.ext, p.row))}</a>${meter(p.row.children.map((c) => c.state))}`;", replace: "  return `<span>${esc(nameOf(ctx.ext, p.row))}</span>`;" },
  { name: "dialog: Add subtask on a done task", file: "src/render/html.ts", find: "const add = ctx.live && TAKES_SUBTASKS.has(r.state) ?", replace: "const add = ctx.live ?" },
  { name: "dialog: a re-open keeps the old proof", file: "src/render/html.ts", find: "    if (ev === \"reopen\") proofs.delete(key);\n", replace: "" },
  { name: "dialog: actions in the rendered file", file: "src/render/html.ts", find: "const verbs = ctx.live ? DIALOG_ACTIONS[r.state] ?? [] : [];", replace: "const verbs = DIALOG_ACTIONS[r.state] ?? [];" },
  { name: "dialog: a done task can't be reopened from it", file: "src/render/html.ts", find: "  done: [[\"REOPEN\", \"Reopen\"]],", replace: "  done: []," },
  { name: "lanes: an empty Lanes tab shows", file: "src/render/html.ts", find: "const views = VIEWS.filter(([t]) => t !== \"lanes\" || lanes !== \"\");", replace: "const views = VIEWS;" },
  { name: "history: still called Activity", file: "src/render/html.ts", find: "${ICON.history}History<span class=\"k\">", replace: "${ICON.history}Activity<span class=\"k\">" },
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
  // The Postgres store (2026-10-21): the same rules as SQLite's, judged by the same contract tests
  { name: "postgres: the counter row isn't locked (two writers take the same seq)", file: "src/store/postgres-store.ts", find: "// the one writer: the counter row stays locked until this append commits or rolls back\n      const counter = await c.query<{ last: string }>(`SELECT last FROM ${s}.event_seq WHERE one FOR UPDATE`);", replace: "// the one writer: the counter row stays locked until this append commits or rolls back\n      const counter = await c.query<{ last: string }>(`SELECT last FROM ${s}.event_seq WHERE one`);", needs: "postgres" },
  { name: "postgres: the counter isn't advanced", file: "src/store/postgres-store.ts", find: "      await c.query(`UPDATE ${s}.event_seq SET last = $1 WHERE one`, [last]);\n", replace: "", needs: "postgres" },
  { name: "postgres: no-update trigger dropped", file: "src/store/postgres-store.ts", find: "CREATE OR REPLACE TRIGGER no_update_events BEFORE UPDATE ON ${s}.events\n  FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();\n", replace: "", needs: "postgres" },
  { name: "postgres: no-delete trigger dropped", file: "src/store/postgres-store.ts", find: "CREATE OR REPLACE TRIGGER no_delete_events BEFORE DELETE ON ${s}.events\n  FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();\n", replace: "", needs: "postgres" },
  { name: "postgres: TRUNCATE allowed", file: "src/store/postgres-store.ts", find: "CREATE OR REPLACE TRIGGER no_truncate_events BEFORE TRUNCATE ON ${s}.events\n  FOR EACH STATEMENT EXECUTE FUNCTION ${s}.events_append_only();\n", replace: "", needs: "postgres" },
  { name: "postgres: duplicate eventId not deduped", file: "src/store/postgres-store.ts", find: "e.eventId !== undefined ? byId.get(eventId) : undefined", replace: "e.eventId !== undefined ? undefined : undefined", needs: "postgres" },
  { name: "postgres: expectedRevision ignored", file: "src/store/postgres-store.ts", find: "if (fresh.length > 0 && opts.expectedRevision !== undefined && opts.expectedRevision !== rev) {", replace: "if (false) {", needs: "postgres" },
  { name: "postgres: a duplicate in another stream accepted", file: "src/store/postgres-store.ts", find: "if (existing && existing.stream !== stream) throw new DuplicateEventIdError", replace: "if (false) throw new DuplicateEventIdError", needs: "postgres" },
  // Postgres is tira's only live store (2026-10-22): a file, no setting, or a hosted database
  // without TLS is refused, and no message holds the connection string; the one-time import
  { name: "live: a SQLite file is opened", file: "src/store/open.ts", find: "  if (!isPostgresUrl(db)) {\n    throw new DatabaseRefused(", replace: "  if (false) {\n    throw new DatabaseRefused(" },
  { name: "live: no database falls back to ./tira.db", file: "src/store/open.ts", find: "    throw new DatabaseRefused(`no database: set ${DATABASE_ENV}", replace: "    return \"tira.db\"; throw new DatabaseRefused(`no database: set ${DATABASE_ENV}" },
  { name: "live: a hosted database without TLS is accepted", file: "src/store/open.ts", find: "  if (!LOCAL.has(u.hostname) && !tls) {", replace: "  if (false) {" },
  { name: "live: a message holds the connection string", file: "src/store/open.ts", find: "with ?sslmode=verify-full`", replace: "with ?sslmode=verify-full: ${db}`" },
  { name: "live: $TIRA_SCHEMA is ignored", file: "src/store/open.ts", find: "u.searchParams.get(\"schema\") ?? (schema?.trim() || null)", replace: "u.searchParams.get(\"schema\")" },
  { name: "import: a re-run is refused instead of adding nothing", file: "src/store/postgres-store.ts", find: "        if (have.length === events.length && have.every((h, i) => sameEvent(h, events[i] as StoredEvent))) return { added: 0 };\n", replace: "", needs: "postgres" },
  { name: "import: into a schema that holds other events", file: "src/store/postgres-store.ts", find: "        throw new ImportRefused(`schema ${s} already holds other events", replace: "        return { added: 0 }; throw new ImportRefused(`schema ${s} already holds other events", needs: "postgres" },
  { name: "import: record times aren't kept (the fingerprints catch it)", file: "src/store/postgres-store.ts", find: "INSERT INTO ${s}.events (seq, stream, stream_revision, event_id, type, data, metadata, recorded_at)\n           SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])`", replace: "INSERT INTO ${s}.events (seq, stream, stream_revision, event_id, type, data, metadata)\n           SELECT a, b, c, d, e, f, g FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(a, b, c, d, e, f, g, h)`", needs: "postgres" },
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
  { name: "ideas/serve: an idea's parent isn't checked before the placement is approved", file: "src/serve/server.ts", find: "    return placeProblem(viewOf((await now(a.ws.stream)).r, a.ws.stream), opts.registry, a.ask.id, parent.trim());", replace: "    return undefined;" },
  { name: "ideas/serve: a stage skip is refused in the rules' words only", file: "src/serve/server.ts", find: "return { verdict: `tira would refuse this: ${refusal.why} (${code}).`, hint: refusal.todo };", replace: "return { verdict: verdictOf(pv), hint: refusal.todo };" },
  { name: "ideas/refusal: placing before the file reads as 'already approved'", file: "src/serve/brief.ts", find: "if (stage === \"declared\" || stage === \"file_pending\") return {", replace: "if (stage === \"declared\") return {" },
  { name: "ideas/command: an idea's verbs taken on a task", file: "src/serve/command.ts", find: "(verb.on === undefined ? isTreeType(type) : type === verb.on)", replace: "(isTreeType(type) || type === verb.on)" },
  { name: "ideas/brief: the placement's candidates not offered", file: "src/serve/server.ts", find: "{ parents: (idea.proposal?.candidates ?? []).filter((c) => c !== parent) }", replace: "{ parents: [] }" },
  { name: "ideas/render: a placed ghost floats on the top row", file: "src/render/html.ts", find: "...(p !== undefined && onTree.has(p) ? { parent: p } : {})", replace: "...{}" },
  { name: "ideas/render: dropped and born ideas stay on the board", file: "src/render/html.ts", find: "ideaRows(r, events, stream).filter((i) => OPEN_STAGES.has(i.stage))", replace: "ideaRows(r, events, stream)" },
  { name: "ideas/render: a ghost isn't marked as an idea", file: "src/render/html.ts", find: "    + `<span class=\"tag\">idea</span><span class=\"gt\">", replace: "    + `<span class=\"gt\">" },
  { name: "ideas/render: no Ideas column", file: "src/render/html.ts", find: "  return `<div class=\"cols\"${drag}>${ideasColumn(ghosts, trail, changed)}${cols}</div>`;", replace: "  return `<div class=\"cols\"${drag}>${cols}</div>`;" },
  { name: "ideas/render: an idea's approvals in the rendered file", file: "src/render/html.ts", find: "const verbs = live ? IDEA_ACTIONS[i.stage] ?? [] : [];", replace: "const verbs = IDEA_ACTIONS[i.stage] ?? [];" },
  // The page at 100+ tasks (Isha's picks, 2026-10-21): Kanban in one row with Done and Dropped capped,
  // needs attention folded, the decision's nutshell first, the graph readable zoomed out (tiles, labels,
  // minimap), found from the palette and dialogs, glides that respect reduced motion, the changed task's
  // glow, plain words
  { name: "ui: Done isn't newest first", file: "src/render/html.ts", find: "if (CLOSED.has(s)) here.sort((a, b) => movedAt(b) - movedAt(a) || a.i - b.i);", replace: "if (false) here.sort((a, b) => movedAt(b) - movedAt(a) || a.i - b.i);" },
  { name: "ui: Done and Dropped never capped", file: "src/render/html.ts", find: "if (!CLOSED.has(state) || cards.length <= SHOWN) return cards.join(\"\");", replace: "if (true) return cards.join(\"\");" },
  { name: "ui: To do capped like Done", file: "src/render/html.ts", find: "if (!CLOSED.has(state) || cards.length <= SHOWN) return cards.join(\"\");", replace: "if (cards.length <= SHOWN) return cards.join(\"\");" },
  { name: "ui: Kanban columns wrap under each other again", file: "src/render/html.ts", find: ".cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(172px,1fr);", replace: ".cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));" },
  { name: "ui: card titles break inside words", file: "src/render/html.ts", find: "const wraps = (id: string) => esc(id).replaceAll(\"_\", \"_<wbr>\");", replace: "const wraps = (id: string) => esc(id);" },
  { name: "ui: needs attention never folds", file: "src/render/html.ts", find: "const folds = count > FOLD_AT;", replace: "const folds = false;" },
  { name: "ui: needs attention folds even when 3 or fewer need you", file: "src/render/html.ts", find: "const folds = count > FOLD_AT;", replace: "const folds = count > 0;" },
  { name: "ui: a folded group hides what the last action changed", file: "src/render/html.ts", find: "const open = ns.some((n) => changed.has(n.row.key)) ? \" open\" : \"\";", replace: "const open = \"\";" },
  { name: "ui: a folded group's line drops the names", file: "src/render/html.ts", find: "<span class=\"names\">${ns.map((n) => esc(n.row.id)).join(\", \")}</span>", replace: "<span class=\"names\"></span>" },
  { name: "ui: Show on graph on the rendered file", file: "src/render/html.ts", find: "const locate = (key: string, live: boolean) => (live ? `<button", replace: "const locate = (key: string, live: boolean) => (true ? `<button" },
  { name: "ui: the changed task's graph box doesn't glow", file: "src/render/html.ts", find: "r.cursor ? \"is-next\" : \"\", r.active ? \"is-active\" : \"\", changed ? \"changed\" : \"\",", replace: "r.cursor ? \"is-next\" : \"\", r.active ? \"is-active\" : \"\", \"\"," },
  { name: "ui: a glow on the rendered file", file: "src/render/html.ts", find: "const changed = new Set(opts.live?.flash?.changed ?? []);", replace: "const changed = new Set([...(opts.live?.flash?.changed ?? []), ...r.entities.map((e) => e.key)]);" },
  { name: "ui: the stats say drained again", file: "src/render/html.ts", find: "<b>${n}</b> parents finished</li>", replace: "<b>${n}</b> drained</li>" },
  { name: "ui: the unevaluable panel loses its reason", file: "src/render/html.ts", find: "<span class=\"sum why\" data-unevaluable-reason>${esc(why)}</span>", replace: "<span class=\"sum why\" data-unevaluable-reason></span>" },
  { name: "ui: decision: the recommendation before the nutshell", file: "src/serve/server.ts", find: "+ `${nutshell}<p class=\"verdict ${p.ok ? \"ok\" : \"no\"}\">${esc(p.verdict)}</p>${hint}${rec}${more}</section>`;", replace: "+ `${rec}${nutshell}<p class=\"verdict ${p.ok ? \"ok\" : \"no\"}\">${esc(p.verdict)}</p>${hint}${more}</section>`;" },
  { name: "ui: decision: Why isn't folded", file: "src/serve/server.ts", find: "`<details class=\"why\" data-why><summary>Why: tradeoffs, best practice, kind</summary>${why.map(para).join(\"\")}</details>`", replace: "`<div class=\"why\" data-why>${why.map(para).join(\"\")}</div>`" },
  { name: "ui: the server forgets what an action changed", file: "src/serve/server.ts", find: "flashes.set(key, flash.ok ? { ...flash, changed: changedBy(ask, ticket) } : flash);", replace: "flashes.set(key, flash);" },
  { name: "ui: a block's new ticket doesn't glow", file: "src/serve/server.ts", find: "[a, ...(ticket === undefined ? [] : [ticket])].map(", replace: "[a].map(" },
  { name: "ui: an added subtask glows its parent instead", file: "src/serve/server.ts", find: "entityKey({ type: x.type, id: x.child ?? x.id })", replace: "entityKey({ type: x.type, id: x.id })" },
  { name: "ui: the palette's index never marks next", file: "src/serve/server.ts", find: "next: row.key === view.cursor, ticket:", replace: "next: false, ticket:" },
  { name: "ui: the palette opens in tree order", file: "src/serve/rank.mjs", find: "const s = q === \"\" ? 1 + priority(task) :", replace: "const s = q === \"\" ? 1 :" },
  { name: "ui: the palette puts blocked before in progress", file: "src/serve/rank.mjs", find: "const FIRST = { in_progress: 3, blocked: 2, unstarted: 1 };", replace: "const FIRST = { in_progress: 2, blocked: 3, unstarted: 1 };" },
  { name: "ui: zoomed out starts at 50%, not below it", file: "src/serve/layout.mjs", find: "export const isFar = (s) => s < FAR;", replace: "export const isFar = (s) => s <= FAR;" },
  { name: "ui: branch spans ignore what's below the children", file: "src/serve/layout.mjs", find: "      if (c) { lo = Math.min(lo, c[0]); hi = Math.max(hi, c[1]); }", replace: "      if (c && false) { lo = Math.min(lo, c[0]); hi = Math.max(hi, c[1]); }" },
  { name: "ui: labels show with no room", file: "src/serve/layout.mjs", find: "export const labelFits = (span, s, depth) => (span[1] - span[0]) * s >= LABEL.min && (depth <= 1 || s >= LABEL.deep);", replace: "export const labelFits = (span, s, depth) => depth <= 1 || s >= LABEL.deep;" },
  { name: "ui: deep labels at any zoom", file: "src/serve/layout.mjs", find: "(depth <= 1 || s >= LABEL.deep)", replace: "(depth <= 2 || s >= LABEL.deep)" },
  { name: "ui: the minimap's view box is off by the pan", file: "src/serve/layout.mjs", find: "export const viewRect = (view, vw, vh) => ({ x: -view.x / view.s,", replace: "export const viewRect = (view, vw, vh) => ({ x: view.x / view.s," },
  { name: "ui: easing is power2, not power3", file: "src/serve/layout.mjs", find: "export const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;", replace: "export const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 2;" },
  { name: "ui: a zoom glide swings sideways", file: "src/serve/layout.mjs", find: "const cx = lerp((vw / 2 - a.x) / a.s, (vw / 2 - b.x) / b.s, k);", replace: "const cx = lerp((vw / 2 - a.x) / a.s, (vw / 2 - b.x) / a.s, k);" },
  { name: "ui: a fold's new boxes appear in place, not from the parent", file: "src/serve/layout.mjs", find: "const a = was ?? anchor(n.key, from);", replace: "const a = was ?? will;" },
  { name: "ui: a folded box lingers after the fold", file: "src/serve/layout.mjs", find: "    if (!will && k >= 1) continue;\n", replace: "" },
  { name: "ui: a fourth theme comes back", file: "src/render/html.ts", find: "[\"dark\", \"Dark\", ICON.moon]];", replace: "[\"dark\", \"Dark\", ICON.moon], [\"living\", \"Living\", ICON.moon]];" },
  { name: "ui: reduced motion still animates", file: "src/render/html.ts", find: "{transition:none!important;animation:none!important}", replace: "{transition:none!important}" },
  { name: "ui: the palette goes to the dialog on the Graph too", file: "src/serve/app.mjs", find: "else if (!(graphShown() && graph.reveal(task.key))) location.hash", replace: "else if (true) location.hash" },
  { name: "ui: the palette's highlighted match is silent", file: "src/serve/app.mjs", find: "if (shown[sel]) input.setAttribute(\"aria-activedescendant\", `pal-${sel}`);", replace: "if (false) input.setAttribute(\"aria-activedescendant\", `pal-${sel}`);" },
  { name: "ui: glides ignore reduced motion", file: "src/serve/graph.mjs", find: "    if (still() || ms <= 0 || wrap.clientWidth === 0) {", replace: "    if (ms <= 0 || wrap.clientWidth === 0) {" },
  // The way home and workspaces (Isha, 2026-10-21): the mark links home; one server serves every
  // workspace in the store at ?w=, and its links, decisions and writes stay in it
  { name: "ui: the mark isn't a link home", file: "src/render/html.ts", find: "export const brand = (href: string) => `<a class=\"brand\" href=\"${esc(href)}\" title=\"Home: the board\" data-home>${ICON.brand}tira</a>`;", replace: "export const brand = (href: string) => `<span class=\"brand\">${ICON.brand}tira</span>`;" },
  { name: "ui: the mark goes to the first workspace", file: "src/render/html.ts", find: "const home = live ? withQ(\"/\", q) : \"#\";", replace: "const home = live ? \"/\" : \"#\";" },
  { name: "ui: projects on the rendered file", file: "src/render/html.ts", find: "${live ? projectsHtml(stream, home, q, name) : \"\"}", replace: "${projectsHtml(stream, home, q, name)}" },
  { name: "ui: action links drop the workspace", file: "src/render/html.ts", find: "&event=${event}${q ? `&${q}` : \"\"}`);", replace: "&event=${event}`);" },
  { name: "ui: the workspace in the URL is ignored", file: "src/serve/server.ts", find: "if (w === null || w === \"\" || w === home) return { stream: home, q: \"\" };", replace: "if (true) return { stream: home, q: \"\" };" },
  { name: "ui: a workspace name with control characters accepted", file: "src/serve/server.ts", find: String.raw`|| [...w].some((c) => (c.codePointAt(0) ?? 0) < 32 || c === "\u007f")`, replace: "" },
  { name: "ui: a missing workspace shows an empty board", file: "src/serve/server.ts", find: "    if (events.length === 0 && ws.q !== \"\") return send(res, 404, html, noWorkspace(ws.stream));\n", replace: "" },
  { name: "ui: a decision posts to the first workspace", file: "src/serve/server.ts", find: "<form method=\"post\" action=\"${esc(withQ(\"/act\", opts.q ?? \"\"))}\"", replace: "<form method=\"post\" action=\"/act\"" },
  { name: "ui: writes land in the first workspace", file: "src/serve/server.ts", find: "const cmd = commandOf(ask, ws.stream, actor);", replace: "const cmd = commandOf(ask, opts.stream, actor);" },
  { name: "ui: a result goes back to the first workspace", file: "src/serve/server.ts", find: "const back = withQ(`/?r=${key}`, ws.q);", replace: "const back = `/?r=${key}`;" },
  { name: "ui: the switcher's list drops a workspace", file: "src/serve/server.ts", find: ".map(({ stream, link }) => {", replace: ".slice(1).map(({ stream, link }) => {" },
  { name: "ui: the switcher counts only blocked tasks as needing you", file: "src/serve/server.ts", find: "rows.filter((x) => x.state === \"blocked\" || (x.active && !x.awaitingClose)).length;", replace: "rows.filter((x) => x.state === \"blocked\").length;" },
  { name: "ui: the palette reads the first workspace", file: "src/serve/app.mjs", find: "const load = () => fetch(withW(\"/api/tasks\"))", replace: "const load = () => fetch(\"/api/tasks\")" },
  { name: "ui: the dialog posts to /act alone", file: "src/serve/app.mjs", find: "void post(form.getAttribute(\"action\") ?? \"/act\", new URLSearchParams(", replace: "void post(\"/act\", new URLSearchParams(" },
  // After Linear (Isha, 2026-10-21): a sidebar, projects and you in it, the audit parts in History,
  // no 'stream' and no blue ideas
  { name: "ui: the sidebar is gone on a wide screen", file: "src/render/html.ts", find: "main[data-stream]>.top{position:fixed;z-index:6;", replace: "main[data-stream]>.top{position:static;z-index:6;" },
  { name: "ui: the fingerprint back on the board's bar", file: "src/render/html.ts", find: "${brand(home)}${search}<div class=\"tabs\">", replace: "${brand(home)}${search}${fingerprintHtml(\"\", 0)}<div class=\"tabs\">" },
  { name: "ui: the divergence panel back on the board", file: "src/render/html.ts", find: "${historyHtml(`${opts.divergence !== undefined ? divergenceHtml(opts.divergence) : \"\"}", replace: "${opts.divergence !== undefined ? divergenceHtml(opts.divergence) : \"\"}${historyHtml(`" },
  { name: "ui: the header says stream again", file: "src/render/html.ts", find: ".hero h1{display:flex;align-items:center;gap:12px;margin:0}", replace: ".hero h1{display:flex;align-items:center;gap:12px;margin:0}.hero h1::before{content:\"stream\"}" },
  { name: "ui: the profile on the rendered file", file: "src/render/html.ts", find: "${live && me !== undefined ? profileHtml(me, live, q) : \"\"}", replace: "${me !== undefined ? profileHtml(me, live ?? {}, \"\") : profileHtml(\"you\", {}, \"\")}" },
  { name: "ui: ideas blue again", file: "src/render/html.ts", find: ".ghost{position:absolute;z-index:1;width:148px;height:56px;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 10px;background:var(--raised);border:1px solid var(--line-2);", replace: ".ghost{position:absolute;z-index:1;width:148px;height:56px;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:center;gap:1px;padding:4px 10px;background:var(--accent-bg);border:1.5px dashed var(--accent);" },
  // Sign-in and the Integrations page (2026-10-21)
  { name: "signin: a Jira sign-in from elsewhere is accepted", file: "src/serve/integrations.ts", find: "if (!p || p.until < Date.now() || p.login !== me.login || !keys) return back(", replace: "if (!keys) return back(" },
  { name: "signin: signed in before GitHub approves", file: "src/serve/integrations.ts", find: "      if (\"wait\" in got) {", replace: "      if (false) {" },
  { name: "signin: the session cookie is readable by scripts", file: "src/serve/integrations.ts", find: "=${session}; HttpOnly; SameSite=Lax;", replace: "=${session}; SameSite=Lax;" },
  { name: "signin: the store keeps session ids themselves", file: "src/sync/credentials.ts", find: "const hashed = (id: string) => createHash(\"sha256\").update(id).digest(\"hex\");", replace: "const hashed = (id: string) => id;" },
  { name: "integrations: the Atlassian secret is shown again", file: "src/serve/integrations.ts", find: "name=\"${k}\" value=\"\" autocomplete", replace: "name=\"${k}\" value=\"${esc(v ?? \"\")}\" autocomplete" },
  { name: "integrations: tira's apps changed without signing in", file: "src/serve/integrations.ts", find: "    if (!mayChangeApps(login)) return back(", replace: "    if (false) return back(" },
  { name: "integrations: anyone signed in may change tira's apps", file: "src/serve/integrations.ts", find: "(c.site || appKeys(env).github ? !!login && isOwner(access(env), login) : true)", replace: "(c.site || appKeys(env).github ? !!login : true)" },
  { name: "integrations: anyone may show or copy tira's keys", file: "src/serve/integrations.ts", find: "    if (!mayChangeApps(who(req).login)) return c.send(res, 403,", replace: "    if (false) return c.send(res, 403," },
  { name: "ui: tira's keys in the page instead of dots", file: "src/serve/integrations.ts", find: "<span class=\"env-v\" data-env-value>${\"•\".repeat(12)}</span>", replace: "<span class=\"env-v\" data-env-value>${esc(v)}</span>" },
  { name: "ui: Show and Copy for someone who isn't the admin", file: "src/serve/integrations.ts", find: "+ (mayKeys ? envButtons(label) : \"\");", replace: "+ envButtons(label);" },
  { name: "integrations: a new secret alone loses its Client ID", file: "src/serve/integrations.ts", find: " || (aSecret ? now.atlassian?.clientId ?? \"\" : \"\");", replace: ";" },
  { name: "ui: Setup shows the list and the form at once", file: "src/render/html.ts", find: ".grp-list.env-edit,#setup-edit:checked~.env-list{display:none}", replace: ".env-edit,#setup-edit:checked~.env-list{display:none}" },
  { name: "ui: a shown key never hides again", file: "src/serve/secrets.mjs", find: "      show.title = \"Hide\";\n      timer = setTimeout(hide, 30_000);\n", replace: "      show.title = \"Hide\";\n" },
  { name: "ui: Copy gives up where a browser refuses the clipboard", file: "src/serve/secrets.mjs", find: "      done = document.execCommand(\"copy\");\n", replace: "" },
  { name: "integrations: linking needs no sign-in", file: "src/serve/integrations.ts", find: "    if (!me.actor) return back(res, \"/integrations\", { ok: false, text: \"Sign in with GitHub first.\" });\n    if (!(await adminHere(me.login))) return back(res, \"/integrations\", { ok: false, text: NOT_ADMIN });\n", replace: "    if (!(await adminHere(me.login))) return back(res, \"/integrations\", { ok: false, text: NOT_ADMIN });\n" },
  { name: "integrations: a page write needs no sign-in once it's on", file: "src/serve/server.ts", find: "    if (actor === undefined) { send(res, 401, text, \"sign in with GitHub first (Integrations)\\n\"); return; }\n", replace: "" },
  // The way in (2026-10-21): the landing for no one signed in, connect before the board, and
  // forms that can only send people back to tira's own steps
  { name: "welcome: the board shows to no one signed in", file: "src/serve/server.ts", find: "    if (!me.actor) return send(res, 303, text, \"\", { Location: `/welcome${url.search}` }); // a result goes along\n", replace: "" },
  { name: "welcome: signed in with no repo, the board shows anyway", file: "src/serve/server.ts", find: "    if (me.login && !link?.repo) return send(res, 303, text, \"\", { Location: `/connect${url.search}` });\n", replace: "" },
  { name: "welcome: Project settings open to no one signed in", file: "src/serve/integrations.ts", find: "if (!me.actor) return signedOut(res, url); // the project's: sign in first", replace: "" },
  { name: "welcome: connect writes without sign-in", file: "src/serve/integrations.ts", find: "    if (!me.login) return back(res, \"/welcome\", { ok: false, text: \"Sign in with GitHub first.\" });\n", replace: "" },
  { name: "welcome: a form can send you anywhere", file: "src/serve/integrations.ts", find: "(v && BACKS.has(v) ? v : fallback)", replace: "(v ? v : fallback)" },
  { name: "welcome: a form without the Jira picker unlinks Jira", file: "src/serve/integrations.ts", find: "const notPicked = form.has(\"jira_project\") ? pickJira(form, me.login, link) : undefined;", replace: "const notPicked = pickJira(form, me.login, link);" },
  // Access (2026-10-21): the first person in is the admin; then only the people they add
  { name: "access: a removed account signs in again", file: "src/serve/integrations.ts", find: "    if (isBlocked(me.login, env)) {", replace: "    if (false) {" },
  { name: "access: a removed person stays signed in", file: "src/serve/integrations.ts", find: "  if (login && !isBlocked(login, env)) return", replace: "  if (login) return" },
  { name: "team: anyone in a project changes its team", file: "src/serve/integrations.ts", find: "    if (!login || !isProjectAdmin(now, login)) return back(res, \"/integrations\",", replace: "    if (!login) return back(res, \"/integrations\"," },
  { name: "access: the first person in isn't the admin", file: "src/serve/integrations.ts", find: "    if (first) await saveAccess((x) => (x.admin === undefined ? { ...x, admin: me.login } : x), env); // the first one in, even if two arrive at once\n", replace: "" },
  { name: "accounts: a removed account stays signed in", file: "src/serve/integrations.ts", find: "    await signOutEverywhere(who2, env);\n", replace: "" },
  { name: "team: a project's last admin can leave", file: "src/serve/team.ts", find: "  const lastAdmin = isProjectAdmin(p, login) && p.admins.length === 1;", replace: "  const lastAdmin = false;" },
  { name: "serve: the page token changes on every restart", file: "src/cli/cli.ts", find: "token: site ? publicPageToken(io.env.TIRA_SECRET_KEY ?? \"\") : pageToken(io.env), ", replace: "", needs: "postgres" },
  { name: "header: zero counts show", file: "src/render/html.ts", find: "(n > 0 ? [li(n)] : [])", replace: "[li(n)]" },
  // Jira's own issues brought in (2026-10-22), and both sides on record so neither is moved
  // until it changes
  { name: "import: Jira's own issues aren't brought in", file: "src/sync/sync.ts", find: "  await bringIn(every);\n", replace: "" },
  { name: "import: tira's issues from elsewhere are brought in", file: "src/sync/sync.ts", find: "!keyOf.has(i.key) && !i.labels.includes(TIRA_LABEL)", replace: "!keyOf.has(i.key)" },
  { name: "import: children before their parents", file: "src/sync/sync.ts", find: ".sort((a, b) => a.level - b.level || num(a.i.key) - num(b.i.key));", replace: ".sort((a, b) => b.level - a.level || num(a.i.key) - num(b.i.key));" },
  { name: "import: done without the Jira link as proof", file: "src/sync/sync.ts", find: "evidenceRef: `${site}/browse/${i.key}`", replace: "evidenceRef: \"done in Jira\"" },
  { name: "import: not labelled in Jira", file: "src/sync/sync.ts", find: "        await jira.setLabels(i.key, [TIRA_LABEL], []);\n", replace: "" },
  { name: "import: Jira is moved where tira can't follow it", file: "src/sync/sync.ts", find: "if ((want.category !== tiraWas || putBack.has(task)) && issue.category !== want.category) {", replace: "if (issue.category !== want.category) {" },
  { name: "sync: a move tira refused stays in Jira", file: "src/sync/sync.ts", find: "      if (why) putBack.add(task);\n", replace: "" },
  // Workspace links (2026-10-21): who may write them, what the sync notices and puts back, the
  // Jira login's privacy, and the links on the page
  { name: "links: the sync may link a workspace", file: "src/tables/links.ts", find: "s(actor) && actor !== SYNC", replace: "s(actor)" },
  { name: "links: a person may write a Jira link", file: "src/tables/links.ts", find: "jiraIssueLinked: ({ actor, payload }) => actor === SYNC && ", replace: "jiraIssueLinked: ({ actor, payload }) => " },
  { name: "links: the sync's name isn't reserved", file: "src/write/write-path.ts", find: "const RESERVED = new Set([MACHINE_ACTOR, DISPATCHER, SYNC]);", replace: "const RESERVED = new Set([MACHINE_ACTOR, DISPATCHER]);" },
  { name: "links: a Jira project without its site", file: "src/tables/links.ts", find: "&& (payload.jira_project === undefined || payload.jira_site !== undefined)", replace: "" },
  { name: "sync: issues made twice", file: "src/sync/sync.ts", find: "    if (links.get(t.id)?.jira) continue;\n", replace: "" },
  { name: "sync: what tira set in Jira isn't recorded", file: "src/sync/sync.ts", find: "      if (l.jira.category !== jiraNow || l.jira.status !== status || l.jira.tira !== want.category) {", replace: "      if (false) {" },
  { name: "sync: a person's move in Jira isn't noticed", file: "src/sync/sync.ts", find: "|| issue.category === l.jira.category) continue;", replace: "|| true) continue;" },
  { name: "sync: a refused move isn't put back", file: "src/sync/sync.ts", find: "      if ((want.category !== tiraWas || putBack.has(task)) && issue.category !== want.category) {\n        status = await jira.moveTo", replace: "      if (false) {\n        status = await jira.moveTo" },
  { name: "sync: a Jira Done gets no proof from the merged PR", file: "src/sync/sync.ts", find: "const proof = l.prs.find((p) => p.state === \"merged\")?.url;", replace: "const proof = undefined;" },
  { name: "sync: blocked isn't labelled", file: "src/sync/sync.ts", find: "labels: { blocked: state === \"blocked\", cancelled", replace: "labels: { blocked: false, cancelled" },
  { name: "sync: a merged PR stays open", file: "src/sync/sync.ts", find: "const event = p.mergedAt ? (state === \"merged\" ? undefined : \"MERGED\")", replace: "const event = p.mergedAt ? undefined" },
  { name: "sync: a mention counts as a name", file: "src/fold/workspace.ts", find: String.raw`for (const m of text.matchAll(/\btira:\s*([A-Za-z0-9][\w.-]*)/gi)) {`, replace: String.raw`for (const m of text.matchAll(/\b([A-Za-z0-9][\w.-]*)/gi)) {` },
  { name: "sync: a Jira key doesn't name its task", file: "src/fold/workspace.ts", find: "    if (task !== undefined && JIRA_KEY.test(m[0])) found.add(task);", replace: "    if (false) found.add(task as string);" },
  { name: "credentials: the file is readable by others", file: "src/sync/credentials.ts", find: "writeFileSync(file(env), `${JSON.stringify(now, null, 2)}\\n`, { mode: 0o600 });\n  chmodSync(file(env), 0o600);", replace: "writeFileSync(file(env), `${JSON.stringify(now, null, 2)}\\n`, { mode: 0o644 });" },
  { name: "page: Sync and Connect in the rendered file", file: "src/render/html.ts", find: "  if (!live) return box(repo + jira);\n", replace: "" },
  { name: "page: links shown as Lanes chips", file: "src/render/html.ts", find: " && !LINK_TYPES.has(e.type)); // links show on their tasks", replace: "); // links show on their tasks" },
  { name: "cli: tira link forgets what it isn't told", file: "src/cli/cli.ts", find: "const merged: Record<string, string | undefined> = { repo: now?.repo, jira_site: now?.jira_site, jira_project: now?.jira_project };", replace: "const merged: Record<string, string | undefined> = {};" },
  // Projects meet the linking work (2026-10-21): + New project connects a repo for a new project;
  // the integration pages work in the request's project; the profile leads to settings
  { name: "ui: the integration pages lose the project", file: "src/serve/server.ts", find: "  if (q === \"\") return html;\n  return html.replace(", replace: "  return html;\n  return html.replace(" },
  { name: "ui: the integration pages' redirects lose the project", file: "src/serve/server.ts", find: "{ ...extra, Location: withQ(at, q) }", replace: "extra" },
  { name: "ui: the integration pages work on the first project", file: "src/serve/server.ts", find: "get stream() { return wsNow().stream; }", replace: "get stream() { return opts.stream; }" },
  { name: "ui: no + New project", file: "src/render/html.ts", find: "data-new-project>${ICON.plus}New project</a>", replace: "data-x></a>" },
  { name: "ui: the profile has no way to settings", file: "src/render/html.ts", find: "<a class=\"ws-item\" href=\"${esc(withQ(\"/settings\", q))}\" data-integrations-nav>", replace: "<a class=\"ws-item\" href=\"/\">" },
  // Round 4 (Isha, 2026-10-21): + New project makes the project with its repo and opens it; History
  // is a dialog under the project's name; Settings after GitHub with help as a chat; Jira's palette
  { name: "ui: + New project writes into the project you're in", file: "src/serve/server.ts", find: "await dispatcher.submit({ stream: at.stream, kind: \"create\", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: 1 }", replace: "await dispatcher.submit({ stream: ws.stream, kind: \"create\", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: 1 }" },
  { name: "ui: + New project takes a name already in use", file: "src/serve/server.ts", find: "    if (before.length === 0) {\n", replace: "    if (true) return { at, site, actor };\n    if (before.length === 0) {\n" },
  { name: "ui: + New project takes any repo", file: "src/serve/server.ts", find: "    if (!REPO.test(repo)) return { problem: [400, \"repo\", `${repo || \"That\"} isn't a GitHub repo as owner/name.`] };\n", replace: "" },
  { name: "ui: + New project lands on the project you were in", file: "src/serve/server.ts", find: "send(res, 303, text, \"\", { Location: withQ(`/?r=${k}`, at.q) });", replace: "send(res, 303, text, \"\", { Location: withQ(`/?r=${k}`, ws.q) });" },
  { name: "ui: no History button under the project's name", file: "src/render/html.ts", find: "<div class=\"title-acts\">${historyButton(all.length)}", replace: "<div class=\"title-acts\">" },
  { name: "ui: the linked bar never offers Add Jira", file: "src/render/html.ts", find: "(ws?.jira_project ? \"\" : `<a class=\"act\" href=\"${settings}#jira\"", replace: "(true ? \"\" : `<a class=\"act\" href=\"${settings}#jira\"" },
  { name: "ui: Project settings without its help", file: "src/serve/integrations.ts", find: "[\"sync\", \"Sync\"], [\"agents\", \"Connect agents\"], [\"delete\", \"Delete\"]] }, body, helpPanel(portOf(host), me.actor), scripts));", replace: "[\"sync\", \"Sync\"], [\"agents\", \"Connect agents\"], [\"delete\", \"Delete\"]] }, body, \"\", scripts));" },
  { name: "ui: Settings has its back link again", file: "src/serve/integrations.ts", find: "const nav = `<nav class=\"set-nav\" aria-label=\"${esc(o.label)}\">${brand(\"/\")}", replace: "const nav = `<nav class=\"set-nav\" aria-label=\"${esc(o.label)}\">${brand(\"/\")}<a class=\"how\" href=\"/\">\u2190 the board</a>" },
  { name: "ui: the Jira palette gone (light)", file: "src/render/html.ts", find: "const LIGHT = `--bg:#ffffff;--side-bg:#f8f8f8;", replace: "const LIGHT = `--bg:#fcfcfd;--side-bg:#f8f8f8;" },
  { name: "ui: the Help centre can't fold", file: "src/serve/integrations.ts", find: "<details class=\"hc\" data-remember=\"tira-help-centre\" open>", replace: "<details class=\"hc\" open>" },
  { name: "ui: folded panels forget how you left them", file: "src/serve/theme.mjs", find: "      localStorage.setItem(d.dataset.remember, d.open ? \"1\" : \"0\");\n", replace: "" },
  { name: "ui: the profile menu says who you act as again", file: "src/render/html.ts", find: "`<div class=\"ws-menu me-menu\" data-me-menu>`", replace: "`<div class=\"ws-menu me-menu\" data-me-menu><p class=\"ws-head\">Acting as ${esc(me)}</p>`" },
  { name: "ui: Account settings called Settings and integrations again", file: "src/render/html.ts", find: "data-integrations-nav>Account settings</a>", replace: "data-integrations-nav>Settings and integrations</a>" },
  { name: "ui: + New project goes nowhere", file: "src/render/html.ts", find: "href=\"${esc(withQ(\"/projects/new\", q))}\" data-new-project>", replace: "href=\"#\" data-new-project>" },
  { name: "serve: no New project page", file: "src/serve/server.ts", find: "\"GET /projects/new\": newProjectGet, ", replace: "" },
  { name: "serve: + New project forgets what you typed", file: "src/serve/server.ts", find: "newProjectPage(await projectForm(me.login, host, ws, { name, repo, jiraProject: key, problem:", replace: "newProjectPage(await projectForm(me.login, host, ws, { problem:" },
  { name: "ui: New project's Cancel goes home, not back", file: "src/serve/server.ts", find: "return { token, back: withQ(\"/\", ws.q),", replace: "return { token, back: \"/\"," },
  { name: "ui: the New project page marks no field", file: "src/serve/new-project.ts", find: "(p.problem?.field === f ? ` aria-invalid=\"true\" aria-describedby=\"np-problem\"` : \"\")", replace: "\"\"" },
  { name: "ui: the Help centre answers the commonest word", file: "src/serve/help.mjs", find: "      if (f) score[i] += 1 / n;", replace: "      if (f) score[i] += 1;" },
  { name: "ui: the Help centre answers anything", file: "src/serve/help.mjs", find: "    if (v > top) {", replace: "    if (v >= top) {" },
  { name: "ui: the Help centre has no box to type in", file: "src/serve/integrations.ts", find: "<form class=\"hc-compose\" data-help-ask>", replace: "<form hidden class=\"x\">" },
  { name: "ui: the Help centre's script isn't loaded", file: "src/serve/integrations.ts", find: "<script type=\"module\" src=\"/help.mjs\"></script>", replace: "" },
  { name: "ui: corners squared again", file: "src/render/html.ts", find: "--r-lg:12px;--r:8px;", replace: "--r-lg:8px;--r:4px;" },
  { name: "ui: buttons lose their capsule", file: "src/render/html.ts", find: "border:1px solid transparent;border-radius:999px;padding:6px 12px;", replace: "border:1px solid transparent;border-radius:var(--r);padding:6px 12px;" },
  { name: "ui: buttons don't give when pressed", file: "src/render/html.ts", find: ".act:active,.find:active,.seg label:active{transform:scale(.97)}", replace: "" },
  { name: "ui: typewriter capitals on the stats again", file: "src/render/html.ts", find: ".big::before,.stats li{font:600 11px/1.3 var(--sans);", replace: ".big::before,.stats li{font:600 10.5px/1.3 var(--mono);" },
  { name: "welcome: Profile settings open to no one signed in", file: "src/serve/integrations.ts", find: "if (!me.actor) return signedOut(res, url); // yours: sign in first", replace: "" },
  { name: "ui: Account settings without its help", file: "src/serve/integrations.ts", find: "body, helpPanel(portOf(host), shown), scripts));", replace: "body, \"\", scripts));" },
  { name: "ui: Account settings name the project again", file: "src/serve/integrations.ts", find: "settingsPage({ title: \"Account settings\", label: \"Account settings\", sections },", replace: "settingsPage({ title: \"Account settings\", label: \"Account settings\", project: { stream: c.stream, name: c.stream }, sections }," },
  { name: "ui: no Appearance in Account settings", file: "src/serve/integrations.ts", find: "+ removed + appearanceGroup();", replace: "+ removed;" },
  { name: "ui: Account settings lose your Jira", file: "src/serve/integrations.ts", find: "githubAccountRow(me.login, keys, t) + await jiraAccountRow(me.login, keys, host, t);", replace: "githubAccountRow(me.login, keys, t);" },
  { name: "ui: the theme switch back in the live sidebar", file: "src/render/html.ts", find: "${live ? \"\" : THEME_SWITCH}", replace: "${THEME_SWITCH}" },
  { name: "ui: the rendered file loses its theme switch", file: "src/render/html.ts", find: "${live ? \"\" : THEME_SWITCH}", replace: "" },
  { name: "ui: the sidebar search looks for tasks again", file: "src/render/html.ts", find: "<label class=\"proj-search\">${ICON.search}<input type=\"search\" placeholder=\"Search projects\"", replace: "<button class=\"kbd\" type=\"button\" data-open-palette>Search</button><label hidden>${ICON.search}<input type=\"search\" placeholder=\"Search projects\"" },
  { name: "ui: no task search in the header", file: "src/render/html.ts", find: "${live ? `<button class=\"find\" type=\"button\" data-open-palette>", replace: "${false ? `<button class=\"find\" type=\"button\" data-open-palette>" },
  { name: "ui: no Project settings in the sidebar", file: "src/render/html.ts", find: "const settings = live ? `<a class=\"side-link\"", replace: "const settings = false ? `<a class=\"side-link\"" },
  { name: "serve: delete without typing the name", file: "src/serve/server.ts", find: "if ((form.get(\"confirm\") ?? \"\").trim() !== shown) return stay(", replace: "if (false) return stay(" },
  { name: "serve: the home project can be deleted", file: "src/serve/server.ts", find: "if (ws.stream === opts.stream) return stay(", replace: "if (false) return stay(" },
  { name: "serve: a deleted project's board stays open", file: "src/serve/server.ts", find: "    if (link?.deleted) return send(res, 410, html, deletedProject(link.title ?? ws.stream, link.by));\n", replace: "" },
  { name: "serve: a deleted project stays on the list", file: "src/serve/server.ts", find: ".filter((x) => !x.link?.deleted)", replace: ".filter(() => true)" },
  { name: "rules: a link version can't delete an unlinked project", file: "src/tables/links.ts", find: " || payload.deleted === true),", replace: ")," },
  { name: "rules: deleted takes any value", file: "src/tables/links.ts", find: "    && (payload.deleted === undefined || payload.deleted === true) && optional(payload.title, TITLE)\n", replace: "    && optional(payload.title, TITLE)\n" },
  { name: "fold: a deleted project reads as live", file: "src/fold/workspace.ts", find: "const deleted = all.some((e) => e.born?.deleted === true);", replace: "const deleted = false;" },
  { name: "serve: New project drops the Jira project picked", file: "src/serve/server.ts", find: "    if (!site) return { repo };\n    return { repo, jira_site: site,", replace: "    return { repo };\n    return { repo, jira_site: site," },
  { name: "ui: New project offers no Jira projects", file: "src/serve/new-project.ts", find: "if (j.state === \"connected\" && j.cloudId) {", replace: "if (false) {" },
  { name: "ui: New project can't connect Jira", file: "src/serve/new-project.ts", find: "data-connect-jira>Connect with Jira</a>", replace: "data-connect-jira></a>" },
  { name: "accounts: removing an account drops their links", file: "src/serve/integrations.ts", find: "    await signOutEverywhere(who2, env);\n", replace: "    await forgetGithub(who2, env);\n" },
  { name: "serve: no renaming a project", file: "src/serve/server.ts", find: "\"POST /projects/rename\": renameProject,", replace: "" },
  { name: "serve: two projects can share a name", file: "src/serve/server.ts", find: "if (others.some((s) => (workspaceOf(r, s)?.title ?? s).toLowerCase() === title.toLowerCase())) return done(", replace: "if (false) return done(" },
  { name: "serve: a rename drops the project's links", file: "src/serve/server.ts", find: "const payload = { ...(link?.repo ? { repo: link.repo } : {}), ...(link?.jira_site ? { jira_site: link.jira_site } : {}), ...(link?.jira_project ? { jira_project: link.jira_project } : {}), title };", replace: "const payload = { title };" },
  { name: "fold: the next link change forgets a rename", file: "src/fold/workspace.ts", find: "const title = all.reduce<string | undefined>((t, e) => (typeof e.born?.title === \"string\" ? e.born.title : t), undefined);", replace: "const title = typeof latest.born?.title === \"string\" ? latest.born.title : undefined;" },
  { name: "ui: the board shows the name it was made with", file: "src/render/html.ts", find: "const name = ext.ws?.title ?? stream;", replace: "const name = stream;" },
  { name: "ui: a rename changes the project's colour", file: "src/render/html.ts", find: "export const projectMark = (stream: string, name = stream) => `<span class=\"pav t${tint(stream)}\"", replace: "export const projectMark = (stream: string, name = stream) => `<span class=\"pav t${tint(name)}\"" },
  { name: "rules: a name alone isn't a link version", file: "src/tables/links.ts", find: "payload.jira_project, payload.title].some(", replace: "payload.jira_project].some(" },
  { name: "rules: any name goes", file: "src/tables/links.ts", find: "optional(payload.title, TITLE)", replace: "true" },
  { name: "ui: no display name to set", file: "src/serve/integrations.ts", find: "\"POST /integrations/profile\": profilePost,", replace: "" },
  { name: "ui: the sidebar ignores your display name", file: "src/render/html.ts", find: "shown = live.name ?? me) =>", replace: "shown = me) =>" },
  { name: "access: no way to unlink your GitHub", file: "src/serve/integrations.ts", find: "\"POST /integrations/github/disconnect\": githubDisconnect,", replace: "" },
  { name: "access: unlinking GitHub keeps the token", file: "src/sync/credentials.ts", find: "    s.github = Object.fromEntries(Object.entries(s.github ?? {}).filter(([k]) => !same(k, login)));\n", replace: "" },
  { name: "ui: touch targets shrink on a touch screen", file: "src/render/html.ts", find: "@media (pointer:coarse){.act,.tool,", replace: "@media (pointer:fine){.act,.tool," },
  { name: "ui: type under 11 again", file: "src/render/html.ts", find: ".ready{font-size:11px;", replace: ".ready{font-size:10px;" },
  { name: "ui: New project keeps what you type in browser storage", file: "src/serve/new-project.mjs", find: "  name.addEventListener(\"input\", show);\n", replace: "  name.addEventListener(\"input\", () => { show(); sessionStorage.setItem(\"tira-new-project\", name.value); });\n" },
  { name: "ui: connecting Jira reloads the New project page", file: "src/serve/tabs.mjs", find: " && !document.querySelector(\"[data-np-jira-row]\")) location.reload();", replace: ") location.reload();" },
  { name: "ui: the script takes the project from the address bar", file: "src/serve/app.mjs", find: "const Q = document.querySelector(\"main\")?.dataset.q ?? \"\";", replace: "const Q = `w=${encodeURIComponent(new URLSearchParams(location.search).get(\"w\") ?? \"\")}`;" },
  { name: "ui: Connect shows even when linked", file: "src/render/html.ts", find: "if (repo === \"\" && jira === \"\") return live ? box(", replace: "if (true) return live ? box(" },
  { name: "ui: the project's links leave the name's line", file: "src/render/html.ts", find: "<h1>${projectMark(stream, name)}${esc(name)}</h1>${board || ext.ws ? projectLinksHtml(ext, opts.live, q) : \"\"}<div class=\"title-acts\">${historyButton(all.length)}</div>", replace: "<h1>${projectMark(stream, name)}${esc(name)}</h1><div class=\"title-acts\">${historyButton(all.length)}</div>${board || ext.ws ? projectLinksHtml(ext, opts.live, q) : \"\"}" },
  { name: "ui: the project's links lose their marks", file: "src/render/html.ts", find: "data-link-repo>${ICON.github}<span>", replace: "data-link-repo><span>" },
  { name: "accounts: setup needs the right to create, every start", file: "src/sync/accounts-pg.ts", find: "if ((made.rows[0]?.n ?? 0) < TABLES.length || cols.rowCount !== 2) await c.query(ddl(this.schema));", replace: "await c.query(ddl(this.schema));", needs: "postgres" },
  { name: "ui: cards don't say who moved them", file: "src/render/html.ts", find: "${last ? whoBadge(last) : \"\"}", replace: "" },
  { name: "ui: agents look like people", file: "src/render/html.ts", find: "export const isAgent = (actor: string): boolean => actor === MACHINE_ACTOR || AGENT.test(actor);", replace: "export const isAgent = (actor: string): boolean => actor === MACHINE_ACTOR;" },
  { name: "serve: no live check", file: "src/serve/server.ts", find: "\"GET /api/live\": liveSeq,", replace: "" },
  { name: "serve: the live check never moves", file: "src/serve/server.ts", find: "JSON.stringify({ seq: last?.seq ?? 0 })", replace: "JSON.stringify({ seq: 0 })" },
  { name: "ui: need you can't fold", file: "src/render/html.ts", find: "<details class=\"att-fold\" open data-remember=\"tira-needs-you\">", replace: "<details class=\"att-fold\" open>" },
  { name: "ui: Show fewer back among the cards", file: "src/render/html.ts", find: "`<label class=\"more-btn\" for=\"more-${state}\">", replace: "`<label class=\"more-btn\" for=\"more-${state}\" hidden>" },
  { name: "ui: no turning edge on work in progress", file: "src/render/html.ts", find: ".card[data-state=\"in_progress\"]{border-color:transparent;", replace: ".card[data-state=\"x\"]{border-color:transparent;" },
  { name: "accounts: a seal isn't bound to its row", file: "src/sync/accounts-pg.ts", find: "      c.setAAD(Buffer.from(row));\n", replace: "" },
  { name: "accounts: any key opens the seals", file: "src/sync/accounts-pg.ts", find: "const key = scryptSync(secret, \"tira accounts v1\", 32);", replace: "const key = scryptSync(\"the same for everyone\", \"tira accounts v1\", 32);" },
  { name: "accounts: no key needed", file: "src/sync/accounts-pg.ts", find: "if (secret === undefined || secret.trim().length < 16) {", replace: "if (false) {" },
  { name: "accounts: a session never ends", file: "src/sync/credentials.ts", find: "return s && Date.parse(s.at) > Date.now() - SESSION_DAYS * 86_400_000 ? s.login : undefined;", replace: "return s?.login;" },
  { name: "accounts: tira serve starts without a key", file: "src/serve/server.ts", find: "  postgresAccounts(linkEnv);\n", replace: "" },
  { name: "accounts: Postgres off this machine without TLS", file: "src/sync/credentials.ts", find: "const u = new URL(liveDatabase(undefined, env));", replace: "const u = new URL(env.TIRA_DATABASE_URL ?? env.TIRA_DB ?? \"\");" },
  { name: "accounts: tokens kept in the clear", file: "src/sync/accounts-pg.ts", find: "[login, this.key.seal(auth.token, `github:${login}`), auth.name ?? null]", replace: "[login, auth.token, auth.name ?? null]", needs: "postgres" },
  { name: "accounts: pages read the accounts as the server started", file: "src/serve/server.ts", find: "    if (route !== liveSeq) await accountsNow(); // the live check reads no one's account\n", replace: "", needs: "postgres" },
  { name: "accounts: the old file overwrites the database", file: "src/sync/accounts-pg.ts", find: "INSERT INTO ${s}.account_github (login, token, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`", replace: "INSERT INTO ${s}.account_github (login, token, name) VALUES ($1, $2, $3) ON CONFLICT (login) DO UPDATE SET token = EXCLUDED.token`", needs: "postgres" },
  { name: "accounts: removing someone ends their links in the database", file: "src/sync/accounts-pg.ts", find: "  async signOutEverywhere(login: string): Promise<void> {\n    await this.write(`DELETE FROM ${this.schema}.account_sessions WHERE lower(login) = lower($1)`, [login]);", replace: "  async signOutEverywhere(login: string): Promise<void> {\n    await this.forget(login);", needs: "postgres" },
  { name: "rules: a Jira name without its project", file: "src/tables/links.ts", find: " && (payload.jira_name === undefined || payload.jira_project !== undefined)", replace: "" },
  { name: "rules: any Jira name goes", file: "src/tables/links.ts", find: "optional(payload.jira_name, TITLE)", replace: "true" },
  { name: "fold: a Jira name doesn't stick", file: "src/fold/workspace.ts", find: "(typeof e.born?.jira_name === \"string\" ? e.born : n)", replace: "(e === latest && typeof e.born?.jira_name === \"string\" ? e.born : n)" },
  { name: "fold: a Jira name outlives its project", file: "src/fold/workspace.ts", find: "named && named.jira_project === b.jira_project && named.jira_site === b.jira_site ?", replace: "named ?" },
  { name: "ui: the Jira chip shows the key, not the name", file: "src/render/html.ts", find: "<span>${esc(ws.jira_name ?? ws.jira_project)}</span>", replace: "<span>${esc(ws.jira_project)}</span>" },
  { name: "jira: a name too long for a link is saved", file: "src/sync/jira.ts", find: "name !== key && TITLE.test(name) ? name", replace: "name !== key ? name" },
  { name: "sync: Jira's name is never caught up", file: "src/sync/sync.ts", find: "  if (name === undefined || name === ws.jira_name) return;", replace: "  if (true) return;" },
  { name: "sync: Jira's name is saved as the sync", file: "src/sync/sync.ts", find: "version: ws.version + 1 }, actor: o.by, payload })", replace: "version: ws.version + 1 }, actor: \"sync\", payload })" },
  { name: "sync: a sync with no one named writes the link", file: "src/sync/sync.ts", find: "  if (!o.by || !ws.jira_site || !ws.jira_project) return;", replace: "  if (!ws.jira_site || !ws.jira_project) return;" },
  { name: "serve: Project settings drops Jira's name", file: "src/serve/integrations.ts", find: "      link.jira_name = await nameOfPicked(me.login, link);\n", replace: "" },
  { name: "serve: connecting drops Jira's name", file: "src/serve/integrations.ts", find: "    if (!same) link.jira_name = await nameOfPicked(me.login, link);\n", replace: "" },
  { name: "serve: New project drops Jira's name", file: "src/serve/server.ts", find: "...(jiraName ? { jira_name: jiraName } : {})", replace: "" },
  { name: "cli: --jira-name is ignored", file: "src/cli/cli.ts", find: "  if (jiraName !== undefined) merged.jira_name = jiraName;\n", replace: "" },
  { name: "access: the way back from GitHub works in any browser", file: "src/serve/integrations.ts", find: " || cookieOf(req, SIGNIN_COOKIE) !== state", replace: "" },
  { name: "access: GitHub's code has no address of its own (Back lands on a blank page)", file: "src/serve/integrations.ts", find: "      c.send(res, 303, \"text/plain; charset=utf-8\", \"\", { Location: `/signin/code?id=${id}` });", replace: "      signinPage(res, id, s);" },
  { name: "access: an old code's page still opens", file: "src/serve/integrations.ts", find: "    if (!p || p.until < Date.now()) back(res, \"/welcome\", { ok: false, text: \"That sign-in expired: start again.\" });", replace: "    if (false) back(res, \"/welcome\", { ok: false, text: \"That sign-in expired: start again.\" });" },
  { name: "access: a sign-in from another project comes back to the first", file: "src/serve/integrations.ts", find: "    if (p?.w && !url.searchParams.has(\"w\")) return c.send(", replace: "    if (false) return c.send(" },
  { name: "access: the way back from GitHub works twice", file: "src/serve/integrations.ts", find: "    pendingGithub.delete(state); // a state works once\n", replace: "" },
  { name: "access: turned down on GitHub reads as a bad code", file: "src/serve/integrations.ts", find: "    if (error) return back(res, \"/welcome\",", replace: "    if (false) return back(res, \"/welcome\"," },
  { name: "access: the direct sign-in away from localhost", file: "src/serve/integrations.ts", find: String.raw`if (secret && (c.site || /^localhost(:\d+)?$/.test(host))) {`, replace: "if (secret) {" },
  { name: "access: no direct sign-in even with a secret", file: "src/serve/integrations.ts", find: "    const secret = appKeys(env).github?.secret;\n", replace: "    const secret = undefined;\n" },
  { name: "setup: saving the Client ID drops the GitHub secret", file: "src/serve/integrations.ts", find: "const keptSecret = ghSecret || now.github?.secret;", replace: "const keptSecret = ghSecret;" },
  { name: "ui: the profile menu spills past the sidebar", file: "src/render/html.ts", find: "main[data-stream]>.top .me-menu{top:auto;bottom:calc(100% + 6px);left:0;right:0;width:auto;transform-origin:bottom center}", replace: "main[data-stream]>.top .me-menu{top:auto;bottom:calc(100% + 6px)}" },
  { name: "ui: no ☰ on the settings pages", file: "src/serve/integrations.ts", find: "<body>${THEME_RADIOS}${SIDE_SHUT}<main class=\"settings-page\" data-settings>${SIDE_TOGGLE}${nav}", replace: "<body>${THEME_RADIOS}<main class=\"settings-page\" data-settings>${nav}" },
  { name: "ui: the settings column stretches across the window", file: "src/render/html.ts", find: ".settings-page .set-main>*{width:100%;max-width:720px;margin-inline:auto}", replace: "" },
  { name: "ui: Appearance comes before your account", file: "src/serve/integrations.ts", find: "+ flashOf(url) + account + setupGroup(me.login, keys, t) + removed + appearanceGroup();", replace: "+ flashOf(url) + appearanceGroup() + account + setupGroup(me.login, keys, t) + removed;" },
  { name: "ui: no way to put Jira off", file: "src/serve/welcome.ts", find: "#jira-later:checked~.land-jira{display:none}", replace: "" },
  { name: "ui: the step after sign-in says Connect, not Sign in to Jira", file: "src/serve/welcome.ts", find: "<span>Sign in to Jira</span>", replace: "<span>Connect</span>" },
  { name: "ui: the way in has a theme switch", file: "src/serve/welcome.ts", find: "<main class=\"land-wrap\">${card}</main>", replace: "<main class=\"land-wrap\"><span data-theme-switch></span>${card}</main>" },
  { name: "accounts: the GitHub secret kept in the clear", file: "src/sync/accounts-pg.ts", find: "keys.github?.secret ? this.key.seal(keys.github.secret, \"apps:github_secret\") : null],", replace: "keys.github?.secret ?? null],", needs: "postgres" },
  { name: "accounts: older tables never get their new columns", file: "src/sync/accounts-pg.ts", find: " || cols.rowCount !== 2", replace: "", needs: "postgres" },
  { name: "ui: GitHub and Jira open over the board", file: "src/render/html.ts", find: "const OUT = `target=\"_blank\" rel=\"noopener noreferrer\"`;", replace: "const OUT = `rel=\"noopener noreferrer\"`;" },
  { name: "ui: ☰ doesn't hide the sidebar", file: "src/render/html.ts", find: "#side-shut:checked~main[data-stream]>.top{display:none}", replace: "" },
  { name: "ui: the sidebar forgets it was hidden", file: "src/serve/theme.mjs", find: "    if (was !== null) c.checked = was === \"1\";\n", replace: "" },
  { name: "accounts: unlinking GitHub leaves its token in the database", file: "src/sync/accounts-pg.ts", find: "      await c.query(`DELETE FROM ${s}.account_github WHERE lower(login) = lower($1)`, [login]);\n", replace: "", needs: "postgres" },
  { name: "signin: Continue with GitHub is stopped at tira", file: "src/serve/integrations.ts", find: "known: cookieOf(req, KNOWN_COOKIE) === \"1\", ...(flash ? { flash } : {}) }), { \"Content-Security-Policy\": SIGNIN_CSP });", replace: "known: cookieOf(req, KNOWN_COOKIE) === \"1\", ...(flash ? { flash } : {}) }));" },
  { name: "signin: every page lets forms go on to GitHub", file: "src/serve/server.ts", find: "import { consentCsp, CSP } from \"./csp.ts\";\n", replace: "import { consentCsp, SIGNIN_CSP as CSP } from \"./csp.ts\";\n" },
  { name: "signin: the way in lets forms go anywhere on GitHub", file: "src/serve/csp.ts", find: "\"form-action 'self' https://github.com/login/oauth/authorize\"", replace: "\"form-action 'self' https://github.com\"" },
  { name: "drag: the board's moves read backwards", file: "src/serve/command.ts", find: "const key = `${def.type}:${p.from}>${p.to}`;", replace: "const key = `${def.type}:${p.to}>${p.from}`;" },
  { name: "drag: a move two verbs could mean picks one", file: "src/serve/command.ts", find: "event !== undefined && more.length === 0 ?", replace: "event !== undefined ?" },
  { name: "drag: the rendered file carries the moves", file: "src/render/html.ts", find: "boardView(nodes, trail, links, ghosts, changed, ext, opts.live?.moves)", replace: "boardView(nodes, trail, links, ghosts, changed, ext, opts.live?.moves ?? {})" },
  { name: "drag: columns don't say their state", file: "src/render/html.ts", find: "const colAttr = moves ? ` data-col=\"${s}\"` : \"\";", replace: "const colAttr = \"\";" },
  { name: "drag: the live board gets no moves", file: "src/serve/server.ts", find: "...(name ? { name } : {}), token, moves, people, agents };", replace: "...(name ? { name } : {}), token, people, agents };" },
  { name: "drag: the script isn't served", file: "src/serve/server.ts", find: "  \"/drag.mjs\": readFileSync(new URL(\"./drag.mjs\", import.meta.url), \"utf8\"),\n", replace: "" },
  { name: "drag: every drop opens a dialog", file: "src/serve/app.mjs", find: "void (now ? runNow(href) : openConfirm(href));", replace: "void openConfirm(href);" },
  { name: "drag: a Start tira would refuse is posted anyway", file: "src/serve/app.mjs", find: "    if (packet.dataset.ok !== \"true\") return show(packet);\n", replace: "" },
  { name: "drag: a drop's Start has no fallback", file: "src/serve/app.mjs", find: "body, () => show(packet));\n  } catch {\n    location.href = href;\n  }", replace: "body, () => show(packet));\n  } catch {\n  }" },
  { name: "drag: Complete runs without asking for proof", file: "src/serve/drag.mjs", find: "export const RUNS_AT_ONCE = new Set([\"START\"]);", replace: "export const RUNS_AT_ONCE = new Set([\"START\", \"COMPLETE\"]);" },
  { name: "drag: a move the rules don't give still means Start", file: "src/serve/drag.mjs", find: "return Object.hasOwn(moves, move) ? moves[move] : undefined;", replace: "return moves[move] ?? \"START\";" },
  { name: "drag: a drop the rules don't allow acts anyway", file: "src/serve/drag.mjs", find: "    if (!event) return; // not a move the rules allow: the card stays where it was\n", replace: "" },
  { name: "drag: a drop opens the card's dialog too", file: "src/serve/drag.mjs", find: "  board.addEventListener(\"click\", (e) => { if (dragged) { e.preventDefault(); e.stopPropagation(); } }, true);\n", replace: "" },
  { name: "drag: a swipe over a card picks it up", file: "src/serve/drag.mjs", find: "      if (e.pointerType === \"touch\") return end(); // moved before the hold: a scroll\n", replace: "" },
  { name: "drag: every column looks like a place to drop", file: "src/serve/drag.mjs", find: "    return moveTo(col) ? \"ok\" : \"no\";\n", replace: "    return \"ok\";\n" },
  { name: "proof: a proof that isn't the task's is taken unchecked", file: "src/serve/server.ts", find: "if (commits.some((c) => c.sha === ref) || prs.some((p) => p.url === ref)) return { kept: false };", replace: "if (ref !== \"\") return { kept: false };" },
  { name: "proof: the page completes without checking the proof", file: "src/serve/server.ts", find: "    const proof = await commitProblem(a);", replace: "    const proof = { kept: false } as { why?: string; kept: boolean };" },
  { name: "github: a task's commits read from every pull request", file: "src/sync/github.ts", find: "  const prs = pulls.filter((p) => linked.includes(p.number) || named(p.head?.ref ?? \"\") || saysTask(`${p.title ?? \"\"}\\n${p.body ?? \"\"}`, task));", replace: "  const prs = pulls;" },
  { name: "github: a pull request linked already isn't read", file: "src/sync/github.ts", find: "pulls.filter((p) => linked.includes(p.number) || named(", replace: "pulls.filter((p) => named(" },
  { name: "github: a branch with no pull request isn't read", file: "src/sync/github.ts", find: "  const lists = await Promise.all([...prs.map(ofPull), ...lone.map(ofBranch)]);", replace: "  const lists = await Promise.all([...prs.map(ofPull)]);" },
  { name: "github: \"tira: <task>.\" isn't the task", file: "src/sync/github.ts", find: String.raw`(m[1] ?? "").replace(/\.+$/, "") === task`, replace: "(m[1] ?? \"\") === task" },
  { name: "proof: a look that fails says nothing", file: "src/sync/commits.ts", find: "    return `Couldn't reach GitHub (${(err as Error).message}).`;", replace: "    return \"\";" },
  { name: "proof: a look on GitHub keeps nothing", file: "src/sync/commits.ts", find: "    if (w.status === \"appended\") kept++;", replace: "    if (false) kept++;" },
  { name: "proof: sync keeps no commits", file: "src/sync/sync.ts", find: "          await keepCommits(p, task, ws.repo);\n", replace: "" },
  { name: "proof: a commit on two pull requests is kept twice", file: "src/sync/sync.ts", find: "if (keptNow.has(id) || r.entities.some(", replace: "if (r.entities.some(" },
  { name: "proof: anyone may keep a commit", file: "src/tables/tickets.ts", find: "    actor === SYNC && s(payload.task) && typeof payload.sha", replace: "    s(payload.task) && typeof payload.sha" },
  { name: "dialog: a chip fills nothing", file: "src/serve/app.mjs", find: "      field.value = chip.dataset.value ?? \"\";\n", replace: "" },
  { name: "dialog: a subtask can't be marked as found", file: "src/serve/app.mjs", find: "    mark.value = \"1\";\n", replace: "" },
  { name: "dialog: the move's comment is dropped", file: "src/serve/server.ts", find: "if (flash.ok && comment !== \"\" && ask.type !== IDEA) {", replace: "if (false) {" },
  { name: "dialog: any entity type accepted from its fields", file: "src/serve/server.ts", find: "  if (!verb || id === \"\" || !verbFits(verb, type, (t) => registry.get(t)?.tree !== undefined)) return undefined;", replace: "  if (!verb || id === \"\") return undefined;" },
  { name: "dialog: a subtask is never marked as found", file: "src/serve/server.ts", find: "const found = form.get(\"discovered\") !== \"1\" ? {} : { kind: \"discovered\", discovered_during: id };", replace: "const found = {};" },
  { name: "dialog: a block on a new ticket makes no ticket", file: "src/serve/server.ts", find: "  return { ask, ticket: { type, id, event: \"ADD_SUBTASK\", child, payload: { parent_id: id, kind: \"discovered\", discovered_during: id } } };", replace: "  return { ask };" },
  { name: "dialog: no word on what to do", file: "src/serve/server.ts", find: "  if (!p.ok) return p.hint ? `<p class=\"verdict no\" data-hint title=\"${esc(p.verdict)}\">${esc(p.hint)}</p>` : `<p class=\"verdict no\">${esc(p.verdict)}</p>`;", replace: "  if (!p.ok) return `<p class=\"verdict no\">${esc(p.verdict)}</p>`;" },
  { name: "tickets: anyone's name as assignee", file: "src/serve/server.ts", find: "(!ASSIGNEE.test(assignee) || !allowed.includes(assignee))", replace: "!ASSIGNEE.test(assignee)" },
  { name: "tickets: any estimate", file: "src/tables/tickets.ts", find: "estimate !== \"\" && !ESTIMATE.test(estimate) ?", replace: "false ?" },
  { name: "tickets: a save that changes nothing writes anyway", file: "src/serve/server.ts", find: "    if (saysSame(before, payload)) return said({ ok: true, text: \"Nothing changed.\" });\n", replace: "" },
  { name: "tickets: steps are lost", file: "src/tables/tickets.ts", find: "  if (words.steps.length > 0) p.steps = words.steps;\n", replace: "" },
  { name: "tickets: the dialog shows no title", file: "src/render/html.ts", find: "value=\"${esc(t?.title ?? \"\")}\" placeholder=\"${esc(r.id)}\" aria-label=\"Title\"", replace: "value=\"\" placeholder=\"${esc(r.id)}\" aria-label=\"Title\"" },
  { name: "tickets: an estimate beside isn't part of the ticket's form", file: "src/render/html.ts", find: "<input type=\"text\" name=\"estimate\" form=\"${formOf(n)}\"", replace: "<input type=\"text\" name=\"estimate\"" },
  { name: "tickets: Save always shows", file: "src/render/html.ts", find: ".js .tk-form:not([data-dirty]) .tk-save{display:none}", replace: "" },
  { name: "tickets: a change doesn't show Save", file: "src/serve/app.mjs", find: "  if (form?.matches(\"[data-ticket-form]\")) form.dataset.dirty = \"1\";\n", replace: "" },
  { name: "tickets: the history isn't folded", file: "src/render/html.ts", find: "const history = `<details class=\"trail\"><summary>", replace: "const history = `<details class=\"trail\" open><summary>" },
  { name: "tickets: a ticket's next version isn't one", file: "src/serve/server.ts", find: "version: (before?.version ?? 0) + 1 }", replace: "version: 1 }" },
  { name: "comments: agents never see feedback", file: "src/mcp/tasks.ts", find: "  return list.filter((x) => x.by !== actor && x.seq > mine);", replace: "  return [];" },
  { name: "comments: answered feedback still shown", file: "src/mcp/tasks.ts", find: "  return list.filter((x) => x.by !== actor && x.seq > mine);", replace: "  return list.filter((x) => x.by !== actor);" },
  { name: "comments: an agent's comment written as someone else", file: "src/mcp/actions.ts", find: "actor: c.actor, payload: { task: id, text: words } };", replace: "actor: \"isha\", payload: { task: id, text: words } };" },
  { name: "agents: what's assigned to them isn't said", file: "src/mcp/tasks.ts", find: "  if (mine.length > 0) lines.push(`Assigned to you:", replace: "  if (false) lines.push(`Assigned to you:" },
  { name: "agents: a task's ticket isn't shown to them", file: "src/mcp/tasks.ts", find: "...ticketLines(tickets.get(row.id))", replace: "...ticketLines(undefined)" },
  { name: "agents: a ticket they fill loses who it's assigned to", file: "src/mcp/actions.ts", find: "  const assignee = before?.assignee;", replace: "  const assignee = undefined;" },
  { name: "agents: steps they leave out of a ticket are cleared", file: "src/mcp/actions.ts", find: "(fill.steps ?? before?.steps ?? [])", replace: "(fill.steps ?? [])" },
  { name: "agents: a ticket they fill is written as someone else", file: "src/mcp/actions.ts", find: "version: (before?.version ?? 0) + 1 }, actor: c.actor, payload };", replace: "version: (before?.version ?? 0) + 1 }, actor: \"isha\", payload };" },
  { name: "agents: a ticket's next version isn't one", file: "src/mcp/actions.ts", find: "entity: { type: TICKET, id, version: (before?.version ?? 0) + 1 }", replace: "entity: { type: TICKET, id, version: 1 }" },
  { name: "agents: a ticket that says nothing new is written again", file: "src/mcp/actions.ts", find: "  if (saysSame(before, payload)) return { ok: true, text: `Nothing changed:", replace: "  if (false) return { ok: true, text: `Nothing changed:" },
  { name: "agents: an empty fill_ticket isn't refused", file: "src/mcp/actions.ts", find: "if (Object.values(fill).every((x) => x === undefined)) return", replace: "if (false) return" },
  { name: "agents: a ticket's words aren't checked", file: "src/mcp/actions.ts", find: "  if (why) return { ok: false, text: `${why} Nothing was written.` };\n  const assignee", replace: "  const assignee" },
  // tira at a public address (src/serve/public.ts) and Claude's connectors signing in (src/mcp/oauth.ts)
  { name: "public: an http address anyone reaches is taken", file: "src/serve/public.ts", find: `(u.protocol !== "https:" && !plain)`, replace: "(false)" },
  { name: "public: serves with a fixed name", file: "src/serve/public.ts", find: `    actor === undefined ? "" :`, replace: `    true ? "" :` },
  { name: "public: no admin needed", file: "src/serve/public.ts", find: `GITHUB_LOGIN.test(admin) ? "" :`, replace: `true ? "" :` },
  { name: "public: no GitHub app needed", file: "src/serve/public.ts", find: `env.TIRA_GITHUB_CLIENT_ID?.trim() && env.TIRA_GITHUB_CLIENT_SECRET?.trim() ? "" :`, replace: `true ? "" :` },
  { name: "public: the page token from nothing secret", file: "src/serve/public.ts", find: `createHmac("sha256", secret)`, replace: `createHmac("sha256", "")` },
  { name: "public: listens on this computer only at a public address", file: "src/serve/public.ts", find: `host: site ? "0.0.0.0" : "127.0.0.1"`, replace: `host: "127.0.0.1"` },
  { name: "public: the host's port isn't read", file: "src/serve/public.ts", find: "port ?? (site ? env.PORT : undefined)", replace: "port ?? undefined" },
  { name: "public: tira serve starts without checking", file: "src/cli/cli.ts", find: "  if (problem) throw new UsageError(problem);\n", replace: "" },
  { name: "accounts: the server's apps aren't read", file: "src/sync/credentials.ts", find: "({ ...read(env).apps, ...settingsApps(env) })", replace: "({ ...read(env).apps })" },
  { name: "accounts: the server's admin isn't read", file: "src/sync/credentials.ts", find: "  return a.admin === undefined && named ? { ...a, admin: named } : a;", replace: "  return a;" },
  { name: "public: browsers aren't kept to https", file: "src/serve/server.ts", find: `"Strict-Transport-Security": "max-age=31536000", `, replace: "" },
  { name: "public: cookies go over http too", file: "src/serve/server.ts", find: "...(cookie ? { \"Set-Cookie\": `${cookie}; Secure` } : {})", replace: "...({})" },
  { name: "public: someone signed out reads the projects", file: "src/serve/server.ts", find: "const signedOut = (res: ServerResponse) => actorNow() === undefined && ", replace: "const signedOut = (res: ServerResponse) => false && " },
  { name: "public: the host's check isn't answered", file: "src/serve/server.ts", find: "    if (req.method === \"GET\" && req.url === \"/healthz\") return send(res, 200, text, \"ok\\n\"); // the host's check that tira is up: says nothing else\n", replace: "" },
  { name: "public: the page's own writes refused at its https address", file: "src/serve/server.ts", find: "const own = host === opts.site?.host ? opts.site.origin : `http://${host}`;", replace: "const own = `http://${host}`;" },
  { name: "public: GitHub sends people back to the address the page was opened at", file: "src/serve/integrations.ts", find: "const own = (host: string) => (c.site ? c.site.origin : `http://${host}`);", replace: "const own = (host: string) => `http://${host}`;" },
  { name: "agents: no way for Claude by its Connectors", file: "src/serve/integrations.ts", find: "    return head + top + one + two + three + connectorPart(at)", replace: "    return head + top + one + two + three" },
  { name: "agents: Claude Desktop's local entry at a public address", file: "src/serve/integrations.ts", find: `(c.site ? APPS.filter((a) => a !== "claude-desktop") : APPS)`, replace: "APPS" },
  { name: "signin: a sign-in from Claude's connection doesn't go back to it", file: "src/serve/integrations.ts", find: "const go = next ?? `${await nextStep(me.login)}?r=${key}`;", replace: "const go = `${await nextStep(me.login)}?r=${key}`;" },
  { name: "signin: any address after sign-in", file: "src/serve/integrations.ts", find: "  return NEXT.test(v) ? v : undefined;", replace: "  return v || undefined;" },
  { name: "oauth: any way back registered", file: "src/mcp/oauth.ts", find: "export const redirectTaken = (uri: string) => uri === CLAUDE_CALLBACK || LOOPBACK.test(uri);", replace: "export const redirectTaken = (_uri: string) => true;" },
  { name: "oauth: a client id anyone can make", file: "src/mcp/oauth.ts", find: "  if (!m || !sameText(m[2] as string, mac(secret, m[1] as string))) return undefined;", replace: "  if (!m) return undefined;" },
  { name: "oauth: no PKCE needed", file: "src/mcp/oauth.ts", find: `  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))`, replace: "  if (false)" },
  { name: "oauth: another resource taken", file: "src/mcp/oauth.ts", find: "  if (resource !== null && resource !== resourceOf(origin))", replace: "  if (false)" },
  { name: "oauth: a code works twice", file: "src/mcp/oauth.ts", find: "    this.codes.delete(code);\n", replace: "" },
  { name: "oauth: any verifier", file: "src/mcp/oauth.ts", find: "!sameText(s256(verifier), g.challenge)", replace: "false" },
  { name: "oauth: a code for another client", file: "src/mcp/oauth.ts", find: `    if (form.get("client_id") !== g.client_id) return`, replace: "    if (false) return" },
  { name: "oauth: a code for another way back", file: "src/mcp/oauth.ts", find: `    if ((form.get("redirect_uri") ?? g.redirect_uri) !== g.redirect_uri) return`, replace: "    if (false) return" },
  { name: "oauth: no word on where to sign in", file: "src/mcp/http.ts", find: "    const challenge = o.site ?", replace: "    const challenge = false ?" },
  { name: "oauth: approval without signing in", file: "src/serve/server.ts", find: "    if (!login) { // sign in first, then back here", replace: "    if (false) { // sign in first, then back here" },
  { name: "oauth: Cancel connects anyway", file: "src/serve/server.ts", find: `    if (form.get("decision") !== "allow") return`, replace: "    if (false) return" },
  { name: "oauth: any agent name", file: "src/serve/server.ts", find: "    const why = known ? agentNameProblem(agent) : ", replace: "    const why = known ? undefined : " },
  { name: "oauth: the approval page can't go back to Claude", file: "src/serve/server.ts", find: `"Content-Security-Policy": consentCsp(asking.redirect_uri), `, replace: "" },
  { name: "oauth: the agent connected as someone else", file: "src/serve/server.ts", find: "    const made = await tokens.create(project, name, login, CONNECTOR_APP);", replace: "    const made = await tokens.create(project, name, \"isha\", CONNECTOR_APP);" },
  { name: "oauth: a second connection takes the first's name", file: "src/serve/server.ts", find: "    const name = freeName(agent, ", replace: "    const name = ((a: string, _t: string[]) => a)(agent, " },
  // ticket keys, @mentions, unique projects and the team (Isha, 2026-10-25)
  { name: "keys: numbered by name, not by birth", file: "src/fold/tickets.ts", find: ".sort(byBirth);", replace: ".sort((a, b) => a.id.localeCompare(b.id));" },
  { name: "keys: a key isn't read as its task", file: "src/fold/tickets.ts", find: "  for (const [id, key] of keys) if (key === want) return id;", replace: "  for (const [id, key] of keys) if (false) return id;" },
  { name: "keys: the card shows no key", file: "src/render/html.ts", find: "${keyMark}${pin}", replace: "${pin}" },
  { name: "keys: the ticket shows no key", file: "src/render/html.ts", find: "const parts = [key ? `<span data-ticket-key>${esc(key)}</span>` : \"\", id]", replace: "const parts = [id]" },
  { name: "search: a number finds no task", file: "src/serve/rank.mjs", find: "  if (/^\\d+$/.test(q)) return ticket.endsWith(`_${q}`) ? 950 : 0;", replace: "  if (/^\\d+$/.test(q)) return 0;" },
  { name: "search: every key's TIRA matches", file: "src/serve/rank.mjs", find: "  return /^tira[\\s_]/i.test(q) ? score(q, ticket) : 0;", replace: "  return score(q, ticket);" },
  { name: "mentions: an address reads as a mention", file: "src/fold/tickets.ts", find: "export const MENTION = /(^|[\\s([{,;])@", replace: "export const MENTION = /()@" },
  { name: "mentions: not marked where tira shows words", file: "src/render/html.ts", find: "`<p>${mentionedHtml(p.trim())", replace: "`<p>${esc(p.trim())" },
  { name: "mentions: the page doesn't say who an @ can name", file: "src/render/html.ts", find: "${mentionable}${q === \"\"", replace: "${q === \"\"" },
  { name: "agents: where they were mentioned isn't said", file: "src/mcp/tasks.ts", find: "  lines.push(...mentionLines(", replace: "  [].push(...mentionLines(" },
  { name: "agents: an answered mention is still said", file: "src/mcp/tasks.ts", find: "unanswered(comments.get(row.id) ?? [], actor).filter((x) => mentionsIn", replace: "(comments.get(row.id) ?? []).filter((x) => mentionsIn" },
  { name: "agents: a mention of someone else counts", file: "src/mcp/tasks.ts", find: ".filter((x) => mentionsIn(x.text).includes(actor))", replace: ".filter((x) => mentionsIn(x.text).length > 0)" },
  { name: "agents: a task's key isn't taken", file: "src/mcp/tasks.ts", find: "  if (!/^tira_/i.test(said.trim())) return said;", replace: "  return said;" },
  { name: "projects: a name in use is taken", file: "src/serve/server.ts", find: "    const hit = live.find((s) => same(s) || same(workspaceOf(r, s)?.title ?? s));", replace: "    const hit = live.find((s) => s === name);" },
  { name: "team: the admin can't add people from Project settings", file: "src/serve/integrations.ts", find: "    const add = mayChange\n", replace: "    const add = false\n" },
  { name: "team: Add goes back to Account settings", file: "src/serve/integrations.ts", find: "    }, env);\n    back(res, \"/integrations\", said);", replace: "    }, env);\n    back(res, \"/settings\", said);" },
  // signing up: a request the admin approves in Team (Isha, 2026-10-25)
  { name: "email: the email GitHub's profile shows isn't kept", file: "src/serve/integrations.ts", find: "    if (!emailOf(me.login, env) && me.email && EMAIL.test(me.email)) await saveEmail(me.login, me.email, env);\n", replace: "" },
  { name: "email: someone with no email isn't asked for one", file: "src/serve/server.ts", find: "!emailOf(me.login, linkEnv)) return send(res, 303, text, \"\", { Location: \"/signup/email\" });", replace: "false) return send(res, 303, text, \"\", { Location: \"/signup/email\" });" },
  { name: "signup: the sign-up is lost on its way to GitHub and back", file: "src/serve/integrations.ts", find: "until: Date.now() + s.expiresIn * 1000, signup });", replace: "until: Date.now() + s.expiresIn * 1000, signup: false });" },
  { name: "email: anything is kept as an email", file: "src/serve/integrations.ts", find: "    if (!EMAIL.test(email)) return back(res, back2, { ok: false, text: \"That isn't an email address.\" });\n", replace: "" },
  { name: "landing: no Sign up for someone new", file: "src/serve/welcome.ts", find: "  if (o.known) return", replace: "  if (true) return" },
  { name: "landing: Sign up where someone signed in before", file: "src/serve/welcome.ts", find: "if (o.known) return", replace: "if (false) return" },
  { name: "landing: a browser someone signed in on isn't remembered", file: "src/serve/server.ts", find: "    if (me.login && !cookieOf(req, KNOWN_COOKIE)) res.setHeader(", replace: "    if (false) res.setHeader(" },
  { name: "projects: someone else's project opens", file: "src/serve/server.ts", find: "    if (me.login && !YOURS.has(key) && !inProject(await peopleNow(ws.stream), me.login)) {", replace: "    if (false) {" },
  { name: "projects: your list shows every project", file: "src/serve/server.ts", find: "      return inProject(p, login) ? [", replace: "      return true ? [" },
  { name: "team: Add doesn't add", file: "src/serve/team.ts", find: "    return { next: { admins: p.admins, members: [...p.members, login] }", replace: "    return { next: { admins: p.admins, members: p.members }" },
  { name: "projects: whoever makes a project isn't its admin", file: "src/serve/server.ts", find: "(p) => (p ? undefined : { admins: [login], members: [] })", replace: "(p) => (p ? undefined : { admins: [], members: [] })" },
  { name: "projects: no cap at a public address", file: "src/serve/server.ts", find: ".filter((p) => p.admin).length >= MAX_PROJECTS)", replace: ".filter((p) => p.admin).length >= Infinity)" },
  { name: "agents: an agent works after its person left the project", file: "src/mcp/http.ts", find: "    if (o.stillIn && !(await o.stillIn(agent))) return refuse(res, 403, NOT_IN_PROJECT);\n", replace: "" },
  { name: "accounts: anyone removes an account", file: "src/serve/integrations.ts", find: "    if (!login || !isOwner(a, login)) return back(res, \"/settings\", { ok: false, text: \"Only this tira's owner can remove accounts.\" });", replace: "    if (!login) return back(res, \"/settings\", { ok: false, text: \"Only this tira's owner can remove accounts.\" });" },
  { name: "team: a member renames the project", file: "src/serve/server.ts", find: "    if (login && !isProjectAdmin(await peopleNow(ws.stream), login)) return done({ ok: false, text: \"Only this project's admins can rename it.\" });\n", replace: "" },
  { name: "team: a member deletes the project", file: "src/serve/server.ts", find: "    if (login && !isProjectAdmin(await peopleNow(ws.stream), login)) return stay(\"Only this project's admins can delete it. Nothing was deleted.\");\n", replace: "" },
  { name: "team: an old project's maker isn't its admin", file: "src/serve/team.ts", find: "  const admin = maker && known(maker) ? maker : a.admin;", replace: "  const admin = a.admin;" },
  { name: "team: the people from before aren't in old projects", file: "src/serve/team.ts", find: "  return { admins, members: (a.members ?? []).filter((m) => !admins.some((x) => same(x, m))) };", replace: "  return { admins, members: [] };" },
  { name: "accounts: requests aren't saved in Postgres", file: "src/sync/accounts-pg.ts", find: "next.members ?? [], next.requests ?? [],", replace: "next.members ?? [], [],", needs: "postgres" },
  { name: "accounts: requests aren't read from Postgres", file: "src/sync/accounts-pg.ts", find: "  if (r.requests.length > 0) a.requests = r.requests;\n", replace: "", needs: "postgres" },
  { name: "agents: complete_task takes any commit", file: "src/mcp/actions.ts", find: "const match = (list: Commit[]) => (ref.length >= 7 ? list.filter((x) => x.sha.startsWith(ref)) : []);", replace: "const match = (list: Commit[]) => list;" },
  { name: "agents: a short commit id is written as itself", file: "src/mcp/actions.ts", find: "if (found.length === 1) return done((found[0] as Commit).sha);", replace: "if (found.length === 1) return done(proof);" },
  { name: "agents: any repo commit or PR is refused", file: "src/mcp/actions.ts", find: "  if (c.proveWith && found.length === 0) {", replace: "  if (false) {" },
  { name: "proof: a pull request named isn't linked to the task", file: "src/sync/commits.ts", find: "      const w = await wp.submitAsSync({ stream, kind: \"create\", entity: { type: PR, id }, payload: { task, repo, number: p.number, url: p.url, title: p.title.slice(0, 200) } });", replace: "      const w = { status: \"appended\" };" },
  { name: "proof: a commit named isn't kept for the task", file: "src/sync/commits.ts", find: "    const w = await wp.submitAsSync({ stream, kind: \"create\", entity: { type: COMMIT, id }, payload: { task, repo, sha: c.sha, message: c.message.slice(0, 300) } });", replace: "    const w = { status: \"appended\" };" },
  { name: "proof: another repo's link is taken", file: "src/sync/commits.ts", find: "/${name}`;", replace: "/[^/]+/[^/]+`;" },
  { name: "proof: a 7-digit commit id reads as a pull request", file: "src/sync/commits.ts", find: String.raw`/^(\d{1,6})$/.exec(said)`, replace: String.raw`/^(\d{1,7})$/.exec(said)` },
  { name: "github: a commit id GitHub has no commit for reads as a failure", file: "src/sync/github.ts", find: String.raw`/\b(?:404|422)\b|Not Found|No commit found/`, replace: String.raw`/\b404\b|Not Found/` },
  { name: "proof: a commit's link isn't read", file: "src/sync/commits.ts", find: "commits|commit)/([0-9a-f]{7,40})", replace: "commits|commit)/(?!)" },
  { name: "proof: a link's anchor is read as part of it", file: "src/sync/commits.ts", find: "ref.trim().replace(/[?#].*$/, \"\")", replace: "ref.trim()" },
  { name: "proof: the check says found for anything", file: "src/sync/commits.ts", find: "    if (\"why\" in got) return { ok: false, text: got.why };", replace: "" },
  { name: "proof: a check that fails says nothing", file: "src/sync/commits.ts", find: "    return { ok: false, text: `Couldn't reach GitHub (${(err as Error).message}).` };", replace: "    return { ok: false, text: \"\" };" },
  { name: "proof: the dialog's field isn't checked as it's typed", file: "src/serve/server.ts", find: "const check = ` data-proof-check=", replace: "const check = ` data-nothing=" },
  { name: "proof: the check answers anyone signed out", file: "src/serve/server.ts", find: "    if (actorNow() === undefined) return send(res, 401, \"application/json; charset=utf-8\", JSON.stringify({ ok: false, text: \"Sign in with GitHub first.\" }));\n", replace: "" },
  { name: "proof: a paste waits like typing", file: "src/serve/app.mjs", find: "e.inputType === \"insertFromPaste\" ? 0 : 500", replace: "500" },
  { name: "proof: an answer to an older value is shown", file: "src/serve/app.mjs", find: "    if (field.value.trim() !== asked) return; // typed on since\n", replace: "" },
  { name: "proof: a pasted proof is ignored", file: "src/serve/server.ts", find: "  const value = pasted || (verb.field ? form.get(verb.field.name) : null);", replace: "  const value = verb.field ? form.get(verb.field.name) : null;" },
  { name: "proof: keeping a proof counts as the log moving", file: "src/serve/server.ts", find: "    if (proof.kept && a.seen === atStart) a.seen = String((await now(a.ws.stream)).r.lastSeq); // its own keeping moved the log\n", replace: "" },
  { name: "agents: complete_task never looks on GitHub", file: "src/mcp/actions.ts", find: "  if (match(commits).length !== 1 && c.fetchCommits) {", replace: "  if (false) {" },
  { name: "cli: tira waits out its account connections before it exits", file: "scripts/tira.ts", find: "await closeAccounts();\n", replace: "", needs: "postgres" },
  { name: "mcp: a person's name accepted", file: "src/mcp/names.ts", find: "  if (!AGENT.test(name)) return", replace: "  if (false) return" },
  { name: "mcp: tira's own names accepted", file: "src/mcp/names.ts", find: "  if (isReservedActor(name)) return", replace: "  if (false) return" },
  { name: "mcp: any shape of name accepted", file: "src/mcp/names.ts", find: "  if (!NAME.test(name)) return", replace: "  if (false) return" },
  { name: "mcp: no name needed", file: "src/mcp/names.ts", find: "  if (name === undefined || name.trim() === \"\") return", replace: "  if (name === undefined) return" },
  { name: "mcp: the task list shows closed tasks by default", file: "src/mcp/tasks.ts", find: "  if (wanted === \"open\") return !CLOSED.has(state);", replace: "  if (wanted === \"open\") return true;" },
  { name: "mcp: the task list ignores the state asked", file: "src/mcp/tasks.ts", find: ".filter((t) => fits(t.state, wanted));", replace: ".filter((t) => fits(t.state, \"open\"));" },
  { name: "mcp: what's next hides the task in progress", file: "src/mcp/tasks.ts", find: "  for (const row of rows.filter((x) => x.active)) {", replace: "  for (const row of rows.filter((x) => false)) {" },
  { name: "mcp: what's next repeats the task in progress", file: "src/mcp/tasks.ts", find: "  else if (!view.active.includes(next.key)) lines.push(", replace: "  else lines.push(" },
  { name: "mcp: a task forgets why it's blocked", file: "src/mcp/tasks.ts", find: "  if (since?.reason) lines.push(`Blocked: ${since.reason}`);\n", replace: "" },
  { name: "mcp: a task forgets its proof", file: "src/mcp/tasks.ts", find: "  if (proof) lines.push(`Proof: ${proof.ref} (from ${proof.actor}, seq ${proof.seq})`);\n", replace: "" },
  { name: "mcp: an unknown task reads as found", file: "src/mcp/tasks.ts", find: "if (!row || !t) return { ok: false,", replace: "if (!row || !t) return { ok: true," },
  { name: "mcp: a reading tool says it writes", file: "src/mcp/server.ts", find: "const READS = { readOnlyHint: true, openWorldHint: false };", replace: "const READS = { readOnlyHint: false, openWorldHint: false };" },
  { name: "mcp: an agent's writes go in under no name", file: "src/mcp/actions.ts", find: "event: name, actor: c.actor, payload });", replace: "event: name, payload });" },
  { name: "mcp: a refusal comes back without what to do", file: "src/mcp/actions.ts", find: "  return { ok: false, text: hint ? `${said.text} What to do: ${hint}` : said.text };", replace: "  return { ok: false, text: said.text };" },
  { name: "mcp: a refusal reads as done", file: "src/mcp/actions.ts", find: "  return { ok: false, text: hint ? `${said.text} What to do: ${hint}` : said.text };", replace: "  return { ok: true, text: hint ? `${said.text} What to do: ${hint}` : said.text };" },
  { name: "mcp: starting a task that isn't there writes anyway", file: "src/mcp/actions.ts", find: "  if (!row) return missing(c, id);\n  return write(c, event(c, id, \"START\"), id, row);", replace: "  return write(c, event(c, id, \"START\"), id, row);" },
  { name: "mcp: a block waits on two things", file: "src/mcp/actions.ts", find: "  if (waitsOn !== undefined && newTicket !== undefined) return", replace: "  if (false) return" },
  { name: "mcp: a block's new ticket isn't found while working", file: "src/mcp/actions.ts", find: "birth(c, name, { parent_id: id, kind: \"discovered\", discovered_during: id })", replace: "birth(c, name, { parent_id: id })" },
  { name: "mcp: a block waits on a task that isn't there", file: "src/mcp/actions.ts", find: "  if (waitsOn !== undefined && !rows.some((x) => x.id === waitsOn)) return", replace: "  if (false) return" },
  { name: "mcp: a block waits on what it's part of", file: "src/mcp/actions.ts", find: "  if (problem) return { ok: false, text: `${id} can't wait on that:", replace: "  if (false) return { ok: false, text: `${id} can't wait on that:" },
  { name: "mcp: a subtask under work isn't found while working", file: "src/mcp/actions.ts", find: "const found = parent.state === \"in_progress\" || parent.state === \"blocked\" ?", replace: "const found = false ?" },
  { name: "mcp: a subtask is found while working on a task not under way", file: "src/mcp/actions.ts", find: "const found = parent.state === \"in_progress\" || parent.state === \"blocked\" ?", replace: "const found = true ?" },
  { name: "mcp: proof of work may be blank", file: "src/mcp/server.ts", find: "const words = (what: string) => z.string().trim().min(1).max(500).describe(what);", replace: "const words = (what: string) => z.string().max(500).describe(what);" },
  { name: "mcp: a writing tool says it reads", file: "src/mcp/server.ts", find: "const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };", replace: "const WRITES = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };" },
  { name: "mcp: tira mcp's startup line goes to stdout, the protocol's", file: "src/cli/cli.ts", find: "    io.err(`tira: MCP server for ${stream}, acting as ${actor}", replace: "    io.out(`tira: MCP server for ${stream}, acting as ${actor}", needs: "postgres" },
  { name: "mcp: tira mcp acts as another agent", file: "src/cli/cli.ts", find: "tiraMcpServer({ store, registry, stream, actor, stillConnected, fetchCommits", replace: "tiraMcpServer({ store, registry, stream, actor: \"claude\", stillConnected, fetchCommits", needs: "postgres" },
  { name: "mcp: tira mcp serves another project", file: "src/cli/cli.ts", find: "tiraMcpServer({ store, registry, stream, actor, stillConnected, fetchCommits", replace: "tiraMcpServer({ store, registry, stream: \"tasktree-main\", actor, stillConnected, fetchCommits", needs: "postgres" },
  { name: "help: no answer for agents", file: "src/serve/integrations.ts", find: "    [\"How do my agents use tira?\",", replace: "    [\"How do my agents use it?\"," },
  { name: "help: GitHub's callback without tira's address", file: "src/serve/integrations.ts", find: "callback <code>http://localhost:${esc(port)}/signin/github/callback</code>, exactly", replace: "callback <code>http://localhost:${esc(port)}/</code>, exactly" },
  { name: "welcome: GitHub's callback without tira's address", file: "src/serve/welcome.ts", find: "callback <code>http://localhost:${esc(o.port)}/signin/github/callback</code>", replace: "callback <code>http://localhost:${esc(o.port)}/</code>" },
  { name: "agents: every project gets the same server name", file: "src/mcp/connect.ts", find: "  return `tira-${slug || \"project\"}`;", replace: "  return \"tira\";" },
  { name: "agents: the command isn't quoted for a shell", file: "src/mcp/connect.ts", find: "const sh = (s: string) => (PLAIN.test(s) ? s :", replace: "const sh = (s: string) => (true ? s :" },
  { name: "agents: no database reads as ready", file: "src/mcp/connect.ts", find: "  if (!file.TIRA_DATABASE_URL) return \"missing\";\n", replace: "" },
  { name: "agents: another schema reads as the same database", file: "src/mcp/connect.ts", find: " && (env.TIRA_SCHEMA ?? \"\") === (file.TIRA_SCHEMA ?? \"\");", replace: ";" },
  { name: "agents: Copy copies nothing", file: "src/serve/secrets.mjs", find: "for (const b of document.querySelectorAll(\"button[data-copy-target]\")) {", replace: "for (const b of []) {" },
  { name: "mcp: tira mcp starts with no token", file: "src/cli/cli.ts", find: "  if (!token) throw new UsageError(`tira mcp needs its agent's token", replace: "  if (false) throw new UsageError(`tira mcp needs its agent's token" },
  { name: "mcp: tira mcp starts with a token that isn't valid", file: "src/cli/cli.ts", find: "  if (!agent) throw new UsageError(`that agent token isn't valid", replace: "  if (false) throw new UsageError(`that agent token isn't valid" },
  { name: "mcp: tira mcp takes another project's token", file: "src/cli/cli.ts", find: "  if (values.stream !== undefined && values.stream !== agent.project) throw", replace: "  if (false) throw" },
  { name: "mcp: a revoked agent keeps working", file: "src/mcp/server.ts", find: "  if (ctx.stillConnected && !(await ctx.stillConnected())) return { ok: false, text: DISCONNECTED };", replace: "  if (false) return { ok: false, text: DISCONNECTED };" },
  { name: "tokens: a revoked token is still found", file: "src/mcp/tokens.ts", find: "find((x) => x.hash === hash && !x.revoked);", replace: "find((x) => x.hash === hash);" },
  { name: "tokens: revoked agents still listed", file: "src/mcp/tokens.ts", find: ".filter((r) => r.project === project && !r.revoked)", replace: ".filter((r) => r.project === project)" },
  { name: "tokens: the token itself is kept, not its fingerprint", file: "src/mcp/tokens.ts", find: "this.rows.set(id, { ...row, hash: tokenHash(token), revoked: false });", replace: "this.rows.set(id, { ...row, hash: token, revoked: false });" },
  { name: "tokens: last used never recorded", file: "src/mcp/tokens.ts", find: "    if (r) r.lastUsedAt = new Date().toISOString();\n", replace: "" },
  { name: "tokens: a taken name gets no number", file: "src/mcp/tokens.ts", find: "  while (taken.includes(name)) name =", replace: "  while (false) name =" },
  { name: "tokens: Postgres finds revoked tokens", file: "src/mcp/tokens.ts", find: "WHERE hash = $1 AND revoked_at IS NULL`", replace: "WHERE hash = $1`", needs: "postgres" },
  { name: "agents: a person's name gets a token", file: "src/serve/integrations.ts", find: "    const why = agentNameProblem(asked);\n    if (why) return { why };\n", replace: "    const why = agentNameProblem(asked);\n" },
  { name: "agents: the same agent connected twice", file: "src/serve/integrations.ts", find: "    if (taken.includes(asked)) return { why:", replace: "    if (false) return { why:" },
  { name: "agents: no Connect agents in Project settings", file: "src/serve/integrations.ts", find: "+ syncCard + agents + remove;", replace: "+ syncCard + remove;" },
  { name: "agents: revoking leaves the token working", file: "src/serve/integrations.ts", find: "    await tokens.revoke(row.id);\n", replace: "" },
  { name: "tokens: Postgres keeps the token itself", file: "src/mcp/tokens.ts", find: "[id, tokenHash(token), project, agent, app ?? null, createdBy]", replace: "[id, token, project, agent, app ?? null, createdBy]", needs: "postgres" },
  { name: "tokens: an agent's app isn't kept", file: "src/mcp/tokens.ts", find: "const row = { id, project, agent, ...(app ? { app } : {}), createdBy,", replace: "const row = { id, project, agent, createdBy," },
  { name: "tokens: Postgres leaves out an agent's app", file: "src/mcp/tokens.ts", find: "agent: r.agent, ...(r.app ? { app: r.app } : {}), createdBy:", replace: "agent: r.agent, createdBy:", needs: "postgres" },
  { name: "tokens: a table made before agents had their app gets no column", file: "src/mcp/tokens.ts", find: "      await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS app text`); // made before agents had their app\n", replace: "", needs: "postgres" },
  { name: "mcp http: no token needed", file: "src/mcp/http.ts", find: "if (token === undefined || !agent) return refuse(", replace: "if (false) return refuse(" },
  { name: "mcp http: a web page elsewhere gets in", file: "src/mcp/http.ts", find: "if (origin !== undefined && !LOCAL_ORIGIN.test(origin) && origin !== o.site?.origin) return", replace: "if (false) return" },
  { name: "mcp http: any web page counts as this computer's", file: "src/mcp/http.ts", find: "const LOCAL_ORIGIN = /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/;", replace: "const LOCAL_ORIGIN = /^https?:\\/\\//;" },
  { name: "mcp http: no Postgres reads as no token", file: "src/mcp/http.ts", find: "if (!tokens) return refuse(res, 503,", replace: "if (!tokens) return refuse(res, 401," },
  { name: "mcp http: acts as another agent", file: "src/mcp/http.ts", find: "stream: agent.project, actor: agent.agent", replace: "stream: agent.project, actor: \"claude\"" },
  { name: "mcp http: serves another project", file: "src/mcp/http.ts", find: "stream: agent.project, actor: agent.agent", replace: "stream: \"tasktree-main\", actor: agent.agent" },
  { name: "mcp http: last used never recorded", file: "src/mcp/http.ts", find: "    await tokens.used(agent.id);\n", replace: "" },
  { name: "mcp http: tira serve doesn't answer /mcp", file: "src/serve/server.ts", find: "    if (url.pathname === MCP_PATH) return mcp(req, res, url);", replace: "    if (false) return mcp(req, res, url);" },
  { name: "agents: the address isn't 127.0.0.1", file: "src/mcp/connect.ts", find: "return `http://127.0.0.1${port", replace: "return `http://localhost${port" },
  { name: "agents: Claude Code's command carries no token", file: "src/mcp/connect.ts", find: " --header ${sh(\"Authorization: \" + bearer)}`,", replace: "`," },
  { name: "agents: Claude Code's command doesn't replace an older entry", file: "src/mcp/connect.ts", find: "code: `claude mcp remove ${name} -s user 2>/dev/null; claude mcp add", replace: "code: `claude mcp add" },
  { name: "agents: no word on Claude's Connectors", file: "src/serve/integrations.ts", find: "    + (c.site ? \"\" : morePart(\"Claude's Connectors\",", replace: "    + (c.site ? \"\" : ((..._: string[]) => \"\")(\"Claude's Connectors\"," },
  { name: "agents: Cursor's config carries no token", file: "src/mcp/connect.ts", find: "    const server = { url: at.url, headers };", replace: "    const server = { url: at.url };" },
  { name: "agents: VS Code's config starts a program", file: "src/mcp/connect.ts", find: "const entry = { type: \"http\", url: at.url, headers };", replace: "const entry = { type: \"stdio\", url: at.url, headers };" },
  { name: "agents: a new token isn't shown", file: "src/serve/integrations.ts", find: "    return made && made.until >= Date.now() && made.project === c.stream && made.by === meAs(me) ? made : undefined;", replace: "    return undefined;" },
  { name: "agents: a revoked agent's setup still shows", file: "src/serve/integrations.ts", find: "const made = shown && rows.some((x) => x.id === shown.id) ? shown : undefined;", replace: "const made = shown;" },
  { name: "agents: step 2 suggests a name that's taken", file: "src/serve/integrations.ts", find: "const suggested = freeName(APP_AGENT[app], rows.map((x) => x.agent));", replace: "const suggested = APP_AGENT[app];" },
  { name: "agents: Connect with no app chosen", file: "src/serve/integrations.ts", find: "    if (!app) return said({ ok: false, text: \"Choose your app first.\" });\n", replace: "" },
  { name: "agents: an agent's app isn't kept", file: "src/serve/integrations.ts", find: "tokens.create(c.stream, named.name, meAs(me), app)", replace: "tokens.create(c.stream, named.name, meAs(me))" },
  { name: "agents: no Add to button", file: "src/serve/integrations.ts", find: "    if (!setup.install) return byHand + dbWarn;", replace: "    return byHand + dbWarn;" },
  { name: "agents: Test connection says connected before the app called", file: "src/serve/integrations.ts", find: "if (row.lastUsedAt) return { ok: true,", replace: "if (true) return { ok: true," },
  { name: "agents: waiting for an app's first call reads as an error", file: "src/serve/integrations.ts", find: "return { ok: false, wait: true, text: `Waiting for", replace: "return { ok: false, text: `Waiting for" },
  { name: "agents: a wait looks like any other message", file: "src/serve/integrations.ts", find: "    if (f.wait) return \"wait\";\n", replace: "" },
  { name: "agents: a wait has no calm look", file: "src/render/html.ts", find: ".flash.wait{", replace: ".flash.waiting{" },
  { name: "agents: Test connection's answer leaves step 3", file: "src/serve/integrations.ts", find: "toAgents(res, (MADE_KEY.test(key) ? `made=${key}&` : \"\") + \"r=\" + c.flash(f));", replace: "toAgents(res, \"r=\" + c.flash(f));" },
  { name: "agents: Test connection answers the page's script with a whole page", file: "src/serve/integrations.ts", find: "if (form.get(\"fragment\") === \"1\") return c.send(res, 200, html, flashLine(f));", replace: "if (false) return c.send(res, 200, html, flashLine(f));" },
  { name: "agents: Claude Desktop's missing database unsaid", file: "src/serve/integrations.ts", find: "const dbWarn = made.app === \"claude-desktop\" && db !== \"ready\" ?", replace: "const dbWarn = false ?" },
  { name: "agents: a step's result shows twice", file: "src/serve/integrations.ts", find: "const top = made || app ? gone : said + gone;", replace: "const top = said + gone;" },
  { name: "agents: the page's script shows no answer", file: "src/serve/agents.mjs", find: "      slot.replaceChildren(said);\n", replace: "" },
  { name: "agents: the page's script asks for a whole page", file: "src/serve/agents.mjs", find: "    body.set(\"fragment\", \"1\");\n", replace: "" },
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

const SUITES = ["store", "runner", "registry", "write-path", "fold", "stack", "cli", "tree", "machine", "render", "factory", "scenarios", "region-scan", "sweep", "serve", "docs", "eras", "fixture-b3", "divergence", "layout", "decision", "labels", "ideas", "sync", "accounts", "mcp", "hosted", "team"];
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

// Bugs whose catchers need a database this run doesn't have: named, never counted as caught.
const needsPg = (m: Mutant) => "needs" in m && m.needs === "postgres";
const unrunnable = process.env.TIRA_PG_URL ? [] : selected.filter(needsPg);
for (const m of unrunnable) console.log(`NOT RUN  ${m.name} (needs Postgres: set TIRA_PG_URL)`);
const runnable = selected.filter((m) => !unrunnable.includes(m));

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

await pool(runnable, jobs, async (m) => {
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
const notRun = unrunnable.length > 0 ? `; ${unrunnable.length} not run (no Postgres)` : "";
console.log(`\n${runnable.length - survived - broken}/${runnable.length} killed, ${survived} survived, ${broken} broken${notRun}`);
console.log(`${jobs} at a time, ${seconds}s; caught by last time's test: ${how.test}, by the first file tried: ${how.file}, later: ${how.later}`);
process.exit(survived || broken ? 1 : 0);
