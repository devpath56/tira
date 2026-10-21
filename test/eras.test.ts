// Versioned rules (ruling 2026-10-20): replay judges each event by the rules of the era it
// was written in, today's rules govern new writes only, and events with no era are the
// legacy era. Era 2 is the first change: a node's BLOCK needs a reason with text. Era 3: a
// brief's VERIFIED_DONE needs a PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry, LEGACY_ERA, Registry, RULES_ERA } from "../src/tables/registry.ts";
import { WritePath, type Command } from "../src/write/write-path.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { loadTable, type Table } from "../src/tables/table.ts";
import type { NewEvent } from "../src/store/types.ts";

const S = "eras";
// A raw event, as an older writer (or a forger) put it in the store: no era means legacy.
const raw = (event: string, id: string, payload: Record<string, unknown> = {}, era?: unknown): NewEvent => ({
  type: `node.${event}`,
  data: { entity: { id }, payload },
  metadata: { actor: "isha", ...(era === undefined ? {} : { era: era as number }) },
});
const lifecycleOf = (r: ReturnType<typeof fold>, id: string) => r.entities.find((e) => e.id === id)?.regions.lifecycle;

test("a legacy log replays under its own era: bare and blank blocks written before the marker fold clean", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  await store.append(S, [raw("born", "a"), raw("block", "a"), raw("born", "b"), raw("block", "b", { reason: "   " })]);
  const r = fold(await store.readStream(S), registry);
  assert.deepEqual(r.anomalies, []);
  assert.equal(lifecycleOf(r, "a"), "blocked");
  assert.equal(lifecycleOf(r, "b"), "blocked");
});

test("the same events stamped with today's era are refused on replay: a writer can't claim the new era and skip its rules", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  await store.append(S, [raw("born", "a", {}, RULES_ERA), raw("block", "a", {}, RULES_ERA), raw("born", "b", {}, RULES_ERA), raw("block", "b", { reason: "   " }, RULES_ERA)]);
  const r = fold(await store.readStream(S), registry);
  assert.deepEqual(r.anomalies.map((a) => [a.seq, a.problem]), [
    [2, "guard-failed: node-lifecycle: unstarted + BLOCK needs hasReasonText"],
    [4, "guard-failed: node-lifecycle: unstarted + BLOCK needs hasReasonText"],
  ]);
  assert.equal(lifecycleOf(r, "a"), "unstarted");
});

test("new writes are stamped with today's era and judged by today's rules; one log can cross eras mid-life", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await store.append(S, [raw("born", "a"), raw("block", "a")]); // legacy: a bare block was allowed
  const send = (event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "a" }, event, actor: "isha", payload });
  assert.equal((await send("UNBLOCK")).status, "appended");
  assert.equal((await send("BLOCK")).status, "rejected"); // today: a block needs a reason
  assert.equal((await send("BLOCK", { reason: "waiting on design" })).status, "appended");
  const events = await store.readStream(S);
  assert.deepEqual(events.map((e) => [e.type, e.metadata.era]), [
    ["node.born", undefined], ["node.block", undefined], // legacy
    ["node.unblock", RULES_ERA], ["command.rejected", RULES_ERA], ["node.block", RULES_ERA],
  ]);
  const r = fold(events, registry);
  assert.deepEqual(r.anomalies, []);
  assert.equal(lifecycleOf(r, "a"), "blocked");
  // tira's own closes are stamped too: they are decided under today's rules like any write
  const s2 = new SqliteEventStore();
  const w2 = new WritePath(s2, registry);
  const node = (id: string, parent_id?: string) => w2.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const act = (id: string, event: string, payload: Record<string, unknown> = {}) => w2.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await node("p");
  await node("c", "p");
  await node("next");
  await act("c", "START");
  await act("c", "COMPLETE", { evidenceRef: "e" });
  const moved = await act("next", "START"); // work moves on: tira closes p first
  assert.ok(moved.status === "appended" && (moved.closedByTira ?? []).length === 1);
  const byTira = (await s2.readStream(S)).filter((e) => e.metadata.actor === "tira");
  assert.ok(byTira.length > 0 && byTira.every((e) => e.metadata.era === RULES_ERA));
});

