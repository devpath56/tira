// A3 — registry: several entity types, parallel regions with a cross-region
// invariant, versioned identity, and guards that read fold state and the actor.
// The 2-region "ticket" type here is a TOY that exercises the mechanism; it is not
// the factory's brief table (that waits on Q-B1–Q-B10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, defaultRegistry } from "../src/tables/registry.ts";
import { validateTable, type Table } from "../src/tables/table.ts";
import { evaluate, type Intent } from "../src/fold/evaluate.ts";
import { makeView } from "../src/fold/fold.ts";
import { entityKey, type EntityState } from "../src/fold/types.ts";

// Build a complete table from a sparse spec; every unspecified pair is denied.
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

const approval = table("ticket-approval", "pending", ["pending", "approved"], ["APPROVE"], { "pending+APPROVE": "approved|notSelf" }, { notSelf: "actor is not the author" });
const work = table("ticket-work", "open", ["open", "doing", "shipped"], ["PICK", "SHIP"], {
  "open+PICK": "doing|depsShipped", "doing+PICK": "noop", "doing+SHIP": "shipped",
}, { depsShipped: "every payload.dependsOn ticket is shipped" });

function toyRegistry(): Registry {
  return new Registry({
    notSelf: ({ actor, payload }) => actor !== undefined && actor !== payload.author,
    depsShipped: ({ payload, view }) =>
      ((payload.dependsOn as string[] | undefined) ?? []).every(
        (id) => view.get({ type: "ticket", id, version: 1 })?.regions.work === "shipped",
      ),
  }).register({
    type: "ticket",
    versioned: true,
    regions: { approval, work },
    // cross-region invariant: no work before approval
    invariant: (r) => (r.work !== "open" && r.approval !== "approved" ? "work started before approval" : true),
  });
}

const ent = (id: string, regions: Record<string, string>, version = 1): EntityState => ({
  stream: "s", type: "ticket", id, version, key: entityKey({ type: "ticket", id, version }), regions,
  createdSeq: 1, lastSeq: 1, lastRecordedAt: "2026-10-16T00:00:00.000Z",
});
const ev = (id: string, event: string, payload: Record<string, unknown> = {}, actor?: string, version = 1): Intent => ({
  kind: "event", entity: { type: "ticket", id, version }, event, payload, actor,
});
const run = (reg: Registry, list: EntityState[], intent: Intent) => {
  const m = new Map(list.map((e) => [e.key, e]));
  return evaluate(reg, m, makeView(m), intent);
};

test("default registry: node and idea, one region each, loaded from charts/*.json", () => {
  const r = defaultRegistry();
  assert.equal(r.resolve("node", "COMPLETE")?.region, "lifecycle");
  assert.equal(r.resolve("idea", "APPROVE_FILE")?.table.id, "idea-lifecycle");
  assert.equal(r.resolve("node", "APPROVE_FILE"), undefined);
});

test("register refuses an event claimed by two regions", () => {
  const dup = table("dup", "open", ["open"], ["PICK"], {});
  const reg = new Registry({ depsShipped: () => true });
  assert.throws(() => reg.register({ type: "bad", regions: { work, dup } }), /event PICK in regions work and dup/);
});

test("register refuses a table whose guard has no implementation", () => {
  assert.throws(() => new Registry().register({ type: "t", regions: { approval } }), /guard notSelf has no implementation/);
});

test("an event moves only its own region; the others are untouched", () => {
  const r = run(toyRegistry(), [ent("a", { approval: "pending", work: "open" })], ev("a", "APPROVE", { author: "dev" }, "pm"));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.regions, { approval: "approved", work: "open" });
});

test("cross-region invariant rejects an otherwise legal transition", () => {
  // Bypass the guard order: an approved-less ticket picking work violates the invariant.
  const reg = toyRegistry();
  const r = run(reg, [ent("a", { approval: "pending", work: "open" })], ev("a", "PICK"));
  assert.deepEqual(r, { ok: false, code: "invariant", detail: "work started before approval" });
});

test("actor guard: the author cannot approve their own ticket", () => {
  const reg = toyRegistry();
  const self = run(reg, [ent("a", { approval: "pending", work: "open" })], ev("a", "APPROVE", { author: "dev" }, "dev"));
  assert.equal(self.ok ? "ok" : self.code, "guard-failed");
  const anon = run(reg, [ent("a", { approval: "pending", work: "open" })], ev("a", "APPROVE", { author: "dev" }));
  assert.equal(anon.ok ? "ok" : anon.code, "guard-failed");
});

test("state guard reads other entities through the view", () => {
  const reg = toyRegistry();
  const a = ent("a", { approval: "approved", work: "open" });
  const depOpen = ent("dep", { approval: "approved", work: "doing" });
  const blocked = run(reg, [a, depOpen], ev("a", "PICK", { dependsOn: ["dep"] }));
  assert.equal(blocked.ok ? "ok" : blocked.code, "guard-failed");
  const depShipped = ent("dep", { approval: "approved", work: "shipped" });
  const ok = run(reg, [a, depShipped], ev("a", "PICK", { dependsOn: ["dep"] }));
  assert.ok(ok.ok && ok.regions.work === "doing");
});

test("versioned identity: version required, versions are separate entities", () => {
  const reg = toyRegistry();
  const noVersion = evaluate(reg, new Map(), makeView(new Map()), { kind: "create", entity: { type: "ticket", id: "a" }, payload: {}, actor: undefined });
  assert.equal(noVersion.ok ? "ok" : noVersion.code, "version-required");
  const v1 = ent("a", { approval: "approved", work: "shipped" }, 1);
  const createV2 = run(reg, [v1], { kind: "create", entity: { type: "ticket", id: "a", version: 2 }, payload: {}, actor: undefined });
  assert.ok(createV2.ok && createV2.key === "ticket:a@2");
  assert.deepEqual(createV2.ok && createV2.regions, { approval: "pending", work: "open" });
  const nodeWithVersion = evaluate(defaultRegistry(), new Map(), makeView(new Map()), {
    kind: "create", entity: { type: "node", id: "n", version: 1 }, payload: {}, actor: undefined,
  });
  assert.equal(nodeWithVersion.ok ? "ok" : nodeWithVersion.code, "version-forbidden");
});
