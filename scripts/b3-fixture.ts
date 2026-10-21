// The B3 blind fixture, round 1: the generator. Published after the verdicts were locked
// (2026-10-20); until then it lived outside the repo, because it spells out the plants.
//
// Runs a real factory scenario through tira's dispatcher (fx: event ids, as the factory
// emits them), takes tira's log as tira-log.jsonl and the factory's file state as
// factory-state.jsonl (one record per committed transition), and plants M divergences
// between the two. The manifest lists every event id with its expected verdict.
//
//   node scripts/b3-fixture.ts fixtures/b3     rewrite the fixture and its manifest (the folder
//                                              must be inside the one you run it from)
//
// Deterministic except three things tira stamps itself: the store time (`recordedAt`), the
// ids of the handoff events its dispatcher writes (random, not fx:), and the rules era
// (`metadata.era`, versioned rules). The committed log predates the era marker: legacy era.
// test/fixture-b3.test.ts rebuilds the fixture and compares everything else.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fxKey, transitionOf } from "../src/write/fxkey.ts";
import { fold } from "../src/fold/fold.ts";
import type { Command } from "../src/write/write-path.ts";
import type { StoredEvent } from "../src/store/types.ts";
import { safePath } from "./cli-path.ts";

export const STREAM = "factory-b3";

export type Verdict = "OK" | "MISSING" | "PHANTOM" | "WRONG-ENTITY" | "DUPLICATE" | "ORPHAN";
export interface ManifestEntry { event_id: string; verdict: Verdict; transition: string; how?: string }
export interface Manifest { stream: string; M: number; counts: Record<string, number>; verdicts: ManifestEntry[] }

interface Step {
  type: "brief" | "session" | "drop";
  id: string;
  version?: number;
  event?: string; // absent: a birth
  actor: string;
  payload?: Record<string, unknown>;
  plant?: { verdict: Exclude<Verdict, "OK">; how: string; entityIdInFile?: string };
}

const brief = (id: string, extra: Partial<Step> = {}): Step => ({ type: "brief", id, version: 1, actor: "orchestrator", payload: { slice_ref: `slice/${id}` }, ...extra });
const ev = (type: Step["type"], id: string, event: string, actor: string, payload: Record<string, unknown> = {}, version?: number, plant?: Step["plant"]): Step =>
  ({ type, id, event, actor, payload, ...(version === undefined ? {} : { version }), ...(plant ? { plant } : {}) });

