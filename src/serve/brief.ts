// The left half of every decision: the work in a nutshell, only what you need to know to
// decide. Every sentence comes from the log (the task, its subtasks, why and since when it is
// blocked, its proof, what is next) or from tira's own preview of the move (the rule, what
// tira will close, a refusal): nothing is guessed. Plain text; the page escapes it.

export interface Brief { decision: string; recommendation: string; tradeoffs: string; practice: string; kind: string }

export interface BriefFacts {
  id: string;
  event: string;
  state: string;
  // its parent: how many of its other subtasks are open, its state, and whether tira may close
  // it once finished (only from a workable state: to do or in progress, never blocked)
  parent?: { id: string; othersOpen: number; state: string; closable: boolean } | undefined;
  kids: { id: string; state: string }[];
  since?: { seq: number; reason?: string | undefined } | undefined; // the current blocked or in-progress stretch
  proof?: string | undefined; // the evidence on its latest completion
  next?: string | undefined; // the next task in order (the cursor)
  active: string[]; // the tasks in progress, other than this one
  waitingOn?: { id: string; state: string } | undefined; // a block "waiting on <task>", and that task's state now
  found?: boolean; // the command marks a new subtask as found while working
  preview: { ok: boolean; code?: string; detail?: string; noop?: boolean; to?: string | undefined; closes: string[]; rule?: string | undefined };
  actor: string;
}

const CLOSED = new Set(["done", "cancelled"]);
const WORD: Record<string, string> = { unstarted: "to do", in_progress: "in progress", blocked: "blocked", done: "done", cancelled: "cancelled" };
const word = (s: string) => WORD[s] ?? s.replace("_", " ");
const DOING: Record<string, string> = { START: "Starting", UNBLOCK: "Unblocking", COMPLETE: "Completing", BLOCK: "Blocking", CANCEL: "Cancelling", REOPEN: "Re-opening" };
const list = (xs: string[]) => xs.join(", ");

export const PRACTICE: Record<string, string> = {
  START: "Work depth-first: finish the branch you're in before starting another.",
  UNBLOCK: "Unblock when what you waited on is done, not just likely; the history shows every round trip.",
  COMPLETE: "Link proof anyone can re-check (a PR, a test report, a screenshot), not just \"done\".",
  BLOCK: "Make the wait a ticket: whoever picks it up sees what it blocks, and it's clear when to unblock.",
  CANCEL: "Cancel what won't be done rather than leaving it in To do.",
  REOPEN: "Say what was wrong, so the next completion's proof can answer it.",
  ADD_SUBTASK: "Mark work you found mid-task as found (kind=discovered): it shows where the scope grew.",
};

export const KIND: Record<string, string> = {
  START: "routine (one click)",
  UNBLOCK: "a real block (needs judgment: is the wait over?)",
  COMPLETE: "a finish (needs proof)",
  BLOCK: "a pause (needs a reason)",
  CANCEL: "final (a cancelled task can't be re-opened)",
  REOPEN: "an undo, on the record (needs a reason)",
  ADD_SUBTASK: "a change of scope",
};

function decisionOf(f: BriefFacts): string {
  let s = `${f.id} is ${word(f.state)}${f.parent ? ` under ${f.parent.id}` : ""}`;
  if (f.state === "blocked" && f.since) s += ` since seq ${f.since.seq}: "${f.since.reason?.trim() ? f.since.reason : "no reason given"}"`;
  else if (f.state === "in_progress" && f.since) s += ` since seq ${f.since.seq}`;
  else if (f.state === "done" && f.proof !== undefined) s += ` (proof: ${f.proof})`;
  s += ".";
  if (f.kids.length > 0) {
    const open = f.kids.filter((k) => !CLOSED.has(k.state)).map((k) => k.id);
    s += ` ${f.kids.length - open.length} of ${f.kids.length} subtasks closed${open.length > 0 ? ` (open: ${list(open)})` : ""}.`;
  }
  const pv = f.preview;
  if (f.event === "ADD_SUBTASK") s += ` This adds a new task at the end of its subtasks${f.found ? ", marked as found while working on it" : ""}.`;
  else if (pv.ok && pv.noop) s += " Nothing would change.";
  else if (pv.ok && pv.to !== undefined) s += ` ${DOING[f.event] ?? f.event} it moves it ${word(f.state)} → ${word(pv.to)}.`;
  if (pv.ok && pv.closes.length > 0) s += ` First, tira closes ${pv.closes.join(", then ")} (every child closed), citing this move.`;
  return `${s} Recorded as ${f.actor}.`;
}

