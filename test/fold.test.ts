// A5 — the fold: determinism (T2), replay-to-N (T8, flat entities), derived
// predicates over now + vantage (B0 G6), and anomaly detection for writes that
// bypassed the write path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { Registry, defaultRegistry } from "../src/tables/registry.ts";
import { loadTable } from "../src/tables/table.ts";
import { WritePath } from "../src/write/write-path.ts";
import { canonicalJson, compareCodeUnits, fold } from "../src/fold/fold.ts";

const STREAM = "tasktree-dash";

async function scriptedLog() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const node = (id: string) => ({ type: "node", id });
  const go = (id: string, event: string, payload: Record<string, unknown> = {}) =>
    wp.submit({ stream: STREAM, kind: "event", entity: node(id), event, payload, actor: "isha" });
  for (const id of ["colors", "loading_state", "font"]) {
    await wp.submit({ stream: STREAM, kind: "create", entity: node(id), actor: "isha" });
  }
  await go("colors", "START"); // seq 4
  await go("colors", "BLOCK"); // seq 5
  await go("colors", "UNBLOCK"); // seq 6
  await go("colors", "COMPLETE", { evidenceRef: "palette.png" }); // seq 7
  await go("loading_state", "START"); // seq 8
  await go("loading_state", "COMPLETE"); // seq 9 — rejected (no evidence)
  await go("font", "START"); // seq 10
  await go("font", "CANCEL"); // seq 11
  return { store, registry };
}

const lifecycleOf = (r: ReturnType<typeof fold>, id: string) => r.entities.find((e) => e.id === id)?.regions.lifecycle;

test("T2 replay determinism: the same log folds to byte-identical state", async () => {
  const { store, registry } = await scriptedLog();
  const events = await store.readAll();
  const a = canonicalJson(fold(events, registry));
  const b = canonicalJson(fold([...events].reverse(), defaultRegistry())); // input order must not matter
  assert.equal(a, b);
});

test("canonicalJson orders keys by code unit, not by locale (byte-identical across machines)", () => {
  // localeCompare would put "a" before "B"; code-unit order puts "B" (0x42) first.
  assert.equal(canonicalJson({ a: 1, B: 2, "é": 3, Z: { y: 1, X: 2 } }), '{"B":2,"Z":{"X":2,"y":1},"a":1,"é":3}');
  assert.deepEqual(["b", "B", "a", "_"].sort(compareCodeUnits), ["B", "_", "a", "b"]);
});

test("T8 replay-to-N: historical state at several N", async () => {
  const { store, registry } = await scriptedLog();
  const events = await store.readAll();
  const at = (n: number) => fold(events, registry, { upToSeq: n });
  assert.equal(at(3).entities.length, 3);
  assert.equal(lifecycleOf(at(3), "colors"), "unstarted");
  assert.equal(lifecycleOf(at(4), "colors"), "in_progress");
  assert.equal(lifecycleOf(at(5), "colors"), "blocked");
  assert.equal(lifecycleOf(at(7), "colors"), "done");
  assert.equal(at(8).rejections.length, 0);
  assert.equal(at(9).rejections.length, 1);
  assert.equal(lifecycleOf(at(9), "loading_state"), "in_progress");
  assert.equal(lifecycleOf(at(11), "font"), "cancelled");
  assert.equal(at(11).lastSeq, 11);
  assert.equal(at(0).entities.length, 0);
});

test("anomaly: an event appended around the write path is flagged, not applied", async () => {
  const { store, registry } = await scriptedLog();
  // Direct append bypasses the guards: COMPLETE with no evidence on loading_state.
  await store.append(STREAM, [{ type: "node.complete", data: { entity: { id: "loading_state" }, payload: {} } }]);
  await store.append(STREAM, [{ type: "garbage", data: {} }]);
  // Not lowercase-kebab: not a name this core ever writes (D1), so not applied either.
  await store.append(STREAM, [{ type: "node.START", data: { entity: { id: "font" }, payload: {} } }]);
  const r = fold(await store.readAll(), registry);
  assert.equal(lifecycleOf(r, "loading_state"), "in_progress");
  assert.deepEqual(
    r.anomalies.map((a) => a.problem),
    [
      "guard-failed: node-lifecycle: in_progress + COMPLETE needs hasEvidenceRef",
      "unrecognised event shape",
      "unrecognised event shape",
    ],
  );
});

test("derived predicates compute from their arguments only: entity time/actor + now + vantage", async () => {
  // A TOY liveness-like predicate (the factory's real one waits on Q-B11): FRESH if
  // the entity's last event is within 60s of `now`, UNKNOWN when this vantage has no
  // basis. It reads nothing but its arguments.
  const node = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
  const store = new SqliteEventStore();
  const registry = new Registry().register({
    type: "node",
    regions: { lifecycle: node },
    derived: {
      liveness: (e, { now, vantage }) => {
        if (vantage === "vm-without-relay" || now === undefined) return "UNKNOWN";
        return Date.parse(now) - Date.parse(e.lastRecordedAt) <= 60_000 ? "FRESH" : "STALE";
      },
      lastActor: (e) => e.lastActor ?? null,
    },
  });
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: STREAM, kind: "create", entity: { type: "node", id: "a" }, actor: "session-7" });
  const events = await store.readAll();
  const t0 = Date.parse(events[0]?.recordedAt ?? "");
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const at = (now: string, vantage?: string) =>
    fold(events, registry, vantage ? { now, vantage } : { now }).derived[STREAM]?.["node:a"];
  assert.equal(at(iso(30_000))?.liveness, "FRESH");
  assert.equal(at(iso(300_000))?.liveness, "STALE");
  assert.equal(at(iso(30_000), "vm-without-relay")?.liveness, "UNKNOWN");
  assert.equal(at(iso(30_000))?.lastActor, "session-7");
  const later = { now: iso(300_000) };
  assert.equal(canonicalJson(fold(events, registry, later)), canonicalJson(fold(events, registry, later)));
});

