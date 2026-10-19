// The scenario suite (build-plan §5; build order C2): S1–S9, T1–T8 and the R handoff
// tests as JSON event scripts in scenarios/. Each script replays its steps through the
// real dispatcher and write path on a fresh store, checks every step's outcome, then
// checks the folded result, replay-to-N snapshots, and determinism (the same log folds
// to the same bytes twice, from a shuffled copy, and at every prefix without anomalies).
// Scripts whose feature isn't built yet are kept as `status: "pending"` with the reason.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteEventStore } from "../store/sqlite-store.ts";
import type { StoredEvent } from "../store/types.ts";
import { defaultRegistry, type Registry } from "../tables/registry.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import type { Command, WriteResult } from "../write/write-path.ts";
import { canonicalJson, compareCodeUnits, fold, type FoldResult } from "../fold/fold.ts";
import { entityKey, type EntityState } from "../fold/types.ts";

export interface Step {
  do: "create" | "send" | "check";
  type?: string;
  id?: string;
  version?: number;
  event?: string;
  parent?: string;
  actor?: string;
  payload?: Record<string, unknown>;
  expect?: string; // "appended" (default) | "noop" | "rejected:<code>" | "duplicate"
  handoffs?: string[]; // receivers the dispatcher must write for this step, e.g. "H1 brief.claimable"
  label?: string;
}

export interface Expect {
  states?: Record<string, string | Record<string, string>>; // key -> lifecycle state, or region -> state
  absent?: string[];
  cursor?: string | null;
  active?: string[];
  drained?: string[];
  notDrained?: string[];
  awaitingClose?: string[];
  closedByTira?: string[];
  rejections?: number;
  anomalies?: number; // default 0
  pending?: [string, string][]; // [rule, key], in order
  trail?: Record<string, string[]>; // key -> stored types of the events that touched it, rejections included
  provenance?: Record<string, { parent?: string; kind?: string; discoveredDuring?: string }>;
  paired?: { from: string; to: string }[]; // "<stored type> <key>" on each side, same correlation id
  frontier?: string[]; // factory: briefs claimable now, in order
}

export interface Scenario {
  id: string;
  title: string;
  status?: "active" | "pending" | "seed";
  pending?: string; // why the whole scenario waits
  pendingParts?: string[]; // parts of an active scenario that wait
  note?: string;
  stream?: string;
  after?: string[]; // scenarios whose steps run first (same log), e.g. S3 after S1, S2, S7
  steps?: Step[];
  expect?: Expect;
  replayAt?: (Expect & { after: string })[];
}

export const SCENARIO_DIR = new URL("../../scenarios/", import.meta.url);

export function loadScenarios(dir: URL = SCENARIO_DIR): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort(compareCodeUnits)) {
    const s = JSON.parse(readFileSync(join(dir.pathname, f), "utf8")) as Scenario;
    if (`${s.id}.json` !== f) throw new Error(`${f}: id ${s.id} must match the file name`);
    out.set(s.id, s);
  }
  return out;
}

// The steps a scenario replays: its prerequisites' steps first (each once), then its own.
export function stepsOf(s: Scenario, all: Map<string, Scenario>, seen = new Set<string>()): Step[] {
  const out: Step[] = [];
  for (const id of s.after ?? []) {
    if (id === s.id) throw new Error(`${s.id}: a scenario can't run after itself`);
    if (seen.has(id)) continue;
    seen.add(id);
    const pre = all.get(id);
    if (!pre) throw new Error(`${s.id}: after ${id}, which doesn't exist`);
    out.push(...stepsOf(pre, all, seen));
  }
  return [...out, ...(s.steps ?? [])];
}

const outcomeOf = (r: WriteResult): string =>
  r.status === "appended" ? (r.outcome === "noop" ? "noop" : "appended") : r.status === "rejected" ? `rejected:${r.code}` : r.status;

function regionsOf(e: EntityState | undefined) {
  return e?.regions ?? {};
}

