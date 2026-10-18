// Read-only views over one stream's entities, shared by the fold and the write path.
import { entityKey, type EntityRef, type EntityState, type StateView } from "./types.ts";

// Code-unit order, deliberately NOT localeCompare: canonical output must not depend
// on the machine's locale or ICU version, or refolds stop being byte-identical
// across machines (build-plan.md T2, manual test M0).
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const byKey = (a: EntityState, b: EntityState) => compareCodeUnits(a.key, b.key);

export function makeView(entities: ReadonlyMap<string, EntityState>): StateView {
  return {
    get: (ref: EntityRef) => entities.get(entityKey(ref)),
    getKey: (key: string) => entities.get(key),
    all: (type?: string) => [...entities.values()].filter((e) => type === undefined || e.type === type).sort(byKey),
  };
}

// The same stream with one entity replaced: "what would the tree look like after this?"
export function overlayView(entities: ReadonlyMap<string, EntityState>, next: EntityState): StateView {
  const m = new Map(entities);
  m.set(next.key, next);
  return makeView(m);
}
