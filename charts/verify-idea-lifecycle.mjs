// Verification for idea-lifecycle.mjs — mirrors the node chart's checks.
// Run: node verify-idea-lifecycle.mjs
import { createMachine, createActor } from "xstate";
import { ideaLifecycle } from "./idea-lifecycle.mjs";

const STATES = ["declared", "file_pending", "filed", "node_pending", "materialized", "dropped"];
const EVENTS = ["DRAFT_FILE", "APPROVE_FILE", "REJECT_FILE", "PROPOSE_NODE", "APPROVE_NODE", "REJECT_NODE"];
const machine = createMachine(ideaLifecycle);
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log("FAIL:", name)); };

const run = (events) => {
  const actor = createActor(machine).start();
  for (const e of events) actor.send(typeof e === "string" ? { type: e } : e);
  const s = actor.getSnapshot().value;
  actor.stop();
  return s;
};

// 1. All 36 pairs enumerated and classified
const table = {};
for (const st of STATES) {
  table[st] = {};
  for (const ev of EVENTS) {
    // reach the state first via a known-good path
    const pathTo = {
      declared: [], file_pending: ["DRAFT_FILE"], filed: ["DRAFT_FILE", "APPROVE_FILE"],
      node_pending: ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"],
      materialized: ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE", "APPROVE_NODE"],
      dropped: ["DRAFT_FILE", { type: "REJECT_FILE", reason: "nope" }],
    }[st];
    const before = run(pathTo);
    if (before !== st) { table[st][ev] = "UNREACHABLE-SETUP"; continue; }
    const after = run([...pathTo, { type: ev, reason: "r" }]);
    table[st][ev] = after === st ? "no-op/invalid" : `-> ${after}`;
  }
}
console.log("=== 36-pair table ===");
for (const st of STATES) console.log(st, JSON.stringify(table[st]));

// 2. Expected matrix (the contract)
const expected = {
  declared:     { DRAFT_FILE: "-> file_pending", APPROVE_FILE: "no-op/invalid", REJECT_FILE: "no-op/invalid", PROPOSE_NODE: "no-op/invalid", APPROVE_NODE: "no-op/invalid", REJECT_NODE: "no-op/invalid" },
  file_pending: { DRAFT_FILE: "no-op/invalid", APPROVE_FILE: "-> filed", REJECT_FILE: "-> dropped", PROPOSE_NODE: "no-op/invalid", APPROVE_NODE: "no-op/invalid", REJECT_NODE: "no-op/invalid" },
  filed:        { DRAFT_FILE: "no-op/invalid", APPROVE_FILE: "no-op/invalid", REJECT_FILE: "no-op/invalid", PROPOSE_NODE: "-> node_pending", APPROVE_NODE: "no-op/invalid", REJECT_NODE: "no-op/invalid" },
  node_pending: { DRAFT_FILE: "no-op/invalid", APPROVE_FILE: "no-op/invalid", REJECT_FILE: "no-op/invalid", PROPOSE_NODE: "no-op/invalid", APPROVE_NODE: "-> materialized", REJECT_NODE: "-> dropped" },
  materialized: { DRAFT_FILE: "no-op/invalid", APPROVE_FILE: "no-op/invalid", REJECT_FILE: "no-op/invalid", PROPOSE_NODE: "no-op/invalid", APPROVE_NODE: "no-op/invalid", REJECT_NODE: "no-op/invalid" },
  dropped:      { DRAFT_FILE: "no-op/invalid", APPROVE_FILE: "no-op/invalid", REJECT_FILE: "no-op/invalid", PROPOSE_NODE: "no-op/invalid", APPROVE_NODE: "no-op/invalid", REJECT_NODE: "no-op/invalid" },
};
for (const st of STATES) for (const ev of EVENTS)
  check(`${st} + ${ev}`, table[st][ev] === expected[st][ev]);

// 3. BFS reachability: all 6 states reachable
const seen = new Set(["declared"]);
const q = ["declared"];
const paths = { declared: [] };
while (q.length) {
  const cur = q.shift();
  for (const ev of EVENTS) {
    const nxt = run([...paths[cur], { type: ev, reason: "r" }]);
    if (!seen.has(nxt)) { seen.add(nxt); paths[nxt] = [...paths[cur], { type: ev, reason: "r" }]; q.push(nxt); }
  }
}
check("all 6 states reachable", seen.size === 6);

// 4. No non-final dead ends (every non-final state has an outgoing transition)
for (const st of ["declared", "file_pending", "filed", "node_pending"]) {
  const outs = EVENTS.filter((ev) => table[st][ev].startsWith("->"));
  check(`${st} has an exit`, outs.length > 0);
}

// 5. No-skip: every path to materialized passes through filed
//    BFS over event sequences up to length 8, check the property on arrival.
let violated = false;
const bfs = [{ state: "declared", seq: [], filedSeen: false }];
const visitedSeq = new Set();
while (bfs.length && !violated) {
  const { state, seq, filedSeen } = bfs.shift();
  for (const ev of EVENTS) {
    const evObj = { type: ev, reason: "r" };
    const nxt = run([...seq, evObj]);
    const fs = filedSeen || nxt === "filed";
    if (nxt === "materialized" && !filedSeen && state !== "filed") violated = true;
    const key = nxt + "|" + seq.length;
    if (seq.length < 8 && !visitedSeq.has(key + ev)) { visitedSeq.add(key + ev); bfs.push({ state: nxt, seq: [...seq, evObj], filedSeen: fs }); }
  }
}
check("no path to materialized skips filed", !violated);

// 6. Bare REJECT stays; reasoned REJECT drops
check("bare REJECT_FILE stays file_pending", run(["DRAFT_FILE", "REJECT_FILE"]) === "file_pending");
check("reasoned REJECT_FILE -> dropped", run(["DRAFT_FILE", { type: "REJECT_FILE", reason: "dup" }]) === "dropped");
check("bare REJECT_NODE stays node_pending",
  run(["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE", "REJECT_NODE"]) === "node_pending");

// 7. Double-approve idempotent
check("double APPROVE_FILE idempotent",
  run(["DRAFT_FILE", "APPROVE_FILE", "APPROVE_FILE"]) === "filed");
check("double APPROVE_NODE idempotent",
  run(["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE", "APPROVE_NODE", "APPROVE_NODE"]) === "materialized");

// 8. The key guards: no-skip denials
check("APPROVE_NODE from filed denied", run(["DRAFT_FILE", "APPROVE_FILE", "APPROVE_NODE"]) === "filed");
check("PROPOSE_NODE from declared denied", run(["PROPOSE_NODE"]) === "declared");
check("DRAFT_FILE from filed denied", run(["DRAFT_FILE", "APPROVE_FILE", "DRAFT_FILE"]) === "filed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
