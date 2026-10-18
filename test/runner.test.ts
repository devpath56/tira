// A3 — table runner. The outcome matrices below are written by hand from the
// rulings (chart comments; README rule 7), NOT generated from the JSON. They are
// the control the acceptance review found missing: a JSON or chart change that
// flips a no-op to denied (or back) passes all 273 chart checks, but fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTable, step, validateTable, DEFAULT_GUARDS, type Table } from "../src/tables/table.ts";
import type { EntityState, StateView } from "../src/fold/types.ts";

const node = loadTable(new URL("../charts/node-lifecycle.json", import.meta.url));
const idea = loadTable(new URL("../charts/idea-lifecycle.json", import.meta.url));

// T = transition (target), N = valid no-op (appended, state unchanged), D = denied (rejected).
const NODE_EXPECTED: Record<string, Record<string, string>> = {
  unstarted: { START: "T:in_progress", BLOCK: "T:blocked", CANCEL: "T:cancelled", ADD_CHILD: "N", COMPLETE: "D", UNBLOCK: "D", REOPEN: "D" },
  // START no-op: ruled 2026-10-16 (duplicates stay no-ops). COMPLETE needs evidence.
  in_progress: { START: "N", BLOCK: "T:blocked", CANCEL: "T:cancelled", ADD_CHILD: "N", COMPLETE: "T:done", UNBLOCK: "D", REOPEN: "D" },
  blocked: { START: "D", BLOCK: "N", CANCEL: "T:cancelled", ADD_CHILD: "N", COMPLETE: "D", UNBLOCK: "T:in_progress", REOPEN: "D" },
  // CANCEL denied: done -> cancelled forbidden (ruled). ADD_CHILD denied: re-open first (ruled).
  done: { START: "D", BLOCK: "D", CANCEL: "D", ADD_CHILD: "D", COMPLETE: "N", UNBLOCK: "D", REOPEN: "T:in_progress" },
  cancelled: { START: "D", BLOCK: "D", CANCEL: "N", ADD_CHILD: "D", COMPLETE: "D", UNBLOCK: "D", REOPEN: "D" },
};

const IDEA_EXPECTED: Record<string, Record<string, string>> = {
  declared: { DRAFT_FILE: "T:file_pending", APPROVE_FILE: "D", REJECT_FILE: "D", PROPOSE_NODE: "D", APPROVE_NODE: "D", REJECT_NODE: "D" },
  file_pending: { DRAFT_FILE: "N", APPROVE_FILE: "T:filed", REJECT_FILE: "T:dropped", PROPOSE_NODE: "D", APPROVE_NODE: "D", REJECT_NODE: "D" },
  filed: { DRAFT_FILE: "D", APPROVE_FILE: "N", REJECT_FILE: "D", PROPOSE_NODE: "T:node_pending", APPROVE_NODE: "D", REJECT_NODE: "D" },
  node_pending: { DRAFT_FILE: "D", APPROVE_FILE: "D", REJECT_FILE: "D", PROPOSE_NODE: "N", APPROVE_NODE: "T:materialized", REJECT_NODE: "T:dropped" },
  materialized: { DRAFT_FILE: "D", APPROVE_FILE: "D", REJECT_FILE: "D", PROPOSE_NODE: "D", APPROVE_NODE: "N", REJECT_NODE: "D" },
  dropped: { DRAFT_FILE: "D", APPROVE_FILE: "D", REJECT_FILE: "N", PROPOSE_NODE: "D", APPROVE_NODE: "D", REJECT_NODE: "N" },
};

const entity = (state: string): EntityState => ({
  stream: "s", type: "t", id: "x", key: "t:x", regions: { lifecycle: state }, createdSeq: 1, lastSeq: 1,
  lastRecordedAt: "2026-10-16T00:00:00.000Z",
});
const emptyView: StateView = { get: () => undefined, getKey: () => undefined, all: () => [] };
const full = { evidenceRef: "e", reason: "r" };

