// Every human input has two views: the work in a nutshell with tira's recommendation
// (src/serve/brief.ts), and the action as a tira command, filled in and editable before it
// runs (src/serve/command.ts). The command is read back strictly; the brief says only what the
// log and the rules say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFor, missing, parseCommand, quote, withDefaults, words } from "../src/serve/command.ts";
import { briefFor, type BriefFacts } from "../src/serve/brief.ts";

const tree = (t: string) => t === "node";
const read = (text: string) => parseCommand(text, tree);

test("the command a decision opens with: complete when nothing is needed, empty quotes where a value is yours", () => {
  assert.equal(commandFor("node", "colors", "UNBLOCK"), "tira send node colors UNBLOCK");
  assert.equal(commandFor("node", "loading_state", "COMPLETE"), 'tira send node loading_state COMPLETE evidenceRef=""');
  // a block opens on a new ticket for what it waits on, created under the blocked task
  assert.equal(commandFor("node", "table", "BLOCK"), 'tira create node "" --parent table kind=discovered discovered_during=table\ntira send node table BLOCK blocker="" reason=""');
  assert.equal(commandFor("node", "x", "REOPEN"), 'tira send node x REOPEN reason=""');
  assert.equal(commandFor("node", "board view", "CANCEL"), 'tira send node "board view" CANCEL'); // a space: quoted
  assert.equal(commandFor("node", "colors", "ADD_SUBTASK"), 'tira create node "" --parent colors');
  assert.equal(commandFor("node", "colors", "ADD_SUBTASK", true), 'tira create node "" --parent colors kind=discovered discovered_during=colors');
  assert.equal(quote('say "hi"'), '"say \\"hi\\""');
});

test("words split like a shell: quotes keep spaces, \\\" and \\\\ inside double quotes, single quotes literal", () => {
  assert.deepEqual(words('tira send node x BLOCK reason="waiting on \\"the\\" API"'), ["tira", "send", "node", "x", "BLOCK", 'reason=waiting on "the" API']);
  assert.deepEqual(words("a 'b c' \"\" d"), ["a", "b c", "", "d"]);
  assert.deepEqual(words("  spaced\n\tout  "), ["spaced", "out"]);
  assert.deepEqual(words('reason="open'), { why: "a quote is never closed" });
});

test("a command is read back into the page's action, with a note kept for the history", () => {
  assert.deepEqual(read("tira send node colors UNBLOCK"), { ok: true, action: { type: "node", id: "colors", event: "UNBLOCK", payload: {} } });
  assert.deepEqual(read('tira send node x COMPLETE evidenceRef="a b.md" note="checked twice"'), { ok: true, action: { type: "node", id: "x", event: "COMPLETE", payload: { evidenceRef: "a b.md", note: "checked twice" } } });
  assert.deepEqual(read('tira send node x START note=""'), { ok: true, action: { type: "node", id: "x", event: "START", payload: {} } }); // an empty note is no note
  assert.deepEqual(read('tira create node "charts v2" --parent dash kind=discovered discovered_during=dash'), { ok: true, action: { type: "node", id: "dash", event: "ADD_SUBTASK", child: "charts v2", payload: { parent_id: "dash", kind: "discovered", discovered_during: "dash" } } });
  assert.deepEqual(read("tira create node legend --parent dash"), { ok: true, action: { type: "node", id: "dash", event: "ADD_SUBTASK", child: "legend", payload: { parent_id: "dash" } } });
  // what the page offers round-trips once the values are filled in
  for (const event of ["START", "UNBLOCK", "CANCEL"]) assert.equal(read(commandFor("node", "a task", event)).ok, true, event);
});

