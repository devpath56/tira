// The fold: replay the log through the transition tables to derive all state.
// Nothing is stored as "current" — this function is authoritative.
//
// fold(log, N, now, vantage): `upToSeq` gives replay-to-N (time travel); `now` and
// `vantage` feed derived predicates only (b0-factory-mapping.md G6). Same inputs
// => byte-identical output (see canonicalJson). Works on one stream or on readAll():
// entities are namespaced by stream, so the same id in two trees never collides.
import type { StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { evaluate, type RejectCode } from "./evaluate.ts";
import { REJECTED, toIntent, type RejectedData } from "./events.ts";
import type { EntityRef, EntityState, StateView } from "./types.ts";
import { entityKey } from "./types.ts";

export interface FoldOptions {
  upToSeq?: number;
  now?: string;
  vantage?: string;
}

export interface Rejection {
  seq: number;
  stream: string;
  eventId: string;
  code: RejectCode;
  detail: string;
  intent: RejectedData["intent"];
}

// A stored event the fold could not apply. Should never happen when every write
// goes through the write path; if it does, the log disagrees with the tables.
export interface Anomaly {
  seq: number;
  stream: string;
  eventId: string;
  type: string;
  problem: string;
}

export interface FoldResult {
  lastSeq: number; // highest seq folded (0 if none)
  entities: EntityState[]; // sorted by stream, then key
  derived: Record<string, Record<string, Record<string, unknown>>>; // stream -> key -> predicate -> value
  rejections: Rejection[];
  anomalies: Anomaly[];
}

const byKey = (a: EntityState, b: EntityState) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function makeView(entities: ReadonlyMap<string, EntityState>): StateView {
  return {
    get: (ref: EntityRef) => entities.get(entityKey(ref)),
    all: (type?: string) => [...entities.values()].filter((e) => type === undefined || e.type === type).sort(byKey),
  };
}

const isRejectedData = (d: unknown): d is RejectedData => {
  const r = d as RejectedData | undefined;
  return (
    !!r &&
    typeof r === "object" &&
    !!r.reason &&
    typeof r.reason.code === "string" &&
    typeof r.reason.detail === "string" &&
    !!r.intent &&
    typeof r.intent === "object"
  );
};

export function fold(events: readonly StoredEvent[], registry: Registry, opts: FoldOptions = {}): FoldResult {
  const streams = new Map<string, Map<string, EntityState>>();
  const views = new Map<string, StateView>();
  const scope = (stream: string) => {
    let m = streams.get(stream);
    if (!m) {
      m = new Map();
      streams.set(stream, m);
      views.set(stream, makeView(m));
    }
    return { entities: m, view: views.get(stream) as StateView };
  };
  const rejections: Rejection[] = [];
  const anomalies: Anomaly[] = [];
  let lastSeq = 0;

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    if (opts.upToSeq !== undefined && e.seq > opts.upToSeq) break;
    lastSeq = e.seq;
    const anomaly = (problem: string) =>
      anomalies.push({ seq: e.seq, stream: e.stream, eventId: e.eventId, type: e.type, problem });

    if (e.type === REJECTED) {
      if (!isRejectedData(e.data)) {
        anomaly("malformed command.rejected record");
        continue;
      }
      const d = e.data;
      rejections.push({
        seq: e.seq, stream: e.stream, eventId: e.eventId, code: d.reason.code, detail: d.reason.detail, intent: d.intent,
      });
      continue;
    }
    const intent = toIntent(e);
    if (!intent) {
      anomaly("unrecognised event shape");
      continue;
    }
    const { entities, view } = scope(e.stream);
    const ev = evaluate(registry, entities, view, intent);
    if (!ev.ok) {
      anomaly(`${ev.code}: ${ev.detail}`);
      continue;
    }
    const prev = entities.get(ev.key);
    const createdBy = prev ? prev.createdBy : intent.actor;
    entities.set(ev.key, {
      stream: e.stream,
      type: intent.entity.type,
      id: intent.entity.id,
      ...(intent.entity.version !== undefined ? { version: intent.entity.version } : {}),
      key: ev.key,
      regions: ev.regions,
      createdSeq: prev?.createdSeq ?? e.seq,
      lastSeq: e.seq,
      lastRecordedAt: e.recordedAt,
      ...(createdBy !== undefined ? { createdBy } : {}),
      ...(intent.actor !== undefined ? { lastActor: intent.actor } : {}),
    });
  }

  const entities: EntityState[] = [];
  const derived: FoldResult["derived"] = {};
  for (const stream of [...streams.keys()].sort()) {
    const view = views.get(stream) as StateView;
    for (const ent of view.all()) {
      entities.push(ent);
      const fns = registry.get(ent.type)?.derived;
      if (!fns) continue;
      (derived[stream] ??= {})[ent.key] = Object.fromEntries(
        Object.entries(fns).map(([name, fn]) => [name, fn(ent, { now: opts.now, vantage: opts.vantage, view })]),
      );
    }
  }
  return { lastSeq, entities, derived, rejections, anomalies };
}

// Stable serialization: sorted keys at every level. Two folds of the same log
// with the same options must produce identical strings (build-plan.md T2).
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value)) ?? "undefined";
}