// The run, in commit order. A step with `plant` is where the two files diverge.
const STEPS: Step[] = [
  // sessions name themselves
  ...["s1", "s2", "s3", "s4", "s5", "s6"].map((s): Step => ({ type: "session", id: s, actor: s })),
  { type: "session", id: "s7", actor: "s7", plant: { verdict: "MISSING", how: "the factory committed s7's naming; tira never received it" } },
  // the orchestrator writes briefs; b5 waits on b1
  ...["b1", "b2", "b3", "b4", "b6", "b7", "b8", "b9", "b10"].map((b) => brief(b)),
  brief("b5", { payload: { slice_ref: "slice/b5", blocked_by: ["b1"] } }),
  // dispatch
  ...["b1", "b2", "b3", "b4", "b5", "b7", "b8", "b9"].map((b) => ev("brief", b, "DISPATCHED", "orchestrator", {}, 1)),
  ev("brief", "b6", "DISPATCHED", "orchestrator", {}, 1, { verdict: "DUPLICATE", how: "the factory journaled b6's dispatch twice (a retry); tira deduplicated it" }),
  ev("brief", "b10", "DISPATCHED", "orchestrator", {}, 1, { verdict: "MISSING", how: "the factory committed b10's dispatch; tira never received it" }),
  ev("brief", "zz", "DISPATCHED", "orchestrator", {}, 1, { verdict: "ORPHAN", how: "a dispatch of brief zz, which was never created: tira refused it (unknown-entity); the factory recorded it as committed" }),
  // claims
  ev("brief", "b1", "CLAIMED", "s1", { session: "s1" }, 1),
  ev("brief", "b2", "CLAIMED", "s2", { session: "s2" }, 1),
  ev("brief", "b3", "CLAIMED", "s3", { session: "s3" }, 1),
  ev("brief", "b4", "CLAIMED", "s4", { session: "s4" }, 1, { verdict: "WRONG-ENTITY", how: "tira has s4's claim on b4@1; the factory's record of the same event_id names b7@1", entityIdInFile: "b7@1" }),
  ev("brief", "b6", "CLAIMED", "s6", { session: "s6" }, 1),
  ev("brief", "b7", "CLAIMED", "s5", { session: "s5" }, 1, { verdict: "PHANTOM", how: "tira has s5's claim on b7; the factory has no record of it (rolled back after emitting)" }),
  // drops
  { type: "drop", id: "b1", version: 1, actor: "s1" },
  { type: "drop", id: "b2", version: 1, actor: "s2" },
  { type: "drop", id: "b3", version: 1, actor: "s3", plant: { verdict: "WRONG-ENTITY", how: "tira has s3's drop for b3@1; the factory's record of the same event_id names b9@1", entityIdInFile: "b9@1" } },
  { type: "drop", id: "b6", version: 1, actor: "s6" },
  // verdicts
  ev("drop", "b1", "VERIFIED", "orchestrator", { done_test_result: "PASS" }, 1),
  ev("drop", "b2", "VERIFIED", "orchestrator", { done_test_result: "PASS" }, 1),
  ev("drop", "b6", "REJECTED", "orchestrator", { reason: "the done test failed" }, 1),
  // b5 is claimable once b1 is verified
  ev("brief", "b5", "CLAIMED", "s5", { session: "s5" }, 1),
  // sessions: a rename, an end
  ev("session", "s4", "RENAMED", "s4", { name: "s4-polish" }),
  ev("session", "s2", "RENAMED", "s2", { name: "s2-tables" }, undefined, { verdict: "PHANTOM", how: "tira has s2's rename; the factory has no record of it" }),
  ev("session", "s1", "ENDED", "s1", { declared_by: "self" }),
  // a revision and a gate denial
  { type: "brief", id: "b8", version: 2, actor: "orchestrator", payload: { slice_ref: "slice/b8", supersedes: 1 } },
  ev("brief", "b10", "DENIED", "orchestrator", { reason: "out of scope for this slice" }, 1),
];

export interface Round { records: Record<string, string>[]; events: StoredEvent[]; manifest: Manifest; manifestMd: string }

type BirthName = (type: string, version?: number) => string;
interface Sent { plain: Command; eventId: string; kind: string; entityId: string; label: string }

const suffix = (version?: number) => (version === undefined ? "" : "@" + version);

// One step as the factory sends it: the command, its fx: key, and how the files name it.
function commandOf(s: Step, birthName: BirthName): Sent {
  const entity = { type: s.type, id: s.id, ...(s.version === undefined ? {} : { version: s.version }) };
  const payload = s.payload ?? {};
  const plain: Command = s.event === undefined
    ? { stream: STREAM, kind: "create", entity, actor: s.actor, payload }
    : { stream: STREAM, kind: "event", entity, event: s.event, actor: s.actor, payload };
  const kind = s.event ?? birthName(s.type, s.version);
  const entityId = s.id + suffix(s.version);
  return { plain, eventId: fxKey(transitionOf(plain, birthName)), kind, entityId, label: kind + " " + s.type + ":" + entityId + " by " + s.actor };
}

// tira's side: everything is sent except what the factory committed while tira never heard
// of it. Returns the outcome the factory records.
async function sendToTira(d: Dispatcher, s: Step, c: Sent): Promise<string> {
  const outcome = s.event === undefined ? "created" : "transition";
  if (s.plant?.verdict === "MISSING") return outcome;
  const { result } = await d.submit({ ...c.plain, eventId: c.eventId });
  const expected = s.plant?.verdict === "ORPHAN" ? "rejected" : "appended";
  if (result.status !== expected) throw new Error(c.label + ": tira said " + JSON.stringify(result) + ", expected " + expected);
  return result.status === "appended" ? result.outcome : outcome;
}

