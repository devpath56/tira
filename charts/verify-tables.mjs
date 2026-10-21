// Differential proof: JSON tables === XState machines.
// For every state x event x guard-polarity, the JSON runner and the XState
// actor must land in the same state. Exit code gates the push (q09).
// Run: node charts/verify-tables.mjs  (after extract-tables.mjs)
import { createMachine, createActor } from "xstate";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeLifecycle } from "./node-lifecycle.mjs";
import { ideaLifecycle } from "./idea-lifecycle.mjs";
import { loadTable, run as runJson } from "./transition-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Code-unit order, so the comparison never depends on the machine's locale.
const byCodeUnit = (a, b) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
let pass = 0,
  fail = 0;
const check = (n, c) => {
  c ? pass++ : (fail++, console.log("FAIL:", n));
};

const runX = (machine, events) => {
  const actor = createActor(machine).start();
  for (const e of events) actor.send(typeof e === "string" ? { type: e } : e);
  const s = actor.getSnapshot().value;
  actor.stop();
  return s;
};

const nodePathTo = {
  unstarted: [],
  in_progress: ["START"],
  blocked: ["START", { type: "BLOCK", reason: "r" }],
  done: ["START", { type: "COMPLETE", evidenceRef: "e" }],
  cancelled: ["CANCEL"],
};
const claimPathTo = {
  declared: [],
  file_pending: ["DRAFT_FILE"],
  filed: ["DRAFT_FILE", "APPROVE_FILE"],
  node_pending: ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE"],
  materialized: ["DRAFT_FILE", "APPROVE_FILE", "PROPOSE_NODE", "APPROVE_NODE"],
  dropped: ["DRAFT_FILE", { type: "REJECT_FILE", reason: "nope" }],
};

function diff(name, chart, jsonFile, pathTo) {
  const table = loadTable(join(HERE, jsonFile));
  const machine = createMachine(chart);
  const states = Object.keys(chart.states);
  const events = [...new Set(states.flatMap((s) => Object.keys(chart.states[s].on ?? {})))];

  // structural criteria (q01)
  check(`${name}: pair count = ${states.length * events.length}`, table.pairs.length === states.length * events.length);
  check(`${name}: states identical`, JSON.stringify(table.states) === JSON.stringify(states));
  check(`${name}: events identical`, JSON.stringify([...table.events].sort(byCodeUnit)) === JSON.stringify([...events].sort(byCodeUnit)));
  check(`${name}: initial identical`, table.initial === chart.initial);
  for (const p of table.pairs)
    if (p.guard) check(`${name}: guard ${p.guard} registered`, p.guard in table.guards);

  // outcome equivalence on every pair x guard-polarity (q01, q03)
  let n = 0;
  for (const st of states) {
    check(`${name}: setup reaches ${st} (xstate)`, runX(machine, pathTo[st]) === st);
    check(`${name}: setup reaches ${st} (json)`, runJson(table, pathTo[st]) === st);
    for (const ev of events) {
      for (const payload of [{ type: ev }, { type: ev, evidenceRef: "e", reason: "r" }]) {
        const x = runX(machine, [...pathTo[st], payload]);
        const j = runJson(table, [...pathTo[st], payload]);
        n++;
        if (x !== j) {
          fail++;
          console.log(`FAIL: ${name} ${st}+${ev} payload=${JSON.stringify(payload)}: xstate=${x} json=${j}`);
        } else pass++;
      }
    }
  }
  console.log(`${name}: ${n} differential pairs agree`);
}

diff("node", nodeLifecycle, "node-lifecycle.json", nodePathTo);
diff("idea", ideaLifecycle, "idea-lifecycle.json", claimPathTo);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