test("an era this build doesn't know is an anomaly, never a guess", async () => {
  for (const era of [RULES_ERA + 1, 0, "2", 1.5, null]) {
    const store = new SqliteEventStore();
    await store.append(S, [raw("born", "a", {}, era)]);
    const r = fold(await store.readStream(S), defaultRegistry());
    assert.equal(r.anomalies.length, 1, String(era));
    assert.match(r.anomalies[0]?.problem ?? "", /^written under rules era .+, which this build doesn't know \(eras 1 to 3\)$/);
    assert.equal(r.entities.length, 0, String(era));
  }
});

test("the legacy era's table is frozen: the task table as first built, differing from today's only in BLOCK's guard and the reason check", () => {
  const path = new URL("../charts/eras/node-lifecycle.era1.json", import.meta.url);
  // pinned: this file must never change, or old logs would replay under different rules
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), "73bea43928c020749bf020ecd79d1c9ed46bad196743fb5c820fc141f2e1a7f2");
  const legacy = loadTable(path);
  const today = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
  const diff = today.pairs
    .map((p, i) => [p, legacy.pairs[i]] as const)
    .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b))
    .map(([a, b]) => `${a.from}+${a.event}: ${b?.guard ?? "no guard"} -> ${a.guard ?? "no guard"}`);
  assert.deepEqual(diff, ["unstarted+BLOCK: no guard -> hasReasonText", "in_progress+BLOCK: no guard -> hasReasonText", "done+REOPEN: hasReason -> hasReasonText"]);
  const registry = defaultRegistry();
  assert.equal(registry.era, RULES_ERA);
  assert.equal(registry.resolve("node", "BLOCK", LEGACY_ERA)?.table, registry.get("node")?.eras?.[LEGACY_ERA]?.lifecycle);
  assert.equal(registry.resolve("node", "BLOCK")?.table, registry.get("node")?.regions.lifecycle); // new writes: today's
  assert.equal(registry.resolve("brief", "DISPATCHED", LEGACY_ERA)?.table, registry.resolve("brief", "DISPATCHED")?.table); // unchanged tables span every era
});

// A brief verified done, built through today's dispatcher, then stored as an older writer (or a
// forger) would have: the era set as given, and the brief's receiver carrying `verdict`.
async function briefLog(era: unknown, verdict: unknown): Promise<NewEvent[]> {
  const store = new SqliteEventStore();
  const d = new Dispatcher(store, defaultRegistry());
  const b = { type: "brief", id: "b", version: 1 };
  const drop = { type: "drop", id: "b", version: 1 };
  for (const cmd of [
    { kind: "create", entity: { type: "session", id: "s1" }, actor: "s1" },
    { kind: "create", entity: b, actor: "orchestrator" },
    { kind: "event", entity: b, event: "DISPATCHED", actor: "orchestrator" },
    { kind: "event", entity: b, event: "CLAIMED", actor: "s1", payload: { session: "s1" } },
    { kind: "create", entity: drop, actor: "s1" },
    { kind: "event", entity: drop, event: "VERIFIED", actor: "orchestrator", payload: { done_test_result: "PASS" } },
  ]) await d.submit({ stream: S, ...cmd } as Command);
  return (await store.readStream(S)).map(({ eventId, type, data, metadata: { era: _today, ...metadata } }) => ({
    eventId,
    type,
    data: type === "brief.verified-done" ? { ...data, payload: { done_test_result: verdict } } : data,
    metadata: { ...metadata, ...(era === undefined ? {} : { era: era as number }) },
  }));
}
const outcomeOf = (r: ReturnType<typeof fold>) => r.entities.find((e) => e.key === "brief:b@1")?.regions.outcome;

test("a brief done-verified without a PASS, written in eras 1 and 2, replays as it did: the outcome table then took the dispatcher's word", async () => {
  for (const era of [undefined, 2]) {
    const store = new SqliteEventStore();
    await store.append(S, await briefLog(era, "FAIL"));
    const r = fold(await store.readStream(S), defaultRegistry());
    assert.deepEqual(r.anomalies, [], String(era));
    assert.equal(outcomeOf(r), "done-verified", String(era));
  }
});

