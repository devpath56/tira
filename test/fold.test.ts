// A5 — the fold: determinism (T2), replay-to-N (T8, flat entities), derived
// predicates over now + vantage (B0 G6), and anomaly detection for writes that
// bypassed the write path.
import "./hermetic.ts";
import { sqliteFile } from "./test-stores.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { Registry, defaultRegistry } from "../src/tables/registry.ts";
import { loadTable } from "../src/tables/table.ts";
import { WritePath } from "../src/write/write-path.ts";
import { canonicalJson, compareCodeUnits, fingerprint, fold } from "../src/fold/fold.ts";
import { run } from "../src/cli/cli.ts";
import { tiraServer } from "../src/serve/server.ts";
import { fxKey } from "../src/write/fxkey.ts";
import { sweep } from "../src/sweep/sweep.ts";
import { loadScenarios } from "../src/scenario/run.ts";
import { filesMatching, sortArguments, srcCode } from "./src-text.ts";

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
  await go("colors", "BLOCK", { reason: "waiting on the token decision" }); // seq 5
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
  const next = await wp.submit({ stream: STREAM, kind: "event", entity: { type: "node", id: "loading_state" }, event: "BLOCK", payload: { reason: "waiting" } });
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
  assert.deepEqual((await store2.readAll()).map((e) => e.type), ["node.born", "node.start", "node.add-child", "command.rejected"]);
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

// ---------- blind round 1: the faults the suite let through (2026-10-20) ----------

test("canonicalJson keeps array order: two orders are two different states, with two different hashes (blind fault 2)", async () => {
  assert.equal(canonicalJson({ b: [2, 1], a: ["z", "y"] }), '{"a":["z","y"],"b":[2,1]}');
  assert.notEqual(canonicalJson(["node:b", "node:a"]), canonicalJson(["node:a", "node:b"]));
  // the same children, born in a different order, fold to a different dump
  const dump = async (order: string[]) => {
    const store = new SqliteEventStore();
    const registry = defaultRegistry();
    const wp = new WritePath(store, registry);
    await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id: "p" }, actor: "isha" });
    for (const id of order) await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id }, actor: "isha", payload: { parent_id: "p" } });
    const r = fold(await store.readStream("s"), registry);
    return { json: canonicalJson(r.entities.find((e) => e.key === "node:p")?.tree?.children), all: canonicalJson(r) };
  };
  const ab = await dump(["a", "b"]);
  const ba = await dump(["b", "a"]);
  assert.equal(ab.json, '["node:a","node:b"]');
  assert.equal(ba.json, '["node:b","node:a"]');
  assert.notEqual(ab.all, ba.all);
});

test("entities are ordered by code unit, never by locale: Zeta (Z = 0x5A) comes before alpha (blind fault 3)", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  for (const id of ["alpha", "Zeta", "beta", "Éclair", "_root"]) await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id }, actor: "isha" });
  const keys = fold(await store.readStream("s"), registry).entities.map((e) => e.key);
  assert.deepEqual(keys, ["node:Zeta", "node:_root", "node:alpha", "node:beta", "node:Éclair"]);
  assert.deepEqual(keys, [...keys].sort(compareCodeUnits));
});

// ---------- the five representation classes, made structural (2026-10-21) ----------
// One test per class, named by its convention id (conventions/conventions.jsonl): the class is
// defined in one place (structure), and every surface the convention binds is checked.

