// How intents become stored events, and back. Provisional naming, pending the
// event catalogue (acceptance review M1 / Q3): "<entityType>.created" and
// "<entityType>.<TABLE_EVENT>" (e.g. "node.START"), plus "command.rejected".
import type { NewEvent, StoredEvent } from "../store/types.ts";
import type { EntityRef } from "./types.ts";
import type { Intent, RejectCode } from "./evaluate.ts";

export const REJECTED = "command.rejected";
const CREATED = "created";

export interface EventData {
  entity: { id: string; version?: number };
  payload: Record<string, unknown>;
}

export interface RejectedData {
  intent: Intent;
  reason: { code: RejectCode; detail: string };
}

const refData = (e: EntityRef): EventData["entity"] =>
  e.version !== undefined ? { id: e.id, version: e.version } : { id: e.id };

export function toNewEvent(intent: Intent, eventId?: string): NewEvent {
  const type = intent.kind === "create" ? `${intent.entity.type}.${CREATED}` : `${intent.entity.type}.${intent.event}`;
  const data: EventData = { entity: refData(intent.entity), payload: intent.payload };
  return {
    ...(eventId ? { eventId } : {}),
    type,
    data: data as unknown as Record<string, unknown>,
    ...(intent.actor !== undefined ? { metadata: { actor: intent.actor } } : {}),
  };
}

export function toRejectedEvent(intent: Intent, code: RejectCode, detail: string, eventId?: string): NewEvent {
  const data: RejectedData = { intent, reason: { code, detail } };
  return {
    ...(eventId ? { eventId } : {}),
    type: REJECTED,
    data: data as unknown as Record<string, unknown>,
    ...(intent.actor !== undefined ? { metadata: { actor: intent.actor } } : {}),
  };
}

// Inverse of toNewEvent. Returns undefined for event types this core doesn't own.
export function toIntent(e: StoredEvent): Intent | undefined {
  if (e.type === REJECTED) return undefined;
  const dot = e.type.indexOf(".");
  if (dot <= 0) return undefined;
  const type = e.type.slice(0, dot);
  const name = e.type.slice(dot + 1);
  const data = e.data as unknown as EventData;
  if (!data?.entity || typeof data.entity.id !== "string") return undefined;
  const entity: EntityRef =
    data.entity.version !== undefined ? { type, id: data.entity.id, version: data.entity.version } : { type, id: data.entity.id };
  const payload = data.payload ?? {};
  const actor = e.metadata.actor;
  return name === CREATED
    ? { kind: "create", entity, payload, actor }
    : { kind: "event", entity, event: name, payload, actor };
}
