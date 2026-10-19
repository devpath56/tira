// Through the whole stack (write path -> SQLite store -> fold replay): actor guards,
// same-lifecycle cross-entity guards and versioned identity must survive storage and
// replay, not just work in evaluate(). Uses a TOY "ticket" type, not factory tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { Registry } from "../src/tables/registry.ts";
import { validateTable, type Table } from "../src/tables/table.ts";
import { WritePath, type Command, type WriteResult } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";

const STREAM = "tasktree-t";

function table(id: string, initial: string, states: string[], events: string[], spec: Record<string, string>, guards: Record<string, string> = {}): Table {
  const pairs = states.flatMap((from) =>
    events.map((event) => {
      const s = spec[`${from}+${event}`];
      if (!s) return { from, event, outcome: "denied" as const };
      if (s === "noop") return { from, event, outcome: "noop" as const };
      const [to, guard] = s.split("|");
      return { from, event, outcome: "transition" as const, to: to as string, ...(guard ? { guard } : {}) };
    }),
  );
  return validateTable({ id, initial, states, events, pairs, guards });
}

function setup() {
  const approval = table("ticket-approval", "pending", ["pending", "approved"], ["APPROVE"], { "pending+APPROVE": "approved|notAuthor" }, { notAuthor: "actor is not the author" });
  const work = table("ticket-work", "open", ["open", "doing", "shipped"], ["PICK", "SHIP"], {
    "open+PICK": "doing|depsShipped", "doing+SHIP": "shipped",
  }, { depsShipped: "every payload.dependsOn ticket (same version) is shipped" });
  const registry = new Registry({
    // the author is whoever created the entity (recorded by the fold), never a payload claim
    notAuthor: ({ actor, entity }) => actor !== undefined && actor !== entity.createdBy,
    depsShipped: ({ payload, view, entity }) =>
      ((payload.dependsOn as string[] | undefined) ?? []).every(
        (id) => view.get({ type: "ticket", id, version: entity.version ?? 1 })?.regions.work === "shipped",
      ),
  }).register({
    type: "ticket",
    versioned: true,
    regions: { approval, work },
  });
  const store = new SqliteEventStore();
  const wp = new WritePath(store, registry);
  type NoStream = Command extends infer C ? (C extends unknown ? Omit<C, "stream"> : never) : never;
  const submit = (c: NoStream) => wp.submit({ stream: STREAM, ...c } as Command);
  const create = (id: string, version: number, author: string) =>
    submit({ kind: "create", entity: { type: "ticket", id, version }, actor: author });
  const send = (id: string, version: number, event: string, actor: string, payload: Record<string, unknown> = {}) =>
    submit({ kind: "event", entity: { type: "ticket", id, version }, event, actor, payload });
  const replay = async () => fold(await store.readAll(), registry);
  return { create, send, replay, store };
}

const status = (r: WriteResult) => (r.status === "rejected" ? `rejected:${r.code}` : r.status === "appended" ? `appended:${r.outcome}` : r.status);

test("actor guard through the stack: author can't approve; reviewer can; replay agrees (no anomalies)", async () => {
  const t = setup();
  await t.create("a", 1, "dev");
  assert.equal(status(await t.send("a", 1, "APPROVE", "dev")), "rejected:guard-failed");
  assert.equal(status(await t.send("a", 1, "APPROVE", "pm")), "appended:transition");
  const r = await t.replay();
  assert.deepEqual(r.anomalies, []); // replay re-ran the actor guard with the stored actor
  assert.equal(r.entities[0]?.regions.approval, "approved");
  assert.equal(r.entities[0]?.createdBy, "dev");
  assert.equal(r.entities[0]?.lastActor, "pm");
});

test("cross-entity guard through the stack: PICK waits for its dependency to ship", async () => {
  const t = setup();
  for (const id of ["dep", "a"]) {
    await t.create(id, 1, "dev");
    await t.send(id, 1, "APPROVE", "pm");
  }
  assert.equal(status(await t.send("a", 1, "PICK", "s1", { dependsOn: ["dep"] })), "rejected:guard-failed");
  await t.send("dep", 1, "PICK", "s2");
  await t.send("dep", 1, "SHIP", "s2");
  assert.equal(status(await t.send("a", 1, "PICK", "s1", { dependsOn: ["dep"] })), "appended:transition");
  assert.deepEqual((await t.replay()).anomalies, []);
});

test("versioned identity through the stack: versions are stored, replayed and kept apart", async () => {
  const t = setup();
  await t.create("a", 1, "dev");
  await t.send("a", 1, "APPROVE", "pm");
  await t.create("a", 2, "dev");
  const r = await t.replay();
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(
    r.entities.map((e) => `${e.key} v${e.version} ${e.regions.approval}`),
    ["ticket:a@1 v1 approved", "ticket:a@2 v2 pending"],
  );
  const [created] = await t.store.readAll();
  assert.deepEqual((created?.data as { entity: unknown }).entity, { id: "a", version: 1 });
});

test("regions stay independent through the stack: one region's event never reads another", async () => {
  const t = setup();
  await t.create("a", 1, "dev");
  // No cross-region invariant exists any more: PICK lands while approval is pending.
  assert.equal(status(await t.send("a", 1, "PICK", "s1")), "appended:transition");
  const r = await t.replay();
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.entities[0]?.regions, { approval: "pending", work: "doing" });
});
