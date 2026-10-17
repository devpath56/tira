// Derived-state shapes shared by the registry, write path and fold.

export interface EntityRef {
  type: string;
  id: string;
  version?: number; // required for versioned entity types, forbidden otherwise
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
}

// Read-only access to the state of one stream, as of the event being evaluated.
export interface StateView {
  get(ref: EntityRef): EntityState | undefined;
  all(type?: string): EntityState[];
}

export const entityKey = (ref: EntityRef): string =>
  `${ref.type}:${ref.id}${ref.version !== undefined ? `@${ref.version}` : ""}`;
