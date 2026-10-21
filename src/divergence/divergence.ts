// The B3 divergence watchdog's differ: the factory's file state against tira's log, one
// verdict per fx: event id. Pure: parsed records in, a report out, no IO. The CLI's two
// input adapters (a factory-file reader, a tira store/log reader) feed this one code path,
// so fixture and store inputs are judged the same way.
//
// The join is a SET join on event ids. Input ORDER is never read and timestamps (the
// factory's `ts`, tira's `recordedAt`) are never compared: shuffling either file's lines
// gives the same verdict map. Non-fx: tira events (the dispatcher's own handoffs) are not
// divergences and are ignored. fx: ids are factory-minted; tira verifies; the watchdog only
// reports, so nothing here mints, repairs or re-keys an id.
//
// The per-id state table is the definition of correct (test/divergence.test.ts walks it):
//
//   factory  tira            entity + kind  entity born  verdict
//   2+       any             any            any          DUPLICATE
//   any      2+              any            any          DUPLICATE
//   1        1               mismatch       any          WRONG-ENTITY (a kind mismatch too)
//   1        0               -              neither      ORPHAN
//   0        1               -              neither      ORPHAN
//   1        1 (or rejected) match          neither      ORPHAN
//   1        0               -              here/there   MISSING
//   1        1 rejected      match          here/there   MISSING
//   0        1 (or rejected) -              here/there   PHANTOM
//   1        1               match          here/there   OK
//
// "Born" means the event's entity has a birth (NAMED / CREATED / REVISED / FILED) in either
// file; a `command.rejected` event is not an applied event, so it never gives birth and
// never counts as tira having applied the transition.
import { compareCodeUnits } from "../fold/view.ts";
import type { StoredEvent } from "../store/types.ts";