test("entities are namespaced by stream: the same id in two trees never collides", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const n1 = { type: "node", id: "n1" };
  await wp.submit({ stream: "tasktree-a", kind: "create", entity: n1 });
  await wp.submit({ stream: "tasktree-b", kind: "create", entity: n1 });
  await wp.submit({ stream: "tasktree-b", kind: "event", entity: n1, event: "START" });
  const r = fold(await store.readAll(), registry);
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(
    r.entities.map((e) => `${e.stream}/${e.key}=${e.regions.lifecycle}`),
    ["tasktree-a/node:n1=unstarted", "tasktree-b/node:n1=in_progress"],
  );
});

test("derived results are nested by stream: look-alike stream/id pairs never overwrite each other", async () => {
  const node = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
  const idea = loadTable(new URL("../charts/idea-lifecycle.json", import.meta.url));
  const registry = new Registry()
    .register({ type: "node", regions: { lifecycle: node }, derived: { tag: (e) => `${e.stream}|${e.key}` } })
    .register({ type: "idea", regions: { lifecycle: idea }, derived: { tag: (e) => `${e.stream}|${e.key}` } });
  const store = new SqliteEventStore();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id: "p/idea:z" } });
  await wp.submit({ stream: "s/node:p", kind: "create", entity: { type: "idea", id: "z" } });
  const d = fold(await store.readAll(), registry).derived;
  assert.equal(d["s"]?.["node:p/idea:z"]?.tag, "s|node:p/idea:z");
  assert.equal(d["s/node:p"]?.["idea:z"]?.tag, "s/node:p|idea:z");
});

test("a malformed command.rejected record is an anomaly, not a crash; writes continue", async () => {
  const { store, registry } = await scriptedLog();
  await store.append(STREAM, [{ type: "command.rejected", data: { nonsense: true } }]);
  const r = fold(await store.readAll(), registry);
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0]?.problem, "malformed command.rejected record");
  const wp = new WritePath(store, registry);
  const next = await wp.submit({ stream: STREAM, kind: "event", entity: { type: "node", id: "loading_state" }, event: "BLOCK" });
  assert.equal(next.status, "appended");
});

test("stored event names are lowercase-kebab, mechanically from the table events (D1)", async () => {
  const { store } = await scriptedLog();
  const store2 = new SqliteEventStore();
  const wp = new WritePath(store2, defaultRegistry());
  const n = { type: "node", id: "p" };
  await wp.submit({ stream: STREAM, kind: "create", entity: n });
  await wp.submit({ stream: STREAM, kind: "event", entity: n, event: "START" });
  await wp.submit({ stream: STREAM, kind: "event", entity: n, event: "ADD_CHILD" });
  await wp.submit({ stream: STREAM, kind: "event", entity: n, event: "UNBLOCK" }); // rejected
  assert.deepEqual((await store2.readAll()).map((e) => e.type), ["node.created", "node.start", "node.add-child", "command.rejected"]);
  for (const e of await store.readAll()) assert.match(e.type, /^[a-z]+\.[a-z]+(-[a-z]+)*$/, e.type);
});

test("table event names must be UPPER_SNAKE, and CREATED is reserved", () => {
  const node = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
  const renamed = (from: string, to: string) => {
    const t = JSON.parse(JSON.stringify(node)) as typeof node;
    t.events = t.events.map((e) => (e === from ? to : e));
    t.pairs = t.pairs.map((p) => (p.event === from ? { ...p, event: to } : p));
    return t;
  };
  assert.throws(() => new Registry().register({ type: "x", regions: { l: renamed("START", "start") } }), /must be UPPER_SNAKE/);
  assert.throws(() => new Registry().register({ type: "x", regions: { l: renamed("START", "ADD-CHILD") } }), /must be UPPER_SNAKE/);
  assert.throws(() => new Registry().register({ type: "x", regions: { l: renamed("START", "CREATED") } }), /reserved/);
});

test("createdSeq and lastSeq track the entity's first and latest applied events", async () => {
  const { store, registry } = await scriptedLog();
  const colors = fold(await store.readAll(), registry).entities.find((e) => e.id === "colors");
  assert.equal(colors?.createdSeq, 1);
  assert.equal(colors?.lastSeq, 7);
  assert.equal(colors?.lastActor, "isha");
});

test("rejections carry the original intent, for denial surfacing in the UI", async () => {
  const { store, registry } = await scriptedLog();
  const [rej] = fold(await store.readAll(), registry).rejections;
  assert.equal(rej?.seq, 9);
  assert.equal(rej?.code, "guard-failed");
  assert.deepEqual(rej?.intent, {
    kind: "event", entity: { type: "node", id: "loading_state" }, event: "COMPLETE", payload: {}, actor: "isha",
  });
});