function code(t: Table, from: string, ev: string): string {
  const r = step(t, from, ev, DEFAULT_GUARDS, { payload: full, actor: undefined, entity: entity(from), view: emptyView });
  return r.outcome === "transition" ? `T:${r.to}` : r.outcome === "noop" ? "N" : "D";
}

for (const [name, table, expected] of [
  ["node", node, NODE_EXPECTED],
  ["idea", idea, IDEA_EXPECTED],
] as const) {
  test(`${name}: every state x event has the ruled outcome (transition / no-op / denied)`, () => {
    let n = 0;
    for (const st of table.states) {
      for (const ev of table.events) {
        assert.equal(code(table, st, ev), expected[st]?.[ev], `${name} ${st} + ${ev}`);
        n++;
      }
    }
    assert.equal(n, table.states.length * table.events.length);
    assert.equal(Object.keys(expected).length, table.states.length);
  });
}

test("guards: bare COMPLETE and bare REOPEN fail the guard (distinct from denied)", () => {
  const ctx = (from: string) => ({ payload: {}, actor: undefined, entity: entity(from), view: emptyView });
  assert.deepEqual(step(node, "in_progress", "COMPLETE", DEFAULT_GUARDS, ctx("in_progress")), {
    outcome: "guard-failed", from: "in_progress", to: "in_progress", guard: "hasEvidenceRef",
  });
  assert.equal(step(node, "done", "REOPEN", DEFAULT_GUARDS, ctx("done")).outcome, "guard-failed");
  assert.equal(step(idea, "file_pending", "REJECT_FILE", DEFAULT_GUARDS, ctx("file_pending")).outcome, "guard-failed");
  // empty string, numbers, objects and arrays are not evidence; neither is a non-string reason
  for (const evidenceRef of ["", 123, { file: "x" }, ["x"], true]) {
    const c = { payload: { evidenceRef }, actor: undefined, entity: entity("in_progress"), view: emptyView };
    assert.equal(step(node, "in_progress", "COMPLETE", DEFAULT_GUARDS, c).outcome, "guard-failed", JSON.stringify(evidenceRef));
  }
  const numericReason = { payload: { reason: 42 }, actor: undefined, entity: entity("done"), view: emptyView };
  assert.equal(step(node, "done", "REOPEN", DEFAULT_GUARDS, numericReason).outcome, "guard-failed");
});

test("unknown event is denied, not an exception", () => {
  const r = step(node, "unstarted", "TELEPORT", DEFAULT_GUARDS, {
    payload: {}, actor: undefined, entity: entity("unstarted"), view: emptyView,
  });
  assert.equal(r.outcome, "denied");
});

test("validateTable refuses malformed tables", () => {
  const clone = (): Table => JSON.parse(JSON.stringify(node)) as Table;
  const missing = clone();
  missing.pairs.pop();
  assert.throws(() => validateTable(missing), /expected 35 pairs/);
  const badTarget = clone();
  (badTarget.pairs.find((p) => p.outcome === "transition") as { to: string }).to = "limbo";
  assert.throws(() => validateTable(badTarget), /bad target/);
  const noopWithTarget = clone();
  (noopWithTarget.pairs.find((p) => p.outcome === "noop") as { to?: string }).to = "done";
  assert.throws(() => validateTable(noopWithTarget), /must not carry/);
  const undeclaredGuard = clone();
  (undeclaredGuard.pairs.find((p) => p.guard) as { guard: string }).guard = "isFriday";
  assert.throws(() => validateTable(undeclaredGuard), /not declared/);
});

test("a guard declared in a table but not implemented fails loudly at step time", () => {
  const t = JSON.parse(JSON.stringify(node)) as Table;
  assert.throws(
    () => step(t, "in_progress", "COMPLETE", {}, { payload: full, actor: undefined, entity: entity("in_progress"), view: emptyView }),
    /no implementation for guard hasEvidenceRef/,
  );
});
