// Entity-type registry: entity type -> one or more transition tables (regions).
// B0 (b0-factory-mapping.md G1–G3) showed the core needs more than one dial per
// entity, more than one entity type, and versioned identity. The registry carries
// those as data, so new vocabularies (the factory's brief/session/drop) are added
// by registering tables, not by changing the runner.
//
// Regions are coupled ONLY by handoff events (regions proposal, signed off
// 2026-10-17): there is no cross-region invariant hook. Same-lifecycle rules — the
// tree's drain and one-active gates — are declared under `tree` and read only
// entities of the same type in the same stream.
import { DEFAULT_GUARDS, loadTable, type GuardFn, type Table } from "./table.ts";
import type { EntityState, StateView } from "../fold/types.ts";
import { TABLE_EVENT_NAME } from "../fold/events.ts";

// Derived predicates see the entity (incl. lastRecordedAt / lastActor), the rest of
// its stream, and the caller's clock and vantage. Nothing else — so they stay pure.
export interface DeriveContext {
  now: string | undefined; // ISO-8601; derived predicates may depend on time
  vantage: string | undefined; // which observer is asking (B0 G6)
  view: StateView; // the entity's own stream
}

// A same-lifecycle tree over one region of one entity type (Track C1).
export interface TreeConfig {
  region: string; // the region whose states the tree reads
  terminal: string[]; // states that count as finished for drain (node: done, cancelled)
  actionable: string[]; // states the cursor can land on (node: unstarted, in_progress)
  active: string; // the "working" state (node: in_progress)
  childEvent: string; // table event the parent must accept to take a child (ADD_CHILD)
  completeEvent?: string; // gated: only when every child is terminal (COMPLETE)
  oneActive?: boolean; // gate: at most one active node per stream (ruling A4)
  maxDepth: number; // root = 1 (ruling 1: 8)
  maxChildren: number; // per parent (ruling 1: 20)
}

export interface EntityTypeDef {
  type: string;
  // Region name -> table. One region = one dial; several = parallel dimensions.
  // Each event belongs to exactly one region (checked on register).
  regions: Record<string, Table>;
  versioned?: boolean;
  // Name of the birth event, UPPER_SNAKE like table events (stored lowercase-kebab).
  // Default CREATED. Node: BORN -> "node.born" (decided 2026-10-17).
  createdAs?: string;
  tree?: TreeConfig;
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
    const created = def.createdAs ?? "CREATED";
    if (!TABLE_EVENT_NAME.test(created)) throw new Error(`entity type ${def.type}: createdAs ${created} must be UPPER_SNAKE`);
    const events = new Map<string, { region: string; table: Table }>();
    for (const region of regionNames) {
      const table = def.regions[region] as Table;
      for (const ev of table.events) {
        // Stored names are derived mechanically from these (fold/events.ts); keep it a bijection.
        if (!TABLE_EVENT_NAME.test(ev)) throw new Error(`table ${table.id}: event ${ev} must be UPPER_SNAKE`);
        if (ev === "CREATED" || ev === created) throw new Error(`table ${table.id}: event name ${ev} is reserved`);
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
    if (def.tree) this.checkTree(def, def.tree);
    this.defs.set(def.type, def);
    this.byEvent.set(def.type, events);
    return this;
  }

  private checkTree(def: EntityTypeDef, t: TreeConfig): void {
    const fail = (msg: string): never => {
      throw new Error(`entity type ${def.type}: tree ${msg}`);
    };
    const table = def.regions[t.region];
    if (!table) return fail(`region ${t.region} is not a region of this type`);
    for (const s of [...t.terminal, ...t.actionable, t.active]) {
      if (!table.states.includes(s)) fail(`state ${s} is not in table ${table.id}`);
    }
    for (const ev of [t.childEvent, t.completeEvent].filter((e): e is string => e !== undefined)) {
      if (!table.events.includes(ev)) fail(`event ${ev} is not in table ${table.id}`);
    }
    if (def.versioned) fail("types must not be versioned (parent links are by id)");
    if (!(t.maxDepth >= 1 && t.maxChildren >= 1)) fail("caps must be >= 1");
  }

  get(type: string): EntityTypeDef | undefined {
    return this.defs.get(type);
  }

  types(): EntityTypeDef[] {
    return [...this.defs.values()];
  }

  // Birth event name (UPPER_SNAKE) for a type; CREATED for unknown types too.
  creationName(type: string): string {
    return this.defs.get(type)?.createdAs ?? "CREATED";
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
// and vapor ideas. Factory tables (B1) are added here once wired.
export function defaultRegistry(): Registry {
  return new Registry()
    .register({
      type: "node",
      createdAs: "BORN",
      regions: { lifecycle: chart("node-lifecycle.json") },
      tree: {
        region: "lifecycle",
        terminal: ["done", "cancelled"],
        actionable: ["unstarted", "in_progress"],
        active: "in_progress",
        childEvent: "ADD_CHILD",
        completeEvent: "COMPLETE",
        oneActive: true,
        maxDepth: 8,
        maxChildren: 20,
      },
    })
    .register({ type: "idea", regions: { lifecycle: chart("idea-lifecycle.json") } });
}