export const VERDICTS = ["OK", "MISSING", "PHANTOM", "WRONG-ENTITY", "DUPLICATE", "ORPHAN"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Severity policy v1: every divergence is an attention finding; none blocks.
export const SEVERITY_POLICY = "v1";

export const FX = "fx:";
export const BIRTHS: readonly string[] = ["NAMED", "CREATED", "REVISED", "FILED"];
const REJECTED_TYPE = "command.rejected";

// One record of the factory's file state: one committed transition (fixtures/b3/README.md).
export interface FactoryRecord {
  transition_kind: string;
  entity_type: string;
  entity_id: string; // with "@version" for versioned types
  ts: string;
  outcome: string;
  actor: string;
  event_id: string;
}

export interface Coordinates {
  // What pins the factory bytes: a git commit (fixture runs) or the snapshot's declared sha256.
  factory: { snapshot: string; pin: "git" | "sha256" | "unpinned"; file?: string };
  tira: { stream: string; atSeq: number };
}

export interface Population {
  factoryRecords: number;
  tiraFxEvents: number;
  ids: number; // event ids in the union of both sides
}

export interface Finding {
  event_id: string;
  verdict: Exclude<Verdict, "OK">;
  detail: string;
}

export interface DivergenceReport {
  coordinates: Coordinates;
  population: Population;
  severityPolicy: typeof SEVERITY_POLICY;
  counts: Record<Verdict, number>;
  verdicts: Record<string, Verdict>; // keys in code-unit order
  findings: Finding[]; // by event id, code-unit order
}

// One side's view of a transition, reduced to what the verdict compares.
interface Seen {
  entity: string; // "type:id[@version]"
  kind: string | undefined; // table name, e.g. DISPATCHED; undefined when tira's rejection was a create
  applied: boolean; // false for a tira command.rejected
}

const factoryEntity = (r: FactoryRecord) => `${r.entity_type}:${r.entity_id}`;
const tableName = (stored: string) => stored.toUpperCase().replaceAll("-", "_");

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function entityKey(type: string, ent: Record<string, unknown> | undefined): string {
  const id = ent?.id;
  const version = ent?.version;
  return `${type}:${typeof id === "string" ? id : "?"}${version !== undefined ? `@${String(version)}` : ""}`;
}

function tiraSeen(e: StoredEvent): Seen {
  if (e.type === REJECTED_TYPE) {
    const intent = asObject(asObject(e.data)?.intent);
    const ent = asObject(intent?.entity);
    const type = typeof ent?.type === "string" ? ent.type : "?";
    const kind = intent?.kind === "event" && typeof intent.event === "string" ? tableName(intent.event) : undefined;
    return { entity: entityKey(type, ent), kind, applied: false };
  }
  const dot = e.type.indexOf(".");
  const type = dot < 0 ? e.type : e.type.slice(0, dot);
  const kind = dot < 0 ? "?" : tableName(e.type.slice(dot + 1));
  return { entity: entityKey(type, asObject(asObject(e.data)?.entity)), kind, applied: true };
}

const label = (s: Seen) => `${s.kind ?? "create"} ${s.entity}`;

export interface DivergenceInput {
  factory: FactoryRecord[];
  tira: StoredEvent[]; // the stream as read: fx: and non-fx: events alike
  factorySnapshot: Coordinates["factory"];
  stream: string;
}

export function divergence(input: DivergenceInput): DivergenceReport {
  const fac = new Map<string, Seen[]>();
  const tir = new Map<string, Seen[]>();
  const born = new Set<string>();
  for (const r of input.factory) {
    const seen: Seen = { entity: factoryEntity(r), kind: r.transition_kind, applied: true };
    fac.set(r.event_id, [...(fac.get(r.event_id) ?? []), seen]);
    if (BIRTHS.includes(r.transition_kind)) born.add(seen.entity);
  }
  let atSeq = 0;
  let tiraFxEvents = 0;
  for (const e of input.tira) {
    if (e.seq > atSeq) atSeq = e.seq;
    if (!e.eventId.startsWith(FX)) continue;
    tiraFxEvents++;
    const seen = tiraSeen(e);
    tir.set(e.eventId, [...(tir.get(e.eventId) ?? []), seen]);
    if (seen.applied && seen.kind !== undefined && BIRTHS.includes(seen.kind)) born.add(seen.entity);
  }

  const ids = [...new Set([...fac.keys(), ...tir.keys()])].sort(compareCodeUnits);
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  const verdicts: Record<string, Verdict> = {};
  const findings: Finding[] = [];
  for (const id of ids) {
    const { verdict, detail } = judge(fac.get(id) ?? [], tir.get(id) ?? [], born);
    counts[verdict]++;
    verdicts[id] = verdict;
    if (verdict !== "OK") findings.push({ event_id: id, verdict, detail });
  }
  return {
    coordinates: { factory: input.factorySnapshot, tira: { stream: input.stream, atSeq } },
    population: { factoryRecords: input.factory.length, tiraFxEvents, ids: ids.length },
    severityPolicy: SEVERITY_POLICY,
    counts,
    verdicts,
    findings,
  };
}

// One event id's verdict from its cell in the state table. Precedence:
// DUPLICATE > WRONG-ENTITY > ORPHAN > MISSING / PHANTOM > OK.
export function judge(f: Seen[], t: Seen[], born: ReadonlySet<string>): { verdict: Verdict; detail: string } {
  if (f.length >= 2 || t.length >= 2) {
    return { verdict: "DUPLICATE", detail: `factory has it ${f.length}x, tira ${t.length}x: ${label((f[0] ?? t[0]) as Seen)}` };
  }
  const fs = f[0];
  const ts = t[0];
  if (fs !== undefined && ts !== undefined) {
    const kindDiffers = ts.kind !== undefined && ts.kind !== fs.kind;
    if (ts.entity !== fs.entity || kindDiffers) {
      return { verdict: "WRONG-ENTITY", detail: `factory: ${label(fs)}; tira${ts.applied ? "" : " (rejected)"}: ${label(ts)}` };
    }
  }
  const subject = (fs ?? ts) as Seen;
  if (!born.has(subject.entity)) {
    return { verdict: "ORPHAN", detail: `${label(subject)}: ${subject.entity} is born in neither file${ts !== undefined && !ts.applied ? " (tira rejected it)" : ""}` };
  }
  if (fs !== undefined && (ts === undefined || !ts.applied)) {
    return { verdict: "MISSING", detail: `factory committed ${label(fs)}; tira ${ts === undefined ? "has no event with this id" : "rejected it"}` };
  }
  if (fs === undefined) {
    return { verdict: "PHANTOM", detail: `tira has ${label(subject)}${subject.applied ? "" : " (rejected)"}; the factory has no record of it` };
  }
  return { verdict: "OK", detail: label(fs) };
}