test("the same log stamped with era 3 is refused on replay: a brief is done-verified only on a PASS", async () => {
  const store = new SqliteEventStore();
  const events = await briefLog(RULES_ERA, "FAIL");
  await store.append(S, events);
  const r = fold(await store.readStream(S), defaultRegistry());
  const at = events.findIndex((e) => e.type === "brief.verified-done") + 1;
  assert.deepEqual(r.anomalies.map((a) => [a.seq, a.problem]), [[at, "guard-failed: brief-outcome: dropped-unverified + VERIFIED_DONE needs dispatcherWithPass"]]);
  assert.equal(outcomeOf(r), "dropped-unverified");
  // with the PASS H3 carries, era 3 replays clean
  const ok = new SqliteEventStore();
  await ok.append(S, await briefLog(RULES_ERA, "PASS"));
  const r2 = fold(await ok.readStream(S), defaultRegistry());
  assert.deepEqual(r2.anomalies, []);
  assert.equal(outcomeOf(r2), "done-verified");
});

test("the brief outcome table of eras 1 and 2 is frozen: byte for byte the signed table, differing from today's only in VERIFIED_DONE's guard", () => {
  const path = new URL("../charts/eras/brief-outcome.era1.json", import.meta.url);
  // pinned: this file must never change, or old logs would replay under different rules
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), "7b1ac354fa79784b63c29863de05e16431d697d03b9261313539ed74a33efa27");
  const before = loadTable(path);
  const today = loadTable(new URL("../charts/brief-outcome.json", import.meta.url));
  const diff = today.pairs
    .map((p, i) => [p, before.pairs[i]] as const)
    .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b))
    .map(([a, b]) => `${a.from}+${a.event}: ${b?.guard ?? "no guard"} -> ${a.guard ?? "no guard"}`);
  assert.deepEqual(diff, ["dropped-unverified+VERIFIED_DONE: fromDispatcher -> dispatcherWithPass"]);
  const registry = defaultRegistry();
  const frozen = registry.get("brief")?.eras?.[LEGACY_ERA]?.outcome;
  assert.ok(frozen);
  for (const era of [LEGACY_ERA, 2]) {
    assert.equal(registry.resolve("brief", "VERIFIED_DONE", era)?.table, frozen, String(era));
    assert.equal(registry.resolve("brief", "DROP_WRITTEN", era)?.table, frozen, String(era)); // the whole region, not one event
  }
  assert.equal(registry.resolve("brief", "VERIFIED_DONE")?.table, registry.get("brief")?.regions.outcome); // new writes: today's
  assert.equal(registry.resolve("brief", "VERIFIED_DONE", 3)?.table, registry.get("brief")?.regions.outcome);
});

test("an earlier era may change which moves are allowed, never the shape; and only an earlier era can be listed", () => {
  const today = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
  const reg = (eras: Record<number, Record<string, Table>>) => () => new Registry().register({ type: "node", createdAs: "BORN", regions: { lifecycle: today }, eras });
  assert.doesNotThrow(reg({ [LEGACY_ERA]: { lifecycle: { ...today, pairs: today.pairs.map(({ guard: _unguarded, ...p }) => p) } } }));
  assert.throws(reg({ [LEGACY_ERA]: { lifecycle: { ...today, states: [...today.states, "parked"] } } }), /must keep today's states, events and initial state/);
  assert.throws(reg({ [LEGACY_ERA]: { lifecycle: { ...today, initial: "blocked" } } }), /must keep today's states, events and initial state/);
  assert.throws(reg({ [RULES_ERA]: { lifecycle: today } }), /must be an earlier era/);
  assert.throws(reg({ [LEGACY_ERA]: { other: today } }), /region other is not a region/);
});

test("the page labels legacy events in the history, and counts them in Activity", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await store.append(S, [raw("born", "a"), raw("block", "a")]);
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "a" }, event: "UNBLOCK", actor: "isha" });
  const events = await store.readStream(S);
  const html = renderHtml(fold(events, registry), S, "h", events);
  const heads = [...html.matchAll(/<span class="ev-what">(node\.[a-z-]+)<\/span>[^]*?<span class="ev-seq">/g)].map((m) => [m[1], m[0].includes('class="legacy"')]);
  assert.ok(heads.length > 0);
  for (const [what, legacy] of heads) assert.equal(legacy, what !== "node.unblock", String(what));
  assert.match(html, /<h3>Newest first · 3 events · 0 rejected · 2 legacy<\/h3>/);
  const fresh = new SqliteEventStore();
  await new WritePath(fresh, registry).submit({ stream: S, kind: "create", entity: { type: "node", id: "a" }, actor: "isha" });
  const fe = await fresh.readStream(S);
  assert.ok(!renderHtml(fold(fe, registry), S, "h", fe).includes('class="legacy"'));
});
