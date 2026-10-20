// The B3 blind fixture (fixtures/b3): both files keep their published format, and tira's
// side is a genuine log. Nothing here knows or reveals the planted divergences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultRegistry } from "../src/tables/registry.ts";
import { fold } from "../src/fold/fold.ts";
import { storedName, tableEventName } from "../src/fold/events.ts";
import { fxKey, transitionOf } from "../src/write/fxkey.ts";
import { isIsoTime } from "../src/time.ts";
import { FX_KEY } from "../src/tables/factory.ts";
import type { StoredEvent } from "../src/store/types.ts";

const DIR = new URL("../fixtures/b3/", import.meta.url);
const lines = (f: string) => readFileSync(new URL(f, DIR), "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);
const FIELDS = ["actor", "entity_id", "entity_type", "event_id", "outcome", "transition_kind", "ts"];

test("factory-state.jsonl: one record per committed transition, in the locked format", () => {
  const records = lines("factory-state.jsonl") as Record<string, unknown>[];
  assert.ok(records.length >= 30 + 8, `${records.length} records`);
  for (const [i, r] of records.entries()) {
    const at = `line ${i + 1}`;
    assert.deepEqual(Object.keys(r).sort(), FIELDS, at);
    for (const f of FIELDS) assert.equal(typeof r[f], "string", `${at}: ${f}`);
    assert.match(r.transition_kind as string, /^[A-Z][A-Z_]*$/, at);
    assert.ok(["brief", "session", "drop"].includes(r.entity_type as string), at);
    assert.match(r.entity_id as string, r.entity_type === "session" ? /^[^@]+$/ : /^[^@]+@\d+$/, at);
    assert.ok(isIsoTime(r.ts) && (r.ts as string).endsWith("Z"), `${at}: ts`);
    assert.ok(["created", "transition", "noop"].includes(r.outcome as string), at);
    assert.match(r.event_id as string, FX_KEY, at);
  }
  // commit order: the factory appends, so ts never goes back
  const times = records.map((r) => Date.parse(r.ts as string));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("tira-log.jsonl: a genuine tira log: one stream, in seq order, folds with no anomalies, and every fx: id is its own transition's key", () => {
  const registry = defaultRegistry();
  const events = lines("tira-log.jsonl") as StoredEvent[];
  assert.ok(events.length > 0);
  assert.deepEqual([...new Set(events.map((e) => e.stream))], ["factory-b3"]);
  for (let i = 1; i < events.length; i++) assert.ok((events[i] as StoredEvent).seq > (events[i - 1] as StoredEvent).seq, `seq at line ${i + 1}`);
  const r = fold(events, registry);
  assert.deepEqual(r.anomalies, []);
  let checked = 0;
  for (const e of events.filter((x) => x.eventId.startsWith("fx:"))) {
    const d = e.data as { entity?: { id: string; version?: number }; payload?: Record<string, unknown>; intent?: { kind: "create" | "event"; entity: { type: string; id: string; version?: number }; event?: string; payload: Record<string, unknown>; actor?: string } };
    let cmd;
    if (e.type === "command.rejected" && d.intent) {
      cmd = { stream: e.stream, kind: d.intent.kind, entity: d.intent.entity, ...(d.intent.event ? { event: d.intent.event } : {}), ...(d.intent.actor ? { actor: d.intent.actor } : {}), payload: d.intent.payload };
    } else {
      const type = e.type.slice(0, e.type.indexOf("."));
      const entity = { type, id: d.entity?.id as string, ...(d.entity?.version === undefined ? {} : { version: d.entity.version }) };
      const birth = storedName(registry.creationName(type, entity.version)) === e.type.slice(type.length + 1);
      cmd = { stream: e.stream, kind: birth ? ("create" as const) : ("event" as const), entity, ...(birth ? {} : { event: tableEventName(e.type.slice(type.length + 1)) }), ...(e.metadata.actor ? { actor: e.metadata.actor } : {}), payload: d.payload ?? {} };
    }
    assert.equal(fxKey(transitionOf(cmd as Parameters<typeof transitionOf>[0], (t, v) => registry.creationName(t, v))), e.eventId, `${e.type} at seq ${e.seq}`);
    checked++;
  }
  assert.ok(checked >= 30, `${checked} fx: events checked`);
});

test("the fixture's README announces M and the verdict vocabulary", () => {
  const readme = readFileSync(new URL("README.md", DIR), "utf8");
  assert.match(readme, /\*\*M = 8\.\*\*/);
  for (const v of ["OK", "MISSING", "PHANTOM", "WRONG-ENTITY", "DUPLICATE", "ORPHAN"]) assert.ok(readme.includes(`| \`${v}\` |`), v);
});
