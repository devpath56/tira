// B3 divergence watchdog: the differ's state table cell by cell, its invariants (input order
// and timestamps never read, ids never minted, code-unit order), round 1 of the blind
// fixture, and the `tira divergence` command's exit codes, refusals and run log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { divergence, type DivergenceReport, type FactoryRecord, type Verdict } from "../src/divergence/divergence.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import type { StoredEvent } from "../src/store/types.ts";
import { run } from "../src/cli/cli.ts";
import type { Manifest } from "../scripts/b3-fixture.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/b3/", import.meta.url));
const FACTORY = join(FIXTURE, "factory-state.jsonl");
const TIRA_LOG = join(FIXTURE, "tira-log.jsonl");
const jsonl = <T>(f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as T);
const manifest = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")) as Manifest;
const expected = () => Object.fromEntries(manifest().verdicts.map((m) => [m.event_id, m.verdict]));

// --- builders ------------------------------------------------------------------------------

let n = 0;
const fac = (event_id: string, kind: string, type: string, id: string): FactoryRecord => ({
  transition_kind: kind, entity_type: type, entity_id: id, ts: `2026-10-20T09:${String(n++ % 60).padStart(2, "0")}:00Z`, outcome: "transition", actor: "a", event_id,
});
const split = (id: string) => {
  const at = id.indexOf("@");
  return at < 0 ? { id } : { id: id.slice(0, at), version: Number(id.slice(at + 1)) };
};
let seq = 0;
const ev = (eventId: string, type: string, id: string, extra: Partial<StoredEvent> = {}): StoredEvent => ({
  eventId, stream: "s", seq: ++seq, streamRevision: seq - 1, type, data: { entity: split(id), payload: {} }, metadata: { actor: "a" }, recordedAt: "2026-10-20T20:00:00.000Z", ...extra,
});
const rejected = (eventId: string, type: string, id: string, event: string | undefined): StoredEvent => ({
  ...ev(eventId, "command.rejected", id),
  data: { intent: { kind: event === undefined ? "create" : "event", entity: { type, ...split(id) }, ...(event ? { event } : {}), payload: {}, actor: "a" }, reason: { code: "unknown-entity", detail: id } },
});
const diff = (factory: FactoryRecord[], tira: StoredEvent[]): DivergenceReport =>
  divergence({ factory, tira, factorySnapshot: { snapshot: "test", pin: "unpinned" }, stream: "s" });
const verdictOf = (factory: FactoryRecord[], tira: StoredEvent[], id: string): Verdict | undefined => diff(factory, tira).verdicts[id];

// Births that make "b1@1" (brief) and "s1" (session) born in the factory file, tira's, or both.
const bornF = [fac("fx:birth-b1", "CREATED", "brief", "b1@1")];
const bornT = [ev("fx:birth-b1", "brief.created", "b1@1")];

// --- the state table, cell by cell -----------------------------------------------------------

test("state table: factory 1, tira 1, same entity and kind, born -> OK", () => {
  assert.equal(verdictOf([...bornF, fac("fx:e", "DISPATCHED", "brief", "b1@1")], [...bornT, ev("fx:e", "brief.dispatched", "b1@1")], "fx:e"), "OK");
});

