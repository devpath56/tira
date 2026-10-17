// Entity-type registry: entity type -> one or more transition tables (regions).
// B0 (b0-factory-mapping.md G1–G3) showed the core needs more than one dial per
// entity, more than one entity type, and versioned identity. The registry carries
// those as data, so new vocabularies (the factory's brief/session/drop) are added
// by registering tables, not by changing the runner.
import { DEFAULT_GUARDS, loadTable, type GuardFn, type Table } from "./table.ts";
import type { EntityState, StateView } from "../fold/types.ts";

// Derived predicates see the entity (incl. lastRecordedAt / lastActor), the rest of
// its stream, and the caller's clock and vantage. Nothing else — so they stay pure.
export interface DeriveContext {
  now: string | undefined; // ISO-8601; derived predicates may depend on time
  vantage: string | undefined; // which observer is asking (B0 G6)
  view: StateView; // the entity's own stream
}

export interface EntityTypeDef {
  type: string;
  // Region name -> table. One region = one dial; several = parallel dimensions.
  // Each event belongs to exactly one region (checked on register).
  regions: Record<string, Table>;
  versioned?: boolean;
  // Cross-region invariant over the would-be next state: true, or a reason string.
  invariant?: (regions: Record<string, string>) => true | string;
  // Derived predicates (like drain or liveness): computed by the fold, never stored.
  derived?: Record<string, (entity: EntityState, ctx: DeriveContext) => unknown>;
}

export interface Resolved {
  def: EntityTypeDef;
  region: string;
  table: Table;
}

export class Registry {
  private readonly defs = new Map<string, EntityTypeDef>();
  private readonly byEvent = new Map<string, Map<string, { region: string; table: Table }>>();
  readonly guards: Record<string, GuardFn>;

  constructor(guards: Record<string, GuardFn> = {}) {
    this.guards = { ...DEFAULT_GUARDS, ...guards };
  }

  register(def: EntityTypeDef): this {
    if (this.defs.has(def.type)) throw new Error(`entity type ${def.type} already registered`);
    if (!/^[a-z][a-z0-9_-]*$/.test(def.type)) throw new Error(`bad entity type name ${def.type}`);
    const regionNames = Object.keys(def.regions);
    if (regionNames.length === 0) throw new Error(`entity type ${def.type}: no regions`);
    const events = new Map<string, { region: string; table: Table }>();
    for (const region of regionNames) {
      const table = def.regions[region] as Table;
      for (const ev of table.events) {
        const other = events.get(ev);
        if (other) {
          throw new Error(`entity type ${def.type}: event ${ev} in regions ${other.region} and ${region}`);
        }
        events.set(ev, { region, table });
      }
      for (const g of Object.keys(table.guards)) {
        if (!(g in this.guards)) throw new Error(`table ${table.id}: guard ${g} has no implementation`);
      }
    }
    this.defs.set(def.type, def);
    this.byEvent.set(def.type, events);
    return this;
  }

  get(type: string): EntityTypeDef | undefined {
    return this.defs.get(type);
  }

  types(): EntityTypeDef[] {
    return [...this.defs.values()];
  }

  resolve(type: string, event: string): Resolved | undefined {
    const def = this.defs.get(type);
    const hit = this.byEvent.get(type)?.get(event);
    return def && hit ? { def, ...hit } : undefined;
  }

  initialRegions(def: EntityTypeDef): Record<string, string> {
    return Object.fromEntries(Object.entries(def.regions).map(([name, t]) => [name, t.initial]));
  }
}

const chart = (name: string) => loadTable(new URL(`../../charts/${name}`, import.meta.url));

// The two vocabularies specced today: dashboard nodes (the S1–S9 test vocabulary)
// and vapor ideas. Factory tables (B1) are added here once Q-B1–Q-B10 are answered.
export function defaultRegistry(): Registry {
  return new Registry()
    .register({ type: "node", regions: { lifecycle: chart("node-lifecycle.json") } })
    .register({ type: "idea", regions: { lifecycle: chart("idea-lifecycle.json") } });
}
