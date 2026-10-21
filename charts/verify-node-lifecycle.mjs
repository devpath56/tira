// Verification for node-lifecycle.mjs — mirrors verify-idea-lifecycle.mjs.
// Run: node verify-node-lifecycle.mjs
import { createMachine, createActor } from "xstate";
import { nodeLifecycle } from "./node-lifecycle.mjs";

const STATES = ["unstarted", "in_progress", "blocked", "done", "cancelled"];
const EVENTS = ["START", "BLOCK", "UNBLOCK", "COMPLETE", "REOPEN", "CANCEL", "ADD_CHILD"];
const machine = createMachine(nodeLifecycle);
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log("FAIL:", name)); };

const run = (events) => {
  const actor = createActor(machine).start();
  for (const e of events) actor.send(typeof e === "string" ? { type: e } : e);
  const s = actor.getSnapshot().value;
  actor.stop();
  return s;
};

const pathTo = {
  unstarted: [],
  in_progress: ["START"],
  blocked: ["START", { type: "BLOCK", reason: "r" }],
  done: ["START", { type: "COMPLETE", evidenceRef: "e" }],
  cancelled: ["CANCEL"],
};

// 1. All 35 pairs enumerated
const table = {};
for (const st of STATES) {
  table[st] = {};
  for (const ev of EVENTS) {
    const before = run(pathTo[st]);
    if (before !== st) { table[st][ev] = "SETUP-FAIL"; continue; }
    const after = run([...pathTo[st], { type: ev, evidenceRef: "e", reason: "r" }]);
    table[st][ev] = after === st ? "no-op/invalid" : `-> ${after}`;
  }
}
console.log("=== 35-pair table ===");
for (const st of STATES) console.log(st, JSON.stringify(table[st]));

// 2. Expected matrix (the ruled contract)
const expected = {
  unstarted:   { START: "-> in_progress", BLOCK: "-> blocked", UNBLOCK: "no-op/invalid", COMPLETE: "no-op/invalid", REOPEN: "no-op/invalid", CANCEL: "-> cancelled", ADD_CHILD: "no-op/invalid" },
  in_progress: { START: "no-op/invalid", BLOCK: "-> blocked", UNBLOCK: "no-op/invalid", COMPLETE: "-> done", REOPEN: "no-op/invalid", CANCEL: "-> cancelled", ADD_CHILD: "no-op/invalid" },
  blocked:     { START: "no-op/invalid", BLOCK: "no-op/invalid", UNBLOCK: "-> in_progress", COMPLETE: "no-op/invalid", REOPEN: "no-op/invalid", CANCEL: "-> cancelled", ADD_CHILD: "no-op/invalid" },
  done:        { START: "no-op/invalid", BLOCK: "no-op/invalid", UNBLOCK: "no-op/invalid", COMPLETE: "no-op/invalid", REOPEN: "-> in_progress", CANCEL: "no-op/invalid", ADD_CHILD: "no-op/invalid" },
  cancelled:   { START: "no-op/invalid", BLOCK: "no-op/invalid", UNBLOCK: "no-op/invalid", COMPLETE: "no-op/invalid", REOPEN: "no-op/invalid", CANCEL: "no-op/invalid", ADD_CHILD: "no-op/invalid" },
};
for (const st of STATES) for (const ev of EVENTS)
  check(`${st} + ${ev}`, table[st][ev] === expected[st][ev]);

// 3. BFS reachability: all 5 states
const seen = new Set(["unstarted"]);
const q = ["unstarted"];
const paths = { unstarted: [] };
while (q.length) {
  const cur = q.shift();
  for (const ev of EVENTS) {
    const nxt = run([...paths[cur], { type: ev, evidenceRef: "e", reason: "r" }]);
    if (!seen.has(nxt)) { seen.add(nxt); paths[nxt] = [...paths[cur], { type: ev, evidenceRef: "e", reason: "r" }]; q.push(nxt); }
  }
}
check("all 5 states reachable", seen.size === 5);

// 4. No non-final dead ends
for (const st of ["unstarted", "in_progress", "blocked"]) {
  const outs = EVENTS.filter((ev) => table[st][ev].startsWith("->"));
  check(`${st} has an exit`, outs.length > 0);
}

// 5. No unstarted -> done path (s04): BFS, every arrival at done came via in_progress
let violated = false;
const bfs = [{ state: "unstarted", seq: [], viaInProgress: false }];
const visited = new Set();
while (bfs.length && !violated) {
  const { state, seq, viaInProgress } = bfs.shift();
  for (const ev of EVENTS) {
    const evObj = { type: ev, evidenceRef: "e", reason: "r" };
    const nxt = run([...seq, evObj]);
    const vip = viaInProgress || nxt === "in_progress";
    if (nxt === "done" && !viaInProgress && state !== "in_progress") violated = true;
    const key = nxt + "|" + seq.length + ev;
    if (seq.length < 8 && !visited.has(key)) { visited.add(key); bfs.push({ state: nxt, seq: [...seq, evObj], viaInProgress: vip }); }
  }
}
check("no path to done skips in_progress", !violated);

// 6. Guards: bare COMPLETE / bare REOPEN stay put
check("bare COMPLETE stays in_progress", run(["START", "COMPLETE"]) === "in_progress");
check("bare BLOCK stays in_progress", run(["START", "BLOCK"]) === "in_progress");
check("reasoned BLOCK -> blocked", run(["START", { type: "BLOCK", reason: "r" }]) === "blocked");
check("bare BLOCK stays unstarted", run(["BLOCK"]) === "unstarted");
check("evidenced COMPLETE -> done", run(["START", { type: "COMPLETE", evidenceRef: "e" }]) === "done");
check("bare REOPEN stays done", run(["START", { type: "COMPLETE", evidenceRef: "e" }, "REOPEN"]) === "done");
check("reasoned REOPEN -> in_progress",
  run(["START", { type: "COMPLETE", evidenceRef: "e" }, { type: "REOPEN", reason: "r" }]) === "in_progress");
// a reason of only spaces is no reason (rules era 2, ruling 2026-10-20)
check("blank-reason BLOCK stays in_progress", run(["START", { type: "BLOCK", reason: "  " }]) === "in_progress");
check("blank-reason BLOCK stays unstarted", run([{ type: "BLOCK", reason: "\t \n" }]) === "unstarted");
check("blank-reason REOPEN stays done",
  run(["START", { type: "COMPLETE", evidenceRef: "e" }, { type: "REOPEN", reason: " " }]) === "done");
check("padded reason still counts", run(["START", { type: "BLOCK", reason: "  r  " }]) === "blocked");

// 7. ADD_CHILD on done denied (stays done)
check("ADD_CHILD on done denied",
  run(["START", { type: "COMPLETE", evidenceRef: "e" }, "ADD_CHILD"]) === "done");

// 8. Idempotent no-ops
check("double START idempotent", run(["START", "START"]) === "in_progress");
check("double COMPLETE idempotent",
  run(["START", { type: "COMPLETE", evidenceRef: "e" }, { type: "COMPLETE", evidenceRef: "e" }]) === "done");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
