// How intents become stored events, and back.
//
// Stored type = "<entityType>.<name>", always lowercase (D1, decided 2026-10-16):
//   - create             -> "node.created"
//   - table event START  -> "node.start";  ADD_CHILD -> "node.add-child"
//   - a rejected command -> "command.rejected"
// The mapping from table events (UPPER_SNAKE in charts/*.json) is mechanical:
// lowercase, "_" -> "-". It matches the factory's own names (`brief.drop-written`
// for a DROP_WRITTEN table event). It is a bijection because table event names
// must match /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/ and CREATED is reserved (registry).
import type { NewEvent, StoredEvent } from "../store/types.ts";
import type { EntityRef } from "./types.ts";
import type { Intent, RejectCode } from "./evaluate.ts";

export const REJECTED = "command.rejected";
const CREATED = "created";

export const TABLE_EVENT_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const STORED_EVENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const storedName = (tableEvent: string): string => tableEvent.toLowerCase().replaceAll("_", "-");
export const tableEventName = (stored: string): string => stored.toUpperCase().replaceAll("-", "_");

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
  const name = intent.kind === "create" ? CREATED : storedName(intent.event);
  const data: EventData = { entity: refData(intent.entity), payload: intent.payload };
  return {
    ...(eventId ? { eventId } : {}),
    type: `${intent.entity.type}.${name}`,
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

// Inverse of toNewEvent. Returns undefined for event types this core doesn't own,
// including any stored name that isn't lowercase-kebab (e.g. a legacy "node.START").
export function toIntent(e: StoredEvent): Intent | undefined {
  if (e.type === REJECTED) return undefined;
  const dot = e.type.indexOf(".");
  if (dot <= 0) return undefined;
  const type = e.type.slice(0, dot);
  const name = e.type.slice(dot + 1);
  if (!STORED_EVENT_NAME.test(name)) return undefined;
  const data = e.data as unknown as EventData;
  if (!data?.entity || typeof data.entity.id !== "string") return undefined;
  const entity: EntityRef =
    data.entity.version !== undefined ? { type, id: data.entity.id, version: data.entity.version } : { type, id: data.entity.id };
  const payload = data.payload ?? {};
  const actor = e.metadata.actor;
  return name === CREATED
    ? { kind: "create", entity, payload, actor }
    : { kind: "event", entity, event: tableEventName(name), payload, actor };
}