test("a command the page won't run is explained, never guessed at", () => {
  const why = (text: string) => { const p = read(text); return p.ok ? "ran" : p.why; };
  assert.match(why("rm -rf /"), /start with "tira"/);
  assert.match(why("tira send node x DELETE"), /the page sends START, UNBLOCK, COMPLETE, BLOCK, CANCEL, REOPEN, APPROVE_FILE, REJECT_FILE, APPROVE_NODE, REJECT_NODE, not DELETE/);
  assert.match(why("tira send node x ADD_SUBTASK"), /not ADD_SUBTASK/);
  assert.match(why("tira send brief b START"), /acts on tasks \(node\), not brief/);
  assert.match(why('tira send node x COMPLETE evidenceRef="e" actor="tira"'), /COMPLETE takes evidenceRef="…" and note="…", not actor/);
  assert.match(why('tira send node x START reason="r"'), /START takes note="…", not reason/);
  assert.match(why("tira send node x START --actor tira"), /doesn't take --actor/);
  assert.match(why('tira send node x COMPLETE evidenceRef="a" evidenceRef="b"'), /evidenceRef is given twice/);
  assert.match(why("tira send node x COMPLETE proof"), /expected key="value", got proof/);
  assert.match(why("tira send node"), /write it as: tira send node <task> <EVENT>/);
  assert.match(why('tira create node "" --parent dash'), /give the new subtask a name/);
  assert.match(why("tira create node x"), /say where it goes: --parent <task>/);
  assert.match(why("tira create node x --parent dash kind=discovered discovered_during=other"), /kind=discovered discovered_during=dash/);
  assert.match(why("tira create node x --parent dash kind=planned"), /kind=discovered discovered_during=dash/);
  assert.match(why("tira stop"), /tira send … or tira create …/);
});

test("a value the verb needs, left empty or only spaces, is caught before anything is written", () => {
  const act = (event: string, payload: Record<string, unknown>) => ({ type: "node", id: "x", event, payload });
  assert.equal(missing(act("COMPLETE", { evidenceRef: "" })), "Pick the proof of work: one of the task's commits.");
  assert.equal(missing(act("COMPLETE", {})), "Pick the proof of work: one of the task's commits.");
  assert.match(missing(act("BLOCK", { reason: "   " })) ?? "", /Add the reason: reason="…" \(words, not only spaces\)/);
  assert.match(missing(act("REOPEN", {})) ?? "", /Add the reason/);
  assert.equal(missing(act("BLOCK", { reason: "waiting on x" })), undefined);
  assert.equal(missing(act("START", {})), undefined);
  assert.equal(missing({ ...act("ADD_SUBTASK", { parent_id: "x" }), child: "y" }), undefined);
});

test("a block names its ticket: a new one created on the line above, under the blocked task, or an open task by name", () => {
  const pair = 'tira create node design_tokens --parent colors kind=discovered discovered_during=colors\ntira send node colors BLOCK blocker="design_tokens" reason="waiting on design_tokens"';
  assert.deepEqual(read(pair), {
    ok: true,
    action: { type: "node", id: "colors", event: "BLOCK", payload: { blocker: "design_tokens", reason: "waiting on design_tokens" } },
    ticket: { type: "node", id: "colors", event: "ADD_SUBTASK", child: "design_tokens", payload: { parent_id: "colors", kind: "discovered", discovered_during: "colors" } },
  });
  assert.deepEqual(read("tira send node table BLOCK blocker=filters"), { ok: true, action: { type: "node", id: "table", event: "BLOCK", payload: { blocker: "filters" } } });
  assert.deepEqual(read('tira send node table BLOCK blocker="" reason="r"'), { ok: true, action: { type: "node", id: "table", event: "BLOCK", payload: { reason: "r" } } }); // an empty blocker is none
  const why = (text: string) => { const p = read(text); return p.ok ? "ran" : p.why; };
  const together = /two commands only go together to block a task on a new ticket/;
  assert.match(why("tira create node t --parent colors\ntira send node colors BLOCK blocker=other"), together); // the block must name the ticket
  assert.match(why("tira create node t --parent table\ntira send node colors BLOCK blocker=t"), together); // under the task it blocks
  assert.match(why("tira create node t --parent colors\ntira send node colors START"), together);
  assert.match(why("tira send node a START\ntira send node b START"), together);
  assert.match(why("tira create node t --parent c\ntira send node c BLOCK blocker=t\ntira send node c START"), together);
  assert.match(why('tira create node "" --parent c\ntira send node c BLOCK blocker=""'), /^line 1: give the new subtask a name/);
  assert.match(why("tira create node t --parent c\ntira send node c BLOK blocker=t"), /^line 2: the page sends/);
  assert.match(why("tira send node c BLOCK blocker=c"), /c can't be blocked by itself/);
  assert.match(why("tira send node c START blocker=x"), /START takes note="…", not blocker/); // only a block names a blocker
  assert.match(why("   \n  "), /write a command/);
  // a block on a ticket needs no reason written: it waits on the ticket
  const onTicket = { type: "node", id: "c", event: "BLOCK", payload: { blocker: "t" } };
  assert.equal(missing(onTicket), undefined);
  assert.deepEqual(withDefaults(onTicket).payload, { blocker: "t", reason: "waiting on t" });
  assert.deepEqual(withDefaults({ ...onTicket, payload: { blocker: "t", reason: "QA hasn't signed off" } }).payload, { blocker: "t", reason: "QA hasn't signed off" });
  assert.deepEqual(withDefaults({ ...onTicket, event: "REOPEN", payload: { blocker: "t" } }).payload, { blocker: "t" });
});

const base = (over: Partial<BriefFacts>): BriefFacts => ({
  id: "colors", event: "UNBLOCK", state: "blocked", kids: [], active: [], actor: "isha",
  preview: { ok: true, to: "in_progress", closes: [] }, ...over,
});

test("the brief says what the log says: the task, why and since when, its subtasks, the move, and tira's closes", () => {
  const b = briefFor(base({
    parent: { id: "improve_visual", othersOpen: 2, state: "unstarted", closable: true },
    since: { seq: 13, reason: "waiting on the design-token decision" },
    kids: [{ id: "design_tokens", state: "unstarted" }, { id: "old", state: "done" }],
    preview: { ok: true, to: "in_progress", closes: ["improve_visual", "metrics_card"], rule: "event.reason has text" },
  }));
  assert.equal(b.decision, 'colors is blocked under improve_visual since seq 13: "waiting on the design-token decision". 1 of 2 subtasks closed (open: design_tokens). Unblocking it moves it blocked → in progress. First, tira closes improve_visual, then metrics_card (every child closed), citing this move. Recorded as isha.');
  assert.equal(b.recommendation, 'Unblock it once "waiting on the design-token decision" is resolved. Then design_tokens still needs doing before it can be completed.');
  assert.equal(b.kind, "a real block (needs judgment: is the wait over?). The rule: event.reason has text.");
  assert.ok(b.tradeoffs.length > 0 && b.practice.length > 0);
});

test("the recommendation follows the facts: the wait over or not, the order, the last open subtask, a refusal", () => {
  const rec = (over: Partial<BriefFacts>) => briefFor(base(over)).recommendation;
  assert.equal(rec({ waitingOn: { id: "api", state: "done" } }), "Unblock it: api is done now, so the wait looks over.");
  assert.equal(rec({ waitingOn: { id: "api", state: "in_progress" } }), "Wait, unless you no longer need api: it is still in progress.");
  assert.equal(rec({ event: "START", state: "unstarted", next: "colors" }), "Start it: it's the next task in order.");
  assert.equal(rec({ event: "START", state: "unstarted", next: "font" }), "Start it only if the order should change: next in order is font.");
  const last = { event: "COMPLETE", state: "in_progress" };
  assert.match(rec({ ...last, parent: { id: "p", othersOpen: 0, state: "in_progress", closable: true } }), /last open subtask of p, so tira closes p when you move on/);
  assert.match(rec({ ...last, parent: { id: "p", othersOpen: 0, state: "blocked", closable: false } }), /last open subtask of p, which is blocked: tira won't close it until it's unblocked/);
  assert.doesNotMatch(rec({ ...last, parent: { id: "p", othersOpen: 1, state: "in_progress", closable: true } }), /last open/);
  const refused = briefFor(base({ preview: { ok: false, code: "gate", detail: "one active task: node:x is already active", closes: [] } }));
  assert.equal(refused.recommendation, "Don't run it: tira will refuse (gate: one active task: node:x is already active).");
  assert.equal(refused.kind, "refused by the rules.");
  assert.match(rec({ event: "ADD_SUBTASK", state: "in_progress", found: true }), /marked as found while working on colors; take kind=discovered out/);
  assert.match(rec({ event: "ADD_SUBTASK", state: "unstarted", found: false }), /add kind=discovered discovered_during=colors/);
});