function recommendationOf(f: BriefFacts): string {
  const pv = f.preview;
  if (!pv.ok) return `Don't run it: tira will refuse (${pv.code}: ${pv.detail}).`;
  if (pv.noop) return "Nothing to do: it's already so.";
  const p = f.parent;
  const lastOf = !p || p.othersOpen > 0 ? ""
    : p.closable ? ` It's the last open subtask of ${p.id}, so tira closes ${p.id} when you move on.`
    : ` It's the last open subtask of ${p.id}, which is ${word(p.state)}: tira won't close it until it's unblocked.`;
  switch (f.event) {
    case "START":
      if (f.next === f.id) return `Start it: it's the next task in order.${pv.closes.length > 0 ? " Moving on lets tira close the finished branch behind you." : ""}`;
      return f.next !== undefined ? `Start it only if the order should change: next in order is ${f.next}.` : "Start it.";
    case "UNBLOCK": {
      const w = f.waitingOn;
      const open = f.kids.filter((k) => !CLOSED.has(k.state)).map((k) => k.id);
      const then = open.length > 0 ? ` Then ${list(open)} still ${open.length === 1 ? "needs" : "need"} doing before it can be completed.` : "";
      if (w && CLOSED.has(w.state)) return `Unblock it: ${w.id} is ${word(w.state)} now, so the wait looks over.${then}`;
      if (w) return `Wait, unless you no longer need ${w.id}: it is still ${word(w.state)}.`;
      const why = f.since?.reason?.trim();
      return `${why ? `Unblock it once "${why}" is resolved.` : "Unblock it once what it waited on is resolved."}${then}`;
    }
    case "COMPLETE":
      return `Complete it with proof anyone can re-check.${lastOf}`;
    case "BLOCK":
      return `Block it on a ticket for what you're waiting on: a new one is created under ${f.id} and linked as blocking it, so the wait is tracked like any task (or name an open task).${f.active.length === 0 && f.state === "in_progress" ? " It frees the slot for one task in progress, so you can start another." : ""}`;
    case "CANCEL":
      return `Cancel it only if it won't be done.${lastOf}`;
    case "REOPEN":
      return `Re-open it only if something about the result is wrong, and say what.${f.proof !== undefined ? ` Its proof now: ${f.proof}.` : ""}`;
    case "ADD_SUBTASK":
      return f.found
        ? `Add it if ${f.id} can't be finished without it. It's marked as found while working on ${f.id}; take kind=discovered out if it was planned.`
        : `Add it if ${f.id} can't be finished without it. If you found it while working on ${f.id}, add kind=discovered discovered_during=${f.id}.`;
    default:
      return "";
  }
}

function tradeoffsOf(f: BriefFacts): string {
  switch (f.event) {
    case "START":
      return `One task is in progress at a time: you stay on ${f.id} until you complete or block it.${f.preview.closes.length > 0 ? " Undoing tira's closes takes a re-open, with a reason." : ""}`;
    case "UNBLOCK":
      return "If the wait isn't over, it gets blocked again and the history shows the round trip; left blocked, it stays in Needs attention.";
    case "COMPLETE":
      return "Done stays done until someone re-opens it with a reason; a vague proof can't be re-checked later.";
    case "BLOCK":
      return `It stays in Needs attention until unblocked; a new blocker ticket sits under ${f.id}, so ${f.id} can't be completed until that ticket is closed.`;
    case "CANCEL":
      return "It counts as finished, so its parent can close, but it can't be re-opened: if the work comes back, it's a new task.";
    case "REOPEN":
      return `Its proof is cleared and the history keeps both completions;${f.parent ? ` ${f.parent.id} stays open until it's done again.` : " it's open work again."}`;
    case "ADD_SUBTASK":
      return `More scope: ${f.id} can't close until the new subtask is closed or cancelled.`;
    default:
      return "";
  }
}

export function briefFor(f: BriefFacts): Brief {
  const kind = f.preview.ok ? KIND[f.event] ?? f.event : "refused by the rules";
  return {
    decision: decisionOf(f),
    recommendation: recommendationOf(f),
    tradeoffs: tradeoffsOf(f),
    practice: PRACTICE[f.event] ?? "",
    kind: f.preview.rule !== undefined ? `${kind}. The rule: ${f.preview.rule}.` : `${kind}.`,
  };
}
