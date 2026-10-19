// The fx: key rule (B2, ruling 2026-10-19): a factory transition's tira event id is
//   "fx:" + lowercase hex sha256( canonicalJson({ stream, entity, event, actor, payload }) )
// where entity is { type, id } plus version when the type is versioned, event is the table
// event (UPPER_SNAKE) or, for a birth, the type's birth name (e.g. FILED), actor is the
// trigger (or null), and payload is the command's payload ({} when none). canonicalJson
// sorts keys by UTF-16 code units at every level (fold.ts), and the hash is over its UTF-8
// bytes. The same transition always gives the same key, so a crash-retry returns
// "duplicate" instead of a second row. The write path recomputes the key of every fx: id it
// is sent, so an id that isn't its own transition's key is refused before anything is stored.
import { createHash } from "node:crypto";
import { canonicalJson } from "../fold/fold.ts";
import type { EntityRef } from "../fold/types.ts";

export interface Transition {
  stream: string;
  entity: EntityRef;
  event: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

// The transition a write command describes, in the rule's terms: a create's event is the
// type's birth name for that version (brief v1 CREATED, v2+ REVISED).
export function transitionOf(
  cmd: { stream: string; kind: "create" | "event"; entity: EntityRef; event?: string; actor?: string; payload?: Record<string, unknown> },
  birthName: (type: string, version?: number) => string,
): Transition {
  const event = cmd.kind === "create" ? birthName(cmd.entity.type, cmd.entity.version) : (cmd.event as string);
  return { stream: cmd.stream, entity: cmd.entity, event, ...(cmd.actor === undefined ? {} : { actor: cmd.actor }), ...(cmd.payload === undefined ? {} : { payload: cmd.payload }) };
}

export function fxKey(t: Transition): string {
  const entity = { type: t.entity.type, id: t.entity.id, ...(t.entity.version === undefined ? {} : { version: t.entity.version }) };
  const body = canonicalJson({ stream: t.stream, entity, event: t.event, actor: t.actor ?? null, payload: t.payload ?? {} });
  return `fx:${createHash("sha256").update(body).digest("hex")}`;
}
