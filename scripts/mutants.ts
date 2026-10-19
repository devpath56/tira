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
  { name: "write path ignores eventId reuse", file: "src/write/write-path.ts", find: "if (canonicalJson(recordedIntent(prior, this.registry)) !== canonicalJson(asLogged)) {", replace: "if (false) {" },
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
  { name: "c1: render escapes nothing", file: "src/render/html.ts", find: "const esc = (s: string) => s.replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`);", replace: "const esc = (s: string) => s;" },
  { name: "c1: active looks at direct children only", file: "src/fold/tree.ts", find: "return children(e, view).some((c) => test(c) || anyDescendant(c, view, test));", replace: "return children(e, view).some((c) => test(c));" },
  { name: "c1: roots sorted by key, not birth", file: "src/fold/tree.ts", find: ".sort((a, b) => a.createdSeq - b.createdSeq);", replace: ".sort((a, b) => (a.key < b.key ? -1 : 1));" },
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
  { name: "replay: no paired treatment for tira's start", file: "src/fold/fold.ts", find: "{ pairedClose: paired !== undefined }", replace: "{}" },
  { name: "replay: any tira start treated as paired", file: "src/fold/fold.ts", find: "{ pairedClose: paired !== undefined }", replace: "{ pairedClose: e.metadata?.actor === MACHINE_ACTOR }" },
  { name: "replay: pair check ignores the node", file: "src/fold/fold.ts", find: "    entityKey(ia.entity) === entityKey(ib.entity) &&\n", replace: "" },
  { name: "replay: pair check accepts someone else's complete", file: "src/fold/fold.ts", find: "if (a.metadata?.actor !== MACHINE_ACTOR || b.metadata?.actor !== MACHINE_ACTOR) return false;", replace: "if (a.metadata?.actor !== MACHINE_ACTOR) return false;" },
  { name: "replay: pair kept when its complete fails", file: "src/fold/fold.ts", find: "if (ev.ok && paired && !completes(paired, entities, ev))", replace: "if (false)" },
  { name: "replay: tira may write to any node", file: "src/fold/fold.ts", find: "if (!t || !target || !isDrained(t, target, view)) anomaly(", replace: "if (false) anomaly(" },
  { name: "tira: pair treatment for an unfinished node", file: "src/fold/evaluate.ts", find: " && isDrained(t, current, view))) {", replace: ")) {" },
  { name: "tira: invisible characters and lookalikes allowed", file: "src/write/write-path.ts", find: "[...s.normalize(\"NFKD\").replace(/[\\p{M}\\p{Cf}\\p{Cc}\\s]/gu, \"\").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join(\"\")", replace: "s.normalize(\"NFKC\").trim().toLowerCase()" },
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
  { name: "render: no closed-by-tira mark", file: "src/render/html.ts", find: "r.closedByTira ? `<span class=\"mark tira\">closed by tira</span>` : \"\",", replace: "\"\"," },
  { name: "render: progress counts only done, not cancelled", file: "src/render/html.ts", find: 'const CLOSED = new Set(["done", "cancelled"]);', replace: 'const CLOSED = new Set(["done"]);' },
  { name: "render: drawer ids don't match the links", file: "src/render/html.ts", find: "<section class=\"drawer\" id=\"t${n.i}\"", replace: "<section class=\"drawer\" id=\"d${n.i}\"" },
  { name: "render: board puts parents in the columns", file: "src/render/html.ts", find: "const leaves = nodes.filter((n) => n.row.children.length === 0);", replace: "const leaves = nodes;" },
  { name: "render: --at N shows history from after N", file: "src/render/html.ts", find: "  events = events.filter((e) => e.seq <= r.lastSeq);", replace: "" },
  { name: "render: no history per task", file: "src/render/html.ts", find: "const lines = trail.get(r.key) ?? [];", replace: "const lines: string[] = [];" },
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
  { name: "b1: the filer can verify its own drop", file: "src/tables/factory.ts", find: "actor === ORCHESTRATOR && actor !== entity.createdBy && payload.done_test_result === \"PASS\",", replace: "(actor === ORCHESTRATOR || actor === entity.createdBy) && payload.done_test_result === \"PASS\"," },
  { name: "b1: verify without a PASS", file: "src/tables/factory.ts", find: "actor === ORCHESTRATOR && actor !== entity.createdBy && payload.done_test_result === \"PASS\",", replace: "actor === ORCHESTRATOR && actor !== entity.createdBy," },
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
  { name: "block relay: verdicts before a claim", file: "src/fold/handoffs.ts", find: "    return HELD.has(b.regions.claim as string) ? undefined : `${String(reason)} blocks need a claimed brief`;", replace: "    return undefined;" },
  { name: "block relay: anyone can ask", file: "src/fold/handoffs.ts", find: "  if (actor !== ORCHESTRATOR) return \"only the orchestrator can ask to block a brief\";\n", replace: "" },
  { name: "dispatcher: writes only the first handoff", file: "src/write/dispatcher.ts", find: "    for (let n = 0; n < MAX_HANDOFFS; n++) {", replace: "    for (let n = 0; n < 1; n++) {" },
  { name: "dispatcher: tries handoffs the rules refuse", file: "src/write/dispatcher.ts", find: "return due(view, idx).find((r) => evaluate(this.registry, entities, view, intentOf(r, DISPATCHER)).ok);", replace: "return due(view, idx)[0];" },
  { name: "dispatcher: no correlation id", file: "src/write/dispatcher.ts", find: "        correlationId: next.correlationId,\n", replace: "" },
  { name: "render: lanes show the wrong region state", file: "src/render/html.ts", find: "data-region=\"${esc(region)}\" data-state=\"${esc(state)}\">${pill(state)}", replace: "data-region=\"${esc(region)}\" data-state=\"${esc(Object.values(e.regions)[0] as string)}\">${pill(state)}" },
  { name: "render: handoff pairs not grouped by correlation", file: "src/render/html.ts", find: "    if (e.metadata.actor === \"dispatcher\" && c !== undefined) groups.set(c, [...(groups.get(c) ?? []), e]);", replace: "    if (e.metadata.actor === \"dispatcher\" && c !== undefined) groups.set(e.eventId, [e]);" },
  // Found by the adversarial review
  { name: "review: no last-moment due check (concurrent duplicates)", file: "src/write/write-path.ts", find: "      if (stillDue && !stillDue(events)) return { status: \"skipped\", seq: last?.seq ?? 0 };\n", replace: "" },
  { name: "review: drops don't follow brief versions", file: "src/tables/factory.ts", find: "followsVersionsOf: \"brief\", ", replace: "" },
  { name: "review: a retry doesn't catch up", file: "src/write/dispatcher.ts", find: "result.status === \"appended\" || result.status === \"duplicate\" ? await this.catchUp", replace: "result.status === \"appended\" ? await this.catchUp" },
  { name: "review: unnamed claimants not listed", file: "src/fold/handoffs.ts", find: "    if (claimed && HELD.has(b.regions.claim as string) && typeof claimant === \"string\" && !view.get({ type: \"session\", id: claimant })) {", replace: "    if (false) {" },
  { name: "review: a verified drop on a blocked brief not listed", file: "src/fold/handoffs.ts", find: "    if (verified && b && taken && b.regions.outcome !== \"done-verified\" && b.regions.outcome !== \"dropped-unverified\") {", replace: "    if (false) {" },
  { name: "review: a taken node id not listed", file: "src/fold/handoffs.ts", find: "    if (approved && node && born?.payload.idea_id !== i.id) {", replace: "    if (false) {" },
  { name: "review: reserved names miss control characters", file: "src/write/write-path.ts", find: "[\\p{M}\\p{Cf}\\p{Cc}\\s]", replace: "[\\p{M}\\p{Cf}\\s]" },
  { name: "review: reserved names miss Cyrillic lookalikes", file: "src/write/write-path.ts", find: "\"\u0430\": \"a\", \"\u0441\": \"c\", \"\u0435\": \"e\", \"\u0456\": \"i\", \"\u043e\": \"o\", \"\u0440\": \"p\",", replace: "\"\u0430\": \"a\", \"\u0456\": \"i\"," },
  { name: "review: supersedes typed as text refused", file: "src/fold/evaluate.ts", find: "Number(intent.payload.supersedes) !== v - 1", replace: "intent.payload.supersedes !== v - 1" },
  { name: "review: a race-refused receiver is logged as the dispatcher's", file: "src/write/dispatcher.ts", find: " && evaluate(this.registry, entities, view, intentOf(next, DISPATCHER)).ok;", replace: ";" },
  // The progress train
  { name: "render: the train rides on the active task, not the cursor", file: "src/render/html.ts", find: "${r.cursor ? TRAIN : \"\"}", replace: "${r.active ? TRAIN : \"\"}" },
  { name: "render: no waiting ring on branch lines", file: "src/render/html.ts", find: "${r.awaitingClose ? `<span class=\"wait-ring\"", replace: "${false ? `<span class=\"wait-ring\"" },
  { name: "render: no tira mark on branch lines", file: "src/render/html.ts", find: "${r.closedByTira ? `<span class=\"tira-mark\"", replace: "${false ? `<span class=\"tira-mark\"" },
  { name: "render: the active stop never pulses", file: "src/render/html.ts", find: "r.active ? \"is-active\" : \"\",\n    ].filter(Boolean)", replace: "\"\",\n    ].filter(Boolean)" },
  { name: "render: long names not shortened on the train", file: "src/render/html.ts", find: "${esc(short(r.id))}${r.discoveredDuring ? \" \u2726\" : \"\"}", replace: "${esc(r.id)}${r.discoveredDuring ? \" \u2726\" : \"\"}" },
  { name: "render: the track never fills", file: "src/render/html.ts", find: "CLOSED.has(r.state) ? \"closed\" : \"\",", replace: "\"\"," },
  { name: "render: branch lines count what's left wrong", file: "src/render/html.ts", find: "    const left = kids.length - closed;", replace: "    const left = kids.length;" },
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
];
// Known gap, deliberately not listed: BEGIN IMMEDIATE -> BEGIN in sqlite-store.ts
// cannot be observed from a single in-process connection.
// Equivalent since 2026-10-18, so not listed: the cursor skipping closed branches
// (tree.ts `isTerminal` in cursor's walk). The closing gate, the re-open order and
// ADD_CHILD being denied on done/cancelled mean no open task can sit under a closed
// node, so the skip is only a speed-up — no log can tell the two apart.

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "tira-mutant-"));
  for (const p of ["src", "test", "charts", "scenarios", "scripts", "package.json", "tsconfig.json"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runTests(dir: string, report = false): number {
  const tests = ["store", "runner", "registry", "write-path", "fold", "stack", "cli", "tree", "machine", "render", "factory", "scenarios"].map((n) => `test/${n}.test.ts`);
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...tests], { cwd: dir, encoding: "utf8" });
  if (report && r.status !== 0) console.error((r.stdout ?? "").split("\n").filter((l) => l.startsWith("not ok")).join("\n"));
  return r.status ?? 1;
}

// Optional filter: node scripts/mutants.ts <substring of a name> runs only the matching ones.
const only = process.argv[2];
const selected = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS;
let survived = 0;
let broken = 0;
const base = scratchCopy();
if (runTests(base, true) !== 0) {
  console.error("baseline suite fails on an unmutated copy — fix that first");
  process.exit(2);
}
rmSync(base, { recursive: true, force: true });

for (const m of selected) {
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
console.log(`\n${selected.length - survived - broken}/${selected.length} killed, ${survived} survived, ${broken} broken`);
process.exit(survived || broken ? 1 : 0);
