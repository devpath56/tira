// Derived-state shapes shared by the registry, write path and fold.

export interface EntityRef {
  type: string;
  id: string;
  version?: number; // required for versioned entity types, forbidden otherwise
}

// Tree position of an entity whose type declares a tree (registry `tree`).
export interface TreeInfo {
  parent?: string; // parent key; absent for a root
  children: string[]; // child keys in birth order (append-at-end, ruling 1)
  depth: number; // root = 1
  kind: "planned" | "discovered"; // provenance (functional requirements: "planned or discovered")
  discoveredDuring?: string; // key of the task it was found during, when discovered
}

export interface EntityState {
  stream: string; // entities are namespaced by stream (one stream per tree)
  type: string;
  id: string;
  version?: number;
  key: string; // "type:id" or "type:id@version" — unique within its stream
  regions: Record<string, string>; // region name -> current state
  createdSeq: number;
  lastSeq: number;
  lastRecordedAt: string; // store time of the last applied event (for derived predicates)
  createdBy?: string; // actor of the create event (provenance)
  lastActor?: string; // actor of the last applied event
  tree?: TreeInfo;
}

// Read-only access to the state of one stream, as of the event being evaluated.
export interface StateView {
  get(ref: EntityRef): EntityState | undefined;
  getKey(key: string): EntityState | undefined;
  all(type?: string): EntityState[];
}

export const entityKey = (ref: EntityRef): string => {
  const version = ref.version === undefined ? "" : `@${ref.version}`;
  return `${ref.type}:${ref.id}${version}`;
};
