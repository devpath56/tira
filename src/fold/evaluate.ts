// The single legality function. The write path calls it before append; the fold
// calls it again on replay. One function, so "what the writer allowed" and "what
// the fold accepts" cannot drift apart.
import { step, type StepOutcome } from "../tables/table.ts";
import type { Registry } from "../tables/registry.ts";
import { entityKey, type EntityRef, type EntityState, type StateView } from "./types.ts";

export type RejectCode =
  | "unknown-entity-type"
  | "version-required"
  | "version-forbidden"
  | "already-exists"
  | "unknown-entity"
  | "unknown-event"
  | "denied"
  | "guard-failed"
  | "invariant";

export type Intent =
  | { kind: "create"; entity: EntityRef; payload: Record<string, unknown>; actor: string | undefined }
  | { kind: "event"; entity: EntityRef; event: string; payload: Record<string, unknown>; actor: string | undefined };

export type Evaluation =
  | {
      ok: true;
      outcome: Exclude<StepOutcome, "denied" | "guard-failed"> | "created";
      key: string;
      region?: string;
      from?: string;
      regions: Record<string, string>; // next region states
    }
  | { ok: false; code: RejectCode; detail: string };

const reject = (code: RejectCode, detail: string): Evaluation => ({ ok: false, code, detail });

export function evaluate(
  registry: Registry,
  entities: ReadonlyMap<string, EntityState>,
  view: StateView,
  intent: Intent,
): Evaluation {
  const def = registry.get(intent.entity.type);
  if (!def) return reject("unknown-entity-type", intent.entity.type);
  if (def.versioned && intent.entity.version === undefined) {
    return reject("version-required", `${def.type} is versioned`);
  }
  if (!def.versioned && intent.entity.version !== undefined) {
    return reject("version-forbidden", `${def.type} is not versioned`);
  }
  const key = entityKey(intent.entity);
  const current = entities.get(key);

  if (intent.kind === "create") {
    if (current) return reject("already-exists", key);
    const regions = registry.initialRegions(def);
    const inv = def.invariant?.(regions) ?? true;
    if (inv !== true) return reject("invariant", inv);
    return { ok: true, outcome: "created", key, regions };
  }

  if (!current) return reject("unknown-entity", key);
  const hit = registry.resolve(def.type, intent.event);
  if (!hit) return reject("unknown-event", `${def.type}.${intent.event}`);
  const from = current.regions[hit.region] as string;
  const res = step(hit.table, from, intent.event, registry.guards, {
    payload: intent.payload,
    actor: intent.actor,
    entity: current,
    view,
  });
  if (res.outcome === "denied") return reject("denied", `${hit.table.id}: ${from} + ${intent.event}`);
  if (res.outcome === "guard-failed") {
    return reject("guard-failed", `${hit.table.id}: ${from} + ${intent.event} needs ${res.guard}`);
  }
  const regions = { ...current.regions, [hit.region]: res.to };
  if (res.outcome === "transition") {
    const inv = def.invariant?.(regions) ?? true;
    if (inv !== true) return reject("invariant", inv);
  }
  return { ok: true, outcome: res.outcome, key, region: hit.region, from, regions };
}