test("state table: born here (factory only), there (tira only) or both all count as born", () => {
  const f = [fac("fx:e", "MISSING_IS_FINE", "brief", "b1@1")];
  // factory 1, tira 0
  assert.equal(verdictOf([...bornF, ...f], [], "fx:e"), "MISSING", "born in the factory file only");
  assert.equal(verdictOf([...bornF.map((r) => ({ ...r, event_id: "fx:fb" })), ...f], [ev("fx:tb", "brief.created", "b1@1")], "fx:e"), "MISSING", "born in both, under different ids");
  // factory 0, tira 1
  assert.equal(verdictOf([], [ev("fx:tb", "brief.created", "b1@1"), ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "PHANTOM", "born in tira only");
  assert.equal(verdictOf(bornF, [ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "PHANTOM", "born in the factory file only");
});

test("state table: factory 1, tira 0 -> MISSING when born, ORPHAN when born in neither", () => {
  assert.equal(verdictOf([...bornF, fac("fx:e", "DISPATCHED", "brief", "b1@1")], bornT, "fx:e"), "MISSING");
  assert.equal(verdictOf([fac("fx:e", "DISPATCHED", "brief", "zz@1")], [], "fx:e"), "ORPHAN");
});

test("state table: factory 0, tira 1 -> PHANTOM when born, ORPHAN when born in neither", () => {
  assert.equal(verdictOf(bornF, [...bornT, ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "PHANTOM");
  assert.equal(verdictOf([], [ev("fx:e", "brief.claimed", "zz@1")], "fx:e"), "ORPHAN");
});

test("state table: a birth is never ORPHAN, on either side alone", () => {
  assert.equal(verdictOf([fac("fx:e", "NAMED", "session", "s9")], [], "fx:e"), "MISSING");
  assert.equal(verdictOf([], [ev("fx:e", "session.named", "s9")], "fx:e"), "PHANTOM");
  for (const kind of ["NAMED", "CREATED", "REVISED", "FILED"]) {
    assert.equal(verdictOf([fac("fx:e", kind, "drop", "d@2")], [], "fx:e"), "MISSING", kind);
  }
  assert.equal(verdictOf([fac("fx:e", "DISPATCHED", "drop", "d@2")], [], "fx:e"), "ORPHAN", "a non-birth kind gives no birth");
});

test("state table: factory 2+ or tira 2+ -> DUPLICATE, whatever else holds", () => {
  const twice = [fac("fx:e", "DISPATCHED", "brief", "b1@1"), fac("fx:e", "DISPATCHED", "brief", "b1@1")];
  assert.equal(verdictOf([...bornF, ...twice], [...bornT, ev("fx:e", "brief.dispatched", "b1@1")], "fx:e"), "DUPLICATE", "factory 2, tira 1");
  assert.equal(verdictOf([...bornF, ...twice], bornT, "fx:e"), "DUPLICATE", "factory 2, tira 0");
  assert.equal(verdictOf(twice, [], "fx:e"), "DUPLICATE", "over ORPHAN: born in neither");
  assert.equal(verdictOf(bornF, [...bornT, ev("fx:e", "brief.claimed", "b1@1"), ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "DUPLICATE", "tira 2, factory 0");
  assert.equal(
    verdictOf([...bornF, fac("fx:e", "CLAIMED", "brief", "b2@1"), fac("fx:e", "CLAIMED", "brief", "b2@1")], [...bornT, ev("fx:e", "brief.claimed", "b1@1")], "fx:e"),
    "DUPLICATE",
    "over WRONG-ENTITY",
  );
  assert.equal(verdictOf([...bornF, fac("fx:e", "CLAIMED", "brief", "b1@1"), fac("fx:e", "CLAIMED", "brief", "b1@1"), fac("fx:e", "CLAIMED", "brief", "b1@1")], bornT, "fx:e"), "DUPLICATE", "factory 3");
});

test("state table: factory 1, tira 1, different entity -> WRONG-ENTITY, over ORPHAN", () => {
  assert.equal(verdictOf([...bornF, fac("fx:e", "CLAIMED", "brief", "b2@1")], [...bornT, ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "WRONG-ENTITY");
  assert.equal(verdictOf([fac("fx:e", "CLAIMED", "brief", "x@1")], [ev("fx:e", "brief.claimed", "y@1")], "fx:e"), "WRONG-ENTITY", "both unborn");
  assert.equal(verdictOf([...bornF, fac("fx:e", "CLAIMED", "brief", "b1@2")], [...bornT, ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "WRONG-ENTITY", "the version is part of the entity");
  assert.equal(verdictOf([...bornF, fac("fx:e", "CLAIMED", "drop", "b1@1")], [...bornT, ev("fx:e", "brief.claimed", "b1@1")], "fx:e"), "WRONG-ENTITY", "the type is part of the entity");
});

test("state table: a kind mismatch on the same entity is WRONG-ENTITY (there is no WRONG-KIND)", () => {
  const r = diff([...bornF, fac("fx:e", "CLAIMED", "brief", "b1@1")], [...bornT, ev("fx:e", "brief.verified", "b1@1")]);
  assert.equal(r.verdicts["fx:e"], "WRONG-ENTITY");
  assert.ok(!Object.values(r.verdicts).some((v) => (v as string) === "WRONG-KIND"));
  assert.equal(verdictOf([...bornF, fac("fx:e", "ADD_CHILD", "brief", "b1@1")], [...bornT, ev("fx:e", "brief.add-child", "b1@1")], "fx:e"), "OK", "stored names map to table names");
});

test("command.rejected: not an applied event — MISSING when born, ORPHAN when not, never a birth", () => {
  assert.equal(verdictOf([...bornF, fac("fx:e", "DISPATCHED", "brief", "b1@1")], [...bornT, rejected("fx:e", "brief", "b1@1", "DISPATCHED")], "fx:e"), "MISSING");
  assert.equal(verdictOf([fac("fx:e", "DISPATCHED", "brief", "zz@1")], [rejected("fx:e", "brief", "zz@1", "DISPATCHED")], "fx:e"), "ORPHAN");
  // a rejected create gives no birth: the later event on that entity stays ORPHAN
  const r = diff([fac("fx:d", "DISPATCHED", "brief", "q@1")], [rejected("fx:c", "brief", "q@1", undefined)]);
  assert.equal(r.verdicts["fx:d"], "ORPHAN");
  assert.equal(r.verdicts["fx:c"], "ORPHAN");
  // nor does a rejected command whose event is a birth name
  const named = diff([fac("fx:v", "VERIFIED", "drop", "d@1")], [rejected("fx:f", "drop", "d@1", "FILED")]);
  assert.equal(named.verdicts["fx:v"], "ORPHAN");
  assert.equal(named.verdicts["fx:f"], "ORPHAN");
  // tira refused an fx: command the factory never committed, on a born entity
  assert.equal(verdictOf(bornF, [...bornT, rejected("fx:e", "brief", "b1@1", "CLAIMED")], "fx:e"), "PHANTOM");
  // the refused command named another entity than the factory's record
  assert.equal(verdictOf([...bornF, fac("fx:e", "DISPATCHED", "brief", "b1@1")], [...bornT, rejected("fx:e", "brief", "b2@1", "DISPATCHED")], "fx:e"), "WRONG-ENTITY");
});

test("a table event called REJECTED is applied, unlike command.rejected", () => {
  assert.equal(verdictOf([...bornF, fac("fx:e", "REJECTED", "brief", "b1@1")], [...bornT, ev("fx:e", "brief.rejected", "b1@1")], "fx:e"), "OK");
});

// --- invariants --------------------------------------------------------------------------------

test("non-fx: tira events are ignored (but still advance atSeq)", () => {
  const tail = ev("evt-2", "brief.evidence", "zz@9");
  const r = diff(bornF, [tail, ...bornT, ev("dispatcher-1", "brief.claimable", "b1@1", { seq: 1 })]);
  assert.deepEqual(Object.keys(r.verdicts), ["fx:birth-b1"]);
  assert.equal(r.population.tiraFxEvents, 1);
  assert.equal(r.coordinates.tira.atSeq, tail.seq, "the highest seq read, wherever it sits in the input");
});

test("the report never mints or re-keys an id: its keys are the union of the inputs' fx: ids", () => {
  const factory = jsonl<FactoryRecord>(FACTORY);
  const tira = jsonl<StoredEvent>(TIRA_LOG);
  const r = diff(factory, tira);
  const union = new Set([...factory.map((x) => x.event_id), ...tira.filter((e) => e.eventId.startsWith("fx:")).map((e) => e.eventId)]);
  assert.deepEqual(new Set(Object.keys(r.verdicts)), union);
  assert.equal(r.population.ids, union.size);
});

test("verdicts and findings sort by event id in code-unit order, not locale order", () => {
  const ids = ["fx:b", "fx:B", "fx:a", "fx:_", "fx:é", "fx:A"];
  const r = diff(ids.map((id) => fac(id, "NAMED", "session", `s-${id}`)), []);
  const codeUnit = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(Object.keys(r.verdicts), codeUnit);
  assert.deepEqual(r.findings.map((f) => f.event_id), codeUnit);
  assert.notDeepEqual(codeUnit, [...ids].sort((a, b) => a.localeCompare(b)), "the fixture must tell the two orders apart");
});

// A seeded Fisher-Yates, so a failure reproduces.
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

test("shuffled input: the same records, lines shuffled, give the identical verdict map", () => {
  const factory = jsonl<FactoryRecord>(FACTORY);
  const tira = jsonl<StoredEvent>(TIRA_LOG);
  const base = diff(factory, tira);
  for (const seed of [1, 7, 42, 2026, 99991]) {
    const r = diff(shuffled(factory, seed), shuffled(tira, seed + 1));
    assert.deepEqual(r.verdicts, base.verdicts, `seed ${seed}`);
    assert.deepEqual(JSON.stringify(r), JSON.stringify(base), `seed ${seed}: the whole report, byte for byte`);
  }
  const reversed = diff([...factory].reverse(), [...tira].reverse());
  assert.deepEqual(reversed.verdicts, base.verdicts, "reversed");
});

test("timestamps are never compared: rewriting every ts and recordedAt changes nothing", () => {
  const factory = jsonl<FactoryRecord>(FACTORY);
  const tira = jsonl<StoredEvent>(TIRA_LOG);
  const base = diff(factory, tira);
  const moved = diff(factory.map((r, i) => ({ ...r, ts: `1999-01-01T00:00:${String(59 - (i % 60)).padStart(2, "0")}Z` })), tira.map((e) => ({ ...e, recordedAt: "2100-01-01T00:00:00.000Z" })));
  assert.deepEqual(JSON.stringify(moved), JSON.stringify(base));
});

// --- round 1 of the blind fixture ------------------------------------------------------------------

test("fixture round 1: 47/47 against the manifest, every plant by its own kind, counts and population", () => {
  const factory = jsonl<FactoryRecord>(FACTORY);
  const tira = jsonl<StoredEvent>(TIRA_LOG);
  const r = divergence({ factory, tira, factorySnapshot: { snapshot: "x", pin: "git" }, stream: "factory-b3" });
  assert.deepEqual(r.verdicts, expected());
  assert.deepEqual(r.counts, { OK: 39, MISSING: 2, PHANTOM: 2, "WRONG-ENTITY": 2, DUPLICATE: 1, ORPHAN: 1 });
  assert.deepEqual(r.population, { factoryRecords: factory.length, tiraFxEvents: tira.filter((e) => e.eventId.startsWith("fx:")).length, ids: 47 });
  assert.deepEqual(r.coordinates.tira, { stream: "factory-b3", atSeq: Math.max(...tira.map((e) => e.seq)) });
  assert.equal(r.findings.length, 8);
  assert.equal(r.severityPolicy, "v1");
  for (const f of r.findings) assert.ok(f.detail.length > 0, f.event_id);
});

// --- the command ---------------------------------------------------------------------------------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "tira-div-"));
  const runLog = join(dir, "run-log.jsonl");
  const tira = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["--db", join(dir, "t.db"), ...argv], { out: (l) => out.push(l), err: (l) => err.push(l), env: { TIRA_DIVERGENCE_LOG: runLog } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const write = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  return { dir, runLog, tira, write, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

// The fixture's tira side appended to a real store under one stream, for live runs.
async function seedStore(dir: string, stream: string) {
  const store = new SqliteEventStore({ path: join(dir, "t.db") });
  try {
    for (const e of jsonl<StoredEvent>(TIRA_LOG)) await store.append(stream, [{ eventId: e.eventId, type: e.type, data: e.data, metadata: e.metadata }]);
  } finally {
    store.close();
  }
}

test("tira divergence --tira-log --json: the per-id verdict map, exit 0 with divergences present", async () => {
  const s = sandbox();
  try {
    const r = await s.tira("divergence", "--factory", FACTORY, "--tira-log", TIRA_LOG, "--json");
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out) as DivergenceReport;
    assert.deepEqual(report.verdicts, expected());
    assert.ok(report.findings.length > 0);
    assert.equal(report.coordinates.tira.stream, "factory-b3");
    assert.ok(report.coordinates.factory.snapshot.length > 0);
    assert.ok(!existsSync(s.runLog), "a fixture run appends nothing to the run log");
  } finally {
    s.done();
  }
});

test("tira divergence: human output names coordinates, population, every count and each finding", async () => {
  const s = sandbox();
  try {
    const r = await s.tira("divergence", "--factory", FACTORY, "--tira-log", TIRA_LOG);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /tira stream factory-b3 at seq 65/);
    assert.match(r.out, /read 46 factory record\(s\) · 45 tira fx: event\(s\) · 47 event id\(s\) in the union/);
    assert.match(r.out, /OK 39 · MISSING 2 · PHANTOM 2 · WRONG-ENTITY 2 · DUPLICATE 1 · ORPHAN 1/);
    assert.match(r.out, /findings \(8\)/);
    assert.match(r.out, /ORPHAN\s+fx:ab0d3a84\S+\s+DISPATCHED brief:zz@1: brief:zz@1 is born in neither file/);
    assert.match(r.out, /severity policy v1/);
  } finally {
    s.done();
  }
});

test("tira divergence: a copy git does not hold is reported unpinned, with its bytes' sha256", async () => {
  const s = sandbox();
  try {
    const copy = join(s.dir, "factory.jsonl");
    copyFileSync(FACTORY, copy);
    const r = await s.tira("divergence", "--factory", copy, "--tira-log", TIRA_LOG, "--json");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((JSON.parse(r.out) as DivergenceReport).coordinates.factory, { snapshot: sha(FACTORY), pin: "unpinned", file: copy });
  } finally {
    s.done();
  }
});

test("live run: no sidecar PROCEEDS and records the sha256 of the bytes it read (Q3 / D-Po2)", async () => {
  const s = sandbox();
  try {
    await seedStore(s.dir, "live");
    const copy = join(s.dir, "factory.jsonl");
    copyFileSync(FACTORY, copy);
    const r = await s.tira("divergence", "--factory", copy, "--stream", "live", "--json");
    assert.equal(r.code, 0, r.err);
    // independent of the CLI's own helper: hash the file's bytes here, by hand
    const independent = createHash("sha256").update(readFileSync(copy)).digest("hex");
    assert.match(independent, /^[0-9a-f]{64}$/);
    const report = JSON.parse(r.out) as DivergenceReport;
    assert.deepEqual(report.coordinates.factory, { snapshot: independent, pin: "sha256", file: copy });
    const rows = jsonl<Record<string, unknown>>(s.runLog);
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as Record<string, unknown>).factorySnapshot, independent, "run-log hash == sha256 of the input file");
    // different bytes, different recorded hash: the value follows what was read
    writeFileSync(copy, `${readFileSync(copy, "utf8")}\n`);
    assert.equal((await s.tira("divergence", "--factory", copy, "--stream", "live")).code, 0);
    const second = jsonl<Record<string, unknown>>(s.runLog)[1] as Record<string, unknown>;
    assert.equal(second.factorySnapshot, createHash("sha256").update(readFileSync(copy)).digest("hex"));
    assert.notEqual(second.factorySnapshot, independent);
  } finally {
    s.done();
  }
});

test("live run: a sidecar that disagrees is REFUSED (exit 1) as an integrity mismatch, and nothing is logged", async () => {
  const s = sandbox();
  try {
    await seedStore(s.dir, "live");
    const copy = join(s.dir, "factory.jsonl");
    copyFileSync(FACTORY, copy);
    for (const text of [`${"0".repeat(64)}\n`, "not a hash\n", ""]) {
      s.write("factory.jsonl.sha256", text);
      const r = await s.tira("divergence", "--factory", copy, "--stream", "live");
      assert.equal(r.code, 1, JSON.stringify(text));
      assert.match(r.err, /integrity mismatch: factory snapshot .*factory\.jsonl does not match factory\.jsonl\.sha256/);
      assert.ok(r.err.includes(sha(copy)), "the refusal names the computed hash");
      assert.equal(r.out, "", "a refusal prints no report");
    }
    rmSync(join(s.dir, "factory.jsonl.sha256"));
    mkdirSync(join(s.dir, "factory.jsonl.sha256"));
    const unreadable = await s.tira("divergence", "--factory", copy, "--stream", "live");
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.err, /integrity mismatch: .*factory\.jsonl\.sha256 is present but unreadable/);
    assert.ok(!existsSync(s.runLog));
  } finally {
    s.done();
  }
});

test("live run: an unreadable input cannot be hashed and is REFUSED (exit 1)", async () => {
  const s = sandbox();
  try {
    await seedStore(s.dir, "live");
    const r = await s.tira("divergence", "--factory", join(s.dir, "absent.jsonl"), "--stream", "live");
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot read factory file .*absent\.jsonl, so it cannot be hashed/);
    assert.ok(!existsSync(s.runLog));
  } finally {
    s.done();
  }
});

test("live run: a matching sidecar proceeds silently, exit 0, one run-log row per run", async () => {
  const s = sandbox();
  try {
    await seedStore(s.dir, "live");
    const copy = join(s.dir, "factory.jsonl");
    copyFileSync(FACTORY, copy);
    s.write("factory.jsonl.sha256", `${sha(copy)}  factory.jsonl\n`);
    const r = await s.tira("divergence", "--factory", copy, "--stream", "live", "--json");
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out) as DivergenceReport;
    assert.deepEqual(report.verdicts, expected(), "the store adapter feeds the same differ path as the log file");
    assert.deepEqual(report.coordinates.factory, { snapshot: sha(copy), pin: "sha256", file: copy });
    assert.deepEqual(report.coordinates.tira, { stream: "live", atSeq: 65 });
    const rows = jsonl<Record<string, unknown>>(s.runLog);
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["atSeq", "counts", "factorySnapshot", "population", "severityPolicy", "stream", "ts"]);
    assert.deepEqual([row.factorySnapshot, row.stream, row.atSeq, row.severityPolicy], [sha(copy), "live", 65, "v1"]);
    assert.deepEqual(row.counts, report.counts);
    assert.deepEqual(row.population, report.population);
    assert.equal((await s.tira("divergence", "--factory", copy, "--stream", "live")).code, 0);
    assert.equal(jsonl(s.runLog).length, 2);
    // a matching sidecar written in upper case is accepted, and the recorded value is still the
    // run's own hash of the bytes, never the sidecar's text
    s.write("factory.jsonl.sha256", `${sha(copy).toUpperCase()}\n`);
    const upper = await s.tira("divergence", "--factory", copy, "--stream", "live", "--json");
    assert.equal(upper.code, 0, upper.err);
    assert.equal((JSON.parse(upper.out) as DivergenceReport).coordinates.factory.snapshot, sha(copy));
    assert.equal((jsonl<Record<string, unknown>>(s.runLog)[2] as Record<string, unknown>).factorySnapshot, sha(copy));
  } finally {
    s.done();
  }
});

test("live run: no stream, or an empty one, is a command error, never a zero report", async () => {
  const s = sandbox();
  try {
    const copy = join(s.dir, "factory.jsonl");
    copyFileSync(FACTORY, copy);
    s.write("factory.jsonl.sha256", sha(copy));
    const none = await s.tira("divergence", "--factory", copy);
    assert.equal(none.code, 1);
    assert.match(none.err, /pass --stream/);
    const empty = await s.tira("divergence", "--factory", copy, "--stream", "nothing-here");
    assert.equal(empty.code, 1);
    assert.match(empty.err, /stream nothing-here has no events/);
    assert.ok(!existsSync(s.runLog));
  } finally {
    s.done();
  }
});

test("malformed, empty or unreadable input exits 1 and names the offending line", async () => {
  const s = sandbox();
  try {
    const good = readFileSync(FACTORY, "utf8").split("\n");
    const cases: [string, string[], RegExp][] = [
      ["no --factory", ["--tira-log", TIRA_LOG], /usage: tira divergence --factory FILE/],
      ["missing factory file", ["--factory", join(s.dir, "absent.jsonl"), "--tira-log", TIRA_LOG], /cannot read factory file/],
      ["missing tira log", ["--factory", FACTORY, "--tira-log", join(s.dir, "absent.jsonl")], /cannot read tira log/],
      ["empty factory file", ["--factory", s.write("empty.jsonl", "\n\n"), "--tira-log", TIRA_LOG], /factory file .*empty\.jsonl has no records/],
      ["empty tira log", ["--factory", FACTORY, "--tira-log", s.write("empty-log.jsonl", "")], /tira log .*empty-log\.jsonl has no records/],
      ["bad JSON on line 3", ["--factory", s.write("bad.jsonl", [good[0], good[1], "{oops", good[3]].join("\n")), "--tira-log", TIRA_LOG], /bad\.jsonl line 3: not valid JSON/],
      ["array line", ["--factory", s.write("arr.jsonl", [good[0], "[1,2]"].join("\n")), "--tira-log", TIRA_LOG], /arr\.jsonl line 2: not a JSON object/],
      ["missing field", ["--factory", s.write("field.jsonl", [good[0], JSON.stringify({ ...JSON.parse(good[1] as string), entity_id: undefined })].join("\n")), "--tira-log", TIRA_LOG], /field\.jsonl line 2: entity_id must be a non-empty string/],
      ["non-fx factory id", ["--factory", s.write("nofx.jsonl", JSON.stringify({ ...JSON.parse(good[0] as string), event_id: "abc" })), "--tira-log", TIRA_LOG], /nofx\.jsonl line 1: event_id must be an fx: key/],
      ["tira line without seq", ["--factory", FACTORY, "--tira-log", s.write("noseq.jsonl", JSON.stringify({ eventId: "fx:1", stream: "s", type: "brief.created", data: {} }))], /noseq\.jsonl line 1: seq must be a positive integer/],
      ["two streams in one log", ["--factory", FACTORY, "--tira-log", s.write("two.jsonl", [{ stream: "a", seq: 1 }, { stream: "b", seq: 2 }].map((x) => JSON.stringify({ eventId: `fx:${x.seq}`, type: "brief.created", data: {}, ...x })).join("\n"))], /2 streams/],
      ["log of another stream", ["--factory", FACTORY, "--tira-log", TIRA_LOG, "--stream", "other"], /not other/],
    ];
    for (const [name, argv, err] of cases) {
      const r = await s.tira("divergence", ...argv);
      assert.equal(r.code, 1, name);
      assert.match(r.err, err, name);
      assert.equal(r.out, "", `${name}: no report`);
    }
  } finally {
    s.done();
  }
});

test("HELP lists the command and says divergences exit 0", async () => {
  const s = sandbox();
  try {
    const r = await s.tira("--help");
    assert.match(r.out, /tira divergence --factory FILE \[--tira-log FILE\] \[--stream NAME\] \[--json\]/);
    assert.match(r.out, /Divergences are warn-only \(severity policy v1\): they exit 0/);
  } finally {
    s.done();
  }
});
