// The B3 blind fixture (fixtures/b3): both files keep their published format, and tira's
// side is a genuine log. Since the verdicts were locked (2026-10-20) the manifest, the
// generator and the scorer are public too: round 1 is re-scored here, and the generator must
// rebuild the files the manifest is the key to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry, RULES_ERA } from "../src/tables/registry.ts";
import { fold } from "../src/fold/fold.ts";
import { storedName, tableEventName } from "../src/fold/events.ts";
import { fxKey, transitionOf } from "../src/write/fxkey.ts";
import { isIsoTime } from "../src/time.ts";
import { FX_KEY } from "../src/tables/factory.ts";
import type { StoredEvent } from "../src/store/types.ts";
import { buildRound1, type Manifest } from "../scripts/b3-fixture.ts";
import { score } from "../scripts/b3-score.ts";
import { safePath } from "../scripts/cli-path.ts";

const DIR = new URL("../fixtures/b3/", import.meta.url);
const lines = (f: string) => readFileSync(new URL(f, DIR), "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);
const FIELDS = ["actor", "entity_id", "entity_type", "event_id", "outcome", "transition_kind", "ts"];
const json = (f: string) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as unknown;
const manifest = () => json("manifest.json") as Manifest;
const locked = () => (json("verdicts.json") as { verdicts: Record<string, string> }).verdicts;

test("factory-state.jsonl: one record per committed transition, in the locked format", () => {
  const records = lines("factory-state.jsonl") as Record<string, unknown>[];
  assert.ok(records.length >= 30 + 8, `${records.length} records`);
  for (const [i, r] of records.entries()) {
    const at = `line ${i + 1}`;
    assert.deepEqual(Object.keys(r).sort(), FIELDS, at);
    for (const f of FIELDS) assert.equal(typeof r[f], "string", `${at}: ${f}`);
    assert.match(r.transition_kind as string, /^[A-Z][A-Z_]*$/, at);
    assert.ok(["brief", "session", "drop"].includes(r.entity_type as string), at);
    assert.match(r.entity_id as string, r.entity_type === "session" ? /^[^@]+$/ : /^[^@]+@\d+$/, at);
    assert.ok(isIsoTime(r.ts) && (r.ts as string).endsWith("Z"), `${at}: ts`);
    assert.ok(["created", "transition", "noop"].includes(r.outcome as string), at);
    assert.match(r.event_id as string, FX_KEY, at);
  }
  // commit order: the factory appends, so ts never goes back
  const times = records.map((r) => Date.parse(r.ts as string));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("tira-log.jsonl: a genuine tira log: one stream, in seq order, folds with no anomalies, and every fx: id is its own transition's key", () => {
  const registry = defaultRegistry();
  const events = lines("tira-log.jsonl") as StoredEvent[];
  assert.ok(events.length > 0);
  assert.deepEqual([...new Set(events.map((e) => e.stream))], ["factory-b3"]);
  for (let i = 1; i < events.length; i++) assert.ok((events[i] as StoredEvent).seq > (events[i - 1] as StoredEvent).seq, `seq at line ${i + 1}`);
  const r = fold(events, registry);
  assert.deepEqual(r.anomalies, []);
  let checked = 0;
  for (const e of events.filter((x) => x.eventId.startsWith("fx:"))) {
    const d = e.data as { entity?: { id: string; version?: number }; payload?: Record<string, unknown>; intent?: { kind: "create" | "event"; entity: { type: string; id: string; version?: number }; event?: string; payload: Record<string, unknown>; actor?: string } };
    let cmd;
    if (e.type === "command.rejected" && d.intent) {
      cmd = { stream: e.stream, kind: d.intent.kind, entity: d.intent.entity, ...(d.intent.event ? { event: d.intent.event } : {}), ...(d.intent.actor ? { actor: d.intent.actor } : {}), payload: d.intent.payload };
    } else {
      const type = e.type.slice(0, e.type.indexOf("."));
      const entity = { type, id: d.entity?.id as string, ...(d.entity?.version === undefined ? {} : { version: d.entity.version }) };
      const birth = storedName(registry.creationName(type, entity.version)) === e.type.slice(type.length + 1);
      cmd = { stream: e.stream, kind: birth ? ("create" as const) : ("event" as const), entity, ...(birth ? {} : { event: tableEventName(e.type.slice(type.length + 1)) }), ...(e.metadata.actor ? { actor: e.metadata.actor } : {}), payload: d.payload ?? {} };
    }
    assert.equal(fxKey(transitionOf(cmd as Parameters<typeof transitionOf>[0], (t, v) => registry.creationName(t, v))), e.eventId, `${e.type} at seq ${e.seq}`);
    checked++;
  }
  assert.ok(checked >= 30, `${checked} fx: events checked`);
});

test("the fixture's README announces M and the verdict vocabulary", () => {
  const readme = readFileSync(new URL("README.md", DIR), "utf8");
  assert.match(readme, /\*\*M = 8\.\*\*/);
  for (const v of ["OK", "MISSING", "PHANTOM", "WRONG-ENTITY", "DUPLICATE", "ORPHAN"]) assert.ok(readme.includes(`| \`${v}\` |`), v);
});

test("round 1, scored: Devansh's locked verdicts against the manifest: all 8 planted caught, 0 false positives, 47/47", () => {
  const v = locked();
  const counts: Record<string, number> = {};
  for (const x of Object.values(v)) counts[x] = (counts[x] ?? 0) + 1;
  assert.deepEqual(counts, { OK: 39, "WRONG-ENTITY": 2, MISSING: 2, PHANTOM: 2, ORPHAN: 1, DUPLICATE: 1 }); // as posted on the ticket
  const s = score(manifest(), v);
  assert.deepEqual({ ids: s.ids, right: s.right, planted: s.planted, caught: s.caught, clean: s.clean, falsePositives: s.falsePositives, outside: s.outside, unanswered: s.unanswered, barMet: s.barMet },
    { ids: 47, right: 47, planted: 8, caught: 8, clean: 39, falsePositives: 0, outside: [], unanswered: [], barMet: true });
});

test("the scorer isn't lenient: a plant called by the wrong kind isn't caught, a clean id called anything else is a false positive, an unknown id fails the bar", () => {
  const m = manifest();
  const v = locked();
  const orphan = m.verdicts.find((x) => x.verdict === "ORPHAN")?.event_id as string;
  const clean = m.verdicts.find((x) => x.verdict === "OK")?.event_id as string;
  const wrongKind = score(m, { ...v, [orphan]: "MISSING" });
  assert.equal(wrongKind.caught, 7);
  assert.equal(wrongKind.barMet, false);
  assert.deepEqual(wrongKind.misses.map((x) => [x.expected, x.got]), [["ORPHAN", "MISSING"]]);
  const flagged = score(m, { ...v, [clean]: "PHANTOM" });
  assert.equal(flagged.falsePositives, 1);
  assert.equal(flagged.barMet, false);
  const silent = { ...v };
  delete silent[clean];
  assert.deepEqual(score(m, silent).unanswered, [clean]);
  assert.equal(score(m, silent).falsePositives, 1); // an unanswered clean id counts against the bar
  const extra = score(m, { ...v, "fx:not-in-either-file": "PHANTOM" });
  assert.deepEqual(extra.outside, ["fx:not-in-either-file"]);
  assert.equal(extra.barMet, false);
});

test("the manifest is the key to these files: one entry per event id in either file, and the generator rebuilds both files and the manifest", async () => {
  const records = lines("factory-state.jsonl") as Record<string, string>[];
  const events = lines("tira-log.jsonl") as StoredEvent[];
  const ids = new Set([...records.map((r) => r.event_id as string), ...events.map((e) => e.eventId).filter((id) => id.startsWith("fx:"))]);
  const m = manifest();
  assert.deepEqual([...ids].sort(), m.verdicts.map((x) => x.event_id).sort());
  assert.equal(m.M, m.verdicts.filter((x) => x.verdict !== "OK").length);
  const built = await buildRound1();
  assert.deepEqual(built.records, records);
  assert.deepEqual(built.manifest, m);
  assert.equal(built.manifestMd, readFileSync(new URL("manifest.md", DIR), "utf8"));
  // tira stamps three things itself: the store time, the ids of its dispatcher's own handoff
  // writes, and the rules era (versioned rules). The committed log was written before the era
  // marker, so it is the legacy era; a rebuild today is decided under today's rules era.
  assert.ok(events.every((e) => e.metadata.era === undefined), "the committed log is legacy era");
  assert.ok(built.events.every((e) => e.metadata.era === RULES_ERA), "a rebuild carries today's era");
  const comparable = (e: StoredEvent) => {
    const { era: _stamped, ...metadata } = e.metadata;
    return { ...e, metadata, recordedAt: "", eventId: e.eventId.startsWith("fx:") ? e.eventId : "(dispatcher)" };
  };
  assert.deepEqual(built.events.map(comparable), events.map(comparable));
});

test("the scripts only touch paths inside the folder they run from: the scorer scores the fixture; .., absolute paths and symlinks out are refused", () => {
  assert.equal(safePath("fixtures/b3"), join(safePath("."), "fixtures", "b3"));
  assert.throws(() => safePath(".."), /outside the allowed directory/);
  assert.throws(() => safePath(tmpdir()), /outside the allowed directory/);
  const out = mkdtempSync(join(tmpdir(), "tira-out-"));
  const link = join("fixtures", "b3", "link-out-" + process.pid);
  symlinkSync(out, link);
  try {
    assert.throws(() => safePath(link), /outside the allowed directory/); // a symlink out counts as out
  } finally {
    rmSync(link);
    rmSync(out, { recursive: true, force: true });
  }
  // a sibling whose name starts the same ("base-other" vs "base") is outside too
  const root = mkdtempSync(join(tmpdir(), "tira-paths-"));
  const home = process.cwd();
  try {
    mkdirSync(join(root, "base"));
    mkdirSync(join(root, "base-other"));
    process.chdir(join(root, "base"));
    assert.throws(() => safePath(join("..", "base-other")), /outside the allowed directory/);
  } finally {
    process.chdir(home);
    rmSync(root, { recursive: true, force: true });
  }
  const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/b3-score.ts", ...args], { encoding: "utf8" });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /47\/47 verdicts right · planted caught 8\/8 · false positives 0\/39 clean/);
  const refused = run(join("..", "manifest.json"));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /outside the allowed directory|ENOENT/);
});