test("canonical-array-order: every canonical surface keeps array order: canonicalJson at any depth, the dump, tira dump --hash, the served page's chip and the fx: key", async () => {
  // structure: one canonical form and one state hash; the CLI's own sha256 takes file bytes only
  const src = srcCode();
  // (the private store hashes session ids so its file can't sign anyone in: not a state hash)
  assert.deepEqual(filesMatching(src, /createHash\(/), ["src/cli/cli.ts", "src/fold/fold.ts", "src/sync/credentials.ts", "src/write/fxkey.ts"]);
  assert.equal((src.get("src/fold/fold.ts")?.match(/createHash\("sha256"\)\.update\(canonicalJson\(r\)\)/g) ?? []).length, 1);
  assert.match(src.get("src/cli/cli.ts") ?? "", /const sha256 = \(bytes: Buffer\)/);
  assert.deepEqual(filesMatching(src, /\bfingerprint\(r\)/), ["src/cli/cli.ts", "src/serve/server.ts"]);
  // canonicalJson: arrays keep their order at every depth, inside objects and inside arrays
  assert.notEqual(canonicalJson({ a: [[1, 2]] }), canonicalJson({ a: [[2, 1]] }));
  assert.notEqual(canonicalJson([{ k: ["x", "y"] }]), canonicalJson([{ k: ["y", "x"] }]));
  assert.equal(canonicalJson({ b: [{ d: [2, 1], c: 0 }], a: [] }), '{"a":[],"b":[{"c":0,"d":[2,1]}]}');
  // JSON's own rules otherwise: a hole, undefined or a function in an array reads null, in an object drops out
  const odd: unknown[] = [];
  odd[1] = 1; // index 0 stays a hole
  odd.push(undefined, () => 0, { u: undefined, f: () => 0, n: null });
  assert.equal(canonicalJson(odd), JSON.stringify(odd));
  // the same children born in two orders: two dumps, two fingerprints, from the CLI and the page
  const dir = mkdtempSync(join(tmpdir(), "tira-canonical-"));
  const born = async (order: string[]) => {
    const db = join(dir, `${order.join("")}.db`);
    const store = new SqliteEventStore({ path: db });
    const registry = defaultRegistry();
    const wp = new WritePath(store, registry);
    await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id: "p" }, actor: "isha" });
    for (const id of order) await wp.submit({ stream: "s", kind: "create", entity: { type: "node", id }, actor: "isha", payload: { parent_id: "p" } });
    const r = fold(await store.readStream("s"), registry);
    const out: string[] = [];
    await run(["--db", db, "--stream", "s", "dump", "--hash"], { out: (l) => out.push(l), err: () => {}, env: {}, openStore: sqliteFile });
    const server = tiraServer({ store, registry, stream: "s", actor: "isha", token: "t0k3n" });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const page = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
    await new Promise<void>((ok) => server.close(() => ok()));
    return { r, cli: out.join("\n"), chip: page.match(/sha256:([0-9a-f]{64})/)?.[1] };
  };
  try {
    const ab = await born(["a", "b"]);
    const ba = await born(["b", "a"]);
    assert.notEqual(canonicalJson(ab.r), canonicalJson(ba.r));
    for (const x of [ab, ba]) {
      const sha = createHash("sha256").update(canonicalJson(x.r)).digest("hex");
      assert.equal(fingerprint(x.r), sha);
      assert.match(x.cli, new RegExp(`^sha256:${sha} `));
      assert.equal(x.chip, sha);
    }
    assert.notEqual(fingerprint(ab.r), fingerprint(ba.r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the fx: key: a payload's array order is part of the transition
  const fx = (blocked_by: string[]) => fxKey({ stream: "s", entity: { type: "brief", id: "b", version: 1 }, event: "CREATED", actor: "orchestrator", payload: { blocked_by } });
  assert.notEqual(fx(["x", "y"]), fx(["y", "x"]));
});

test("code-unit-order: every string ordering in src goes through compareCodeUnits, never locale or an inline comparator: canonical keys (integer-like too), fold stream order, sweep order and the scenario runner", async () => {
  // structure: no locale anywhere; every sort names a code-unit comparator or is numeric (an
  // inline < or > on strings would be a second comparator; typecheck refuses string subtraction)
  const src = srcCode();
  assert.deepEqual(filesMatching(src, /localeCompare|Intl\./), []);
  const named = new Set(["compareCodeUnits", "byKey", "byBirth"]);
  for (const { file, arg } of sortArguments(src)) {
    const where = `${file}: .sort(${arg})`;
    assert.ok(arg !== "", `${where}: a bare sort orders by string conversion`);
    assert.ok(named.has(arg) || (arg.includes("=>") && !/[<>]/.test(arg.replaceAll("=>", ""))), `${where}: not a code-unit or numeric comparator`);
  }
  assert.deepEqual(filesMatching(src, /export function compareCodeUnits/), ["src/fold/view.ts"]);
  // canonical keys: integer-like keys sort as strings too ("10" before "9"), as in any other language
  assert.equal(canonicalJson({ "9": 0, a: 0, "10": 0, Z: 0, "é": 0, _: 0 }), '{"10":0,"9":0,"Z":0,"_":0,"a":0,"é":0}');
  // fold stream order: four streams, each with one node named against its stream's place
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  for (const [stream, id] of [["alpha", "a"], ["9", "c"], ["Zeta", "b"], ["10", "d"]] as const) {
    await wp.submit({ stream, kind: "create", entity: { type: "node", id }, actor: "isha" });
  }
  const r = fold(await store.readAll(), registry);
  assert.deepEqual(r.entities.map((e) => e.key), ["node:d", "node:c", "node:b", "node:a"]); // streams 10, 9, Zeta, alpha
  for (const part of [r.trees, r.derived]) assert.match(canonicalJson(part), /^\{"10":.*\},"9":.*\},"Zeta":.*\},"alpha":/);
  // sweep order: findings by key in code units (Z = 0x5A before a = 0x61)
  for (const id of ["alpha", "Zeta", "_mid"]) await wp.submit({ stream: "one", kind: "create", entity: { type: "node", id }, actor: "isha" });
  const hollow = sweep(await store.readStream("one"), registry, "one").checks.find((c) => c.id === "hollow");
  assert.deepEqual(hollow?.findings.map((f) => f.key), ["node:Zeta", "node:_mid", "node:alpha"]);
  // the scenario runner reads its files in code-unit order
  const dir = mkdtempSync(join(tmpdir(), "tira-order-"));
  try {
    for (const id of ["alpha", "Zeta", "9", "10"]) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id }));
    assert.deepEqual([...loadScenarios(pathToFileURL(dir + "/")).keys()], ["10", "9", "Zeta", "alpha"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