// The factory's side: what it committed, except what tira wrote that the factory never did.
// Every step takes a commit time (a phantom's too), so the times don't depend on the plants.
function factoryRecords(s: Step, c: Sent, outcome: string, ts: () => string): Record<string, string>[] {
  const record = { transition_kind: c.kind, entity_type: s.type, entity_id: s.plant?.entityIdInFile ?? c.entityId, ts: ts(), outcome, actor: s.actor, event_id: c.eventId };
  if (s.plant?.verdict === "PHANTOM") return [];
  if (s.plant?.verdict === "DUPLICATE") return [record, { ...record, ts: ts() }]; // journaled twice
  return [record];
}

function manifestOf(verdicts: ManifestEntry[]): Manifest {
  const counts: Record<string, number> = {};
  for (const m of verdicts) counts[m.verdict] = (counts[m.verdict] ?? 0) + 1;
  return { stream: STREAM, M: verdicts.filter((m) => m.verdict !== "OK").length, counts, verdicts };
}

function manifestMarkdown(m: Manifest): string {
  const planted = m.verdicts.filter((x) => x.verdict !== "OK");
  const counts = Object.entries(m.counts).map(([k, v]) => k + " " + v).join(", ");
  const rows = planted.map((x, i) => "| " + (i + 1) + " | " + x.verdict + " | " + x.transition + " | `" + x.event_id + "` | " + x.how + " |");
  return [
    "# B3 blind fixture, round 1: manifest",
    "",
    "Revealed 2026-10-20, after Devansh's verdicts were locked (`verdicts.json`). Score: `node scripts/b3-score.ts`.",
    "",
    "M = " + m.M + " planted divergences; " + m.counts.OK + " clean transitions in both files.",
    "Counts: " + counts + ".",
    "",
    "| # | Expected verdict | Transition | event_id | How |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "Every other event_id in factory-state.jsonl is OK. `manifest.json` lists all of them, for mechanical scoring.",
    "",
  ].join("\n");
}

// One after another, in commit order: each step sees the log the one before it left.
const inOrder = <T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> =>
  items.reduce<Promise<void>>((done, item) => done.then(() => run(item)), Promise.resolve());

export async function buildRound1(): Promise<Round> {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const birthName: BirthName = (t, v) => registry.creationName(t, v);
  const records: Record<string, string>[] = [];
  const verdicts: ManifestEntry[] = [];
  let minute = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 20, 9, minute++)).toISOString().replace(".000Z", "Z");
  await inOrder(STEPS, async (s) => {
    const c = commandOf(s, birthName);
    const outcome = await sendToTira(d, s, c);
    records.push(...factoryRecords(s, c, outcome, ts));
    verdicts.push({ event_id: c.eventId, verdict: s.plant?.verdict ?? "OK", transition: c.label, ...(s.plant ? { how: s.plant.how } : {}) });
  });
  const events = await store.readStream(STREAM);
  const r = fold(events, registry);
  if (r.anomalies.length > 0) throw new Error("tira's log has anomalies: " + JSON.stringify(r.anomalies));
  const manifest = manifestOf(verdicts);
  return { records, events, manifest, manifestMd: manifestMarkdown(manifest) };
}

export const jsonl = (rows: readonly unknown[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: node scripts/b3-fixture.ts <fixture dir, inside this folder>");
  const out = safePath(arg);
  const { records, events, manifest, manifestMd } = await buildRound1();
  writeFileSync(join(out, "factory-state.jsonl"), jsonl(records));
  writeFileSync(join(out, "tira-log.jsonl"), jsonl(events));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "manifest.md"), manifestMd);
  console.log("factory-state.jsonl: " + records.length + " records · tira-log.jsonl: " + events.length + " events · planted M=" + manifest.M + " · clean " + manifest.counts.OK);
}