// Every way the fold can disagree with an expectation, as plain sentences.
function check(where: string, r: FoldResult, events: readonly StoredEvent[], stream: string, x: Expect): string[] {
  const bad: string[] = [];
  const ents = new Map(r.entities.filter((e) => e.stream === stream).map((e) => [e.key, e]));
  const d = r.derived[stream] ?? {};
  const tree = r.trees[stream]?.node;
  const eq = (what: string, got: unknown, want: unknown) => {
    if (canonicalJson(got) !== canonicalJson(want)) bad.push(`${where}: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  for (const [key, want] of Object.entries(x.states ?? {})) {
    const e = ents.get(key);
    if (!e) { bad.push(`${where}: ${key} doesn't exist`); continue; }
    if (typeof want === "string" && Object.keys(regionsOf(e)).length > 1) bad.push(`${where}: ${key} has ${Object.keys(regionsOf(e)).length} regions: name them`);
    else if (typeof want === "string") eq(`${key}'s state`, Object.values(regionsOf(e))[0], want);
    else for (const [region, st] of Object.entries(want)) eq(`${key}'s ${region}`, regionsOf(e)[region], st);
  }
  for (const key of x.absent ?? []) if (ents.has(key)) bad.push(`${where}: ${key} exists, expected none`);
  if (x.cursor !== undefined) eq("the cursor", tree?.cursor ?? null, x.cursor);
  if (x.active !== undefined) eq("the active task", tree?.active ?? [], x.active);
  const flagged = (flag: string) => Object.entries(d).filter(([, v]) => v[flag] === true).map(([k]) => k).sort(compareCodeUnits);
  for (const k of x.drained ?? []) if (d[k]?.drained !== true) bad.push(`${where}: ${k} isn't drained`);
  for (const k of x.notDrained ?? []) if (d[k]?.drained === true) bad.push(`${where}: ${k} is drained`);
  if (x.awaitingClose !== undefined) eq("waiting for tira", flagged("awaitingClose"), [...x.awaitingClose].sort(compareCodeUnits));
  if (x.closedByTira !== undefined) eq("closed by tira", flagged("closedByTira"), [...x.closedByTira].sort(compareCodeUnits));
  if (x.rejections !== undefined) eq("rejections", r.rejections.filter((j) => j.stream === stream).length, x.rejections);
  const anomalies = r.anomalies.filter((a) => a.stream === stream);
  if (anomalies.length !== (x.anomalies ?? 0)) bad.push(`${where}: ${anomalies.length} anomalies (${anomalies.map((a) => a.problem).join("; ")}), expected ${x.anomalies ?? 0}`);
  if (x.pending !== undefined) eq("pending handoffs", (r.handoffs[stream] ?? []).map((p) => [p.rule, p.key]), x.pending);
  if (x.frontier !== undefined) eq("the frontier", r.frontier[stream] ?? [], x.frontier);
  for (const [key, want] of Object.entries(x.trail ?? {})) {
    const touched = events.filter((e) => {
      const data = e.data as { entity?: { id: string; version?: number }; intent?: { entity: { type: string; id: string; version?: number } } };
      const ent = data.intent?.entity ?? (data.entity ? { type: e.type.slice(0, e.type.indexOf(".")), ...data.entity } : undefined);
      return ent !== undefined && entityKey(ent) === key;
    });
    eq(`${key}'s trail`, touched.map((e) => e.type), want);
  }
  for (const [key, want] of Object.entries(x.provenance ?? {})) {
    const t = ents.get(key)?.tree;
    eq(`${key}'s provenance`, { ...(want.parent ? { parent: t?.parent } : {}), ...(want.kind ? { kind: t?.kind } : {}), ...(want.discoveredDuring ? { discoveredDuring: t?.discoveredDuring } : {}) }, want);
  }
  for (const p of x.paired ?? []) {
    const find = (label: string) => events.find((e) => {
      const [type, key] = label.split(" ");
      const ent = (e.data as { entity?: { id: string; version?: number } }).entity;
      return e.type === type && ent !== undefined && entityKey({ type: e.type.slice(0, e.type.indexOf(".")), ...ent }) === key;
    });
    const from = find(p.from);
    const to = find(p.to);
    if (!from || !to) bad.push(`${where}: no pair ${p.from} → ${p.to}`);
    else eq(`the correlation id of ${p.to}`, to.metadata.correlationId, from.eventId);
  }
  return bad;
}

export interface ScenarioResult {
  failures: string[];
  log: StoredEvent[];
}

export async function runScenario(s: Scenario, all: Map<string, Scenario>, registry: Registry = defaultRegistry()): Promise<ScenarioResult> {
  const stream = s.stream ?? `scenario-${s.id.toLowerCase()}`;
  const store = new SqliteEventStore();
  const d = new Dispatcher(store, registry);
  const failures: string[] = [];
  const labels = new Map<string, number>(); // label -> last seq after that step
  for (const [n, step] of stepsOf(s, all).entries()) {
    const where = `step ${n + 1}${step.label ? ` (${step.label})` : ""}`;
    if (step.do !== "check") {
      if (!step.type || !step.id) throw new Error(`${s.id} ${where}: type and id are required`);
      const entity = { type: step.type, id: step.id, ...(step.version === undefined ? {} : { version: step.version }) };
      const payload = { ...(step.payload ?? {}), ...(step.parent ? { parent_id: step.parent } : {}) };
      const cmd = (step.do === "create"
        ? { stream, kind: "create", entity, payload, actor: step.actor ?? "isha" }
        : { stream, kind: "event", entity, event: step.event, payload, actor: step.actor ?? "isha" }) as Command;
      const { result, handoffs } = await d.submit(cmd);
      const got = outcomeOf(result);
      const want = step.expect ?? "appended";
      if (got !== want) failures.push(`${where}: ${step.do} ${entityKey(entity)}${step.event ? ` ${step.event}` : ""} was ${got}, expected ${want}${result.status === "rejected" ? ` (${result.detail})` : ""}`);
      if (step.handoffs !== undefined) {
        const wrote = handoffs.map((h) => `${h.rule} ${h.event}`);
        if (canonicalJson(wrote) !== canonicalJson(step.handoffs)) failures.push(`${where}: the dispatcher wrote ${JSON.stringify(wrote)}, expected ${JSON.stringify(step.handoffs)}`);
      }
    }
    if (step.label) {
      if (labels.has(step.label)) throw new Error(`${s.id}: label ${step.label} is used twice`);
      labels.set(step.label, (await store.readStream(stream)).at(-1)?.seq ?? 0);
    }
  }
  const log = await store.readStream(stream);
  const r = fold(log, registry);
  if (s.expect) failures.push(...check("end", r, log, stream, s.expect));
  for (const snap of s.replayAt ?? []) {
    const at = labels.get(snap.after);
    if (at === undefined) { failures.push(`replay: no step labelled ${snap.after}`); continue; }
    const upTo = log.filter((e) => e.seq <= at);
    failures.push(...check(`replay to ${snap.after} (seq ${at})`, fold(log, registry, { upToSeq: at }), upTo, stream, snap));
  }
  // determinism (T2 for every script): twice, from a shuffled copy, and at every prefix
  const once = canonicalJson(r);
  if (canonicalJson(fold(log, registry)) !== once) failures.push("determinism: two folds of the same log differ");
  const shuffled = [...log].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  if (canonicalJson(fold(shuffled, registry)) !== once) failures.push("determinism: a shuffled copy of the log folds differently");
  for (const e of log) {
    const at = fold(log, registry, { upToSeq: e.seq });
    if (at.anomalies.length > 0) { failures.push(`replay to seq ${e.seq}: ${at.anomalies[0]?.problem}`); break; }
  }
  return { failures, log };
}
