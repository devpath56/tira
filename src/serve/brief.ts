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

const openKids = (f: BriefFacts) => f.kids.filter((k) => !CLOSED.has(k.state)).map((k) => k.id);

// where it stands: its state and parent, then why and since when, or its proof
function standing(f: BriefFacts): string {
  const where = f.parent ? " under " + f.parent.id : "";
  const reason = f.since?.reason?.trim() ? f.since.reason : "no reason given";
  if (f.state === "blocked" && f.since) return `${f.id} is ${word(f.state)}${where} since seq ${f.since.seq}: "${reason}".`;
  if (f.state === "in_progress" && f.since) return `${f.id} is ${word(f.state)}${where} since seq ${f.since.seq}.`;
  if (f.state === "done" && f.proof !== undefined) return `${f.id} is ${word(f.state)}${where} (proof: ${f.proof}).`;
  return `${f.id} is ${word(f.state)}${where}.`;
}

function subtasksLine(f: BriefFacts): string {
  if (f.kids.length === 0) return "";
  const open = openKids(f);
  const which = open.length > 0 ? " (open: " + list(open) + ")" : "";
  return ` ${f.kids.length - open.length} of ${f.kids.length} subtasks closed${which}.`;
}

// what the move does, then what tira closes first
function moveLine(f: BriefFacts): string {
  const pv = f.preview;
  let s = "";
  if (f.event === "ADD_SUBTASK") s = " This adds a new task at the end of its subtasks" + (f.found ? ", marked as found while working on it." : ".");
  else if (pv.ok && pv.noop) s = " Nothing would change.";
  else if (pv.ok && pv.to !== undefined) s = ` ${DOING[f.event] ?? f.event} it moves it ${word(f.state)} → ${word(pv.to)}.`;
  if (pv.ok && pv.closes.length > 0) s += ` First, tira closes ${pv.closes.join(", then ")} (every child closed), citing this move.`;
  return s;
}

const decisionOf = (f: BriefFacts) => `${standing(f)}${subtasksLine(f)}${moveLine(f)} Recorded as ${f.actor}.`;

// when it is its parent's last open subtask: whether tira will close the parent
function lastOf(f: BriefFacts): string {
  const p = f.parent;
  if (!p || p.othersOpen > 0) return "";
  if (p.closable) return ` It's the last open subtask of ${p.id}, so tira closes ${p.id} when you move on.`;
  return ` It's the last open subtask of ${p.id}, which is ${word(p.state)}: tira won't close it until it's unblocked.`;
}

function startAdvice(f: BriefFacts): string {
  if (f.next === f.id) return "Start it: it's the next task in order." + (f.preview.closes.length > 0 ? " Moving on lets tira close the finished branch behind you." : "");
  return f.next === undefined ? "Start it." : `Start it only if the order should change: next in order is ${f.next}.`;
}

// is the wait over? the ticket it waits on, else the reason it gave; then what's still open under it
function unblockAdvice(f: BriefFacts): string {
  const w = f.waitingOn;
  const open = openKids(f);
  const need = open.length === 1 ? "needs" : "need";
  const then = open.length > 0 ? ` Then ${list(open)} still ${need} doing before it can be completed.` : "";
  if (w && CLOSED.has(w.state)) return `Unblock it: ${w.id} is ${word(w.state)} now, so the wait looks over.${then}`;
  if (w) return `Wait, unless you no longer need ${w.id}: it is still ${word(w.state)}.`;
  const why = f.since?.reason?.trim();
  return (why ? `Unblock it once "${why}" is resolved.` : "Unblock it once what it waited on is resolved.") + then;
}

const ADVICE: Record<string, (f: BriefFacts) => string> = {
  START: startAdvice,
  UNBLOCK: unblockAdvice,
  COMPLETE: (f) => "Complete it with proof anyone can re-check." + lastOf(f),
  BLOCK: (f) => `Block it on a ticket for what you're waiting on: a new one is created under ${f.id} and linked as blocking it, so the wait is tracked like any task (or name an open task).`
    + (f.active.length === 0 && f.state === "in_progress" ? " It frees the slot for one task in progress, so you can start another." : ""),
  CANCEL: (f) => "Cancel it only if it won't be done." + lastOf(f),
  REOPEN: (f) => "Re-open it only if something about the result is wrong, and say what." + (f.proof === undefined ? "" : ` Its proof now: ${f.proof}.`),
  ADD_SUBTASK: (f) => f.found
    ? `Add it if ${f.id} can't be finished without it. It's marked as found while working on ${f.id}; take kind=discovered out if it was planned.`
    : `Add it if ${f.id} can't be finished without it. If you found it while working on ${f.id}, add kind=discovered discovered_during=${f.id}.`,
};

function recommendationOf(f: BriefFacts): string {
  const pv = f.preview;
  if (!pv.ok) return `Don't run it: tira will refuse (${pv.code}: ${pv.detail}).`;
  if (pv.noop) return "Nothing to do: it's already so.";
  return ADVICE[f.event]?.(f) ?? "";
}

const TRADEOFFS: Record<string, (f: BriefFacts) => string> = {
  START: (f) => `One task is in progress at a time: you stay on ${f.id} until you complete or block it.` + (f.preview.closes.length > 0 ? " Undoing tira's closes takes a re-open, with a reason." : ""),
  UNBLOCK: () => "If the wait isn't over, it gets blocked again and the history shows the round trip; left blocked, it stays in Needs attention.",
  COMPLETE: () => "Done stays done until someone re-opens it with a reason; a vague proof can't be re-checked later.",
  BLOCK: (f) => `It stays in Needs attention until unblocked; a new blocker ticket sits under ${f.id}, so ${f.id} can't be completed until that ticket is closed.`,
  CANCEL: () => "It counts as finished, so its parent can close, but it can't be re-opened: if the work comes back, it's a new task.",
  REOPEN: (f) => "Its proof is cleared and the history keeps both completions;" + (f.parent ? ` ${f.parent.id} stays open until it's done again.` : " it's open work again."),
  ADD_SUBTASK: (f) => `More scope: ${f.id} can't close until the new subtask is closed or cancelled.`,
};
const tradeoffsOf = (f: BriefFacts) => TRADEOFFS[f.event]?.(f) ?? "";

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

// ---------- an idea's two approvals (D5, the vapor catch) ----------
// The same two views for an idea: what it says and where it stands, what tira proposes, and
// what each answer does. Every sentence comes from the idea's own events or tira's preview.

export interface IdeaFacts {
  id: string;
  event: string; // APPROVE_FILE, REJECT_FILE, APPROVE_NODE or REJECT_NODE
  stage: string; // the idea's lifecycle state
  summary?: string | undefined;
  why?: string | undefined;
  declaredBy?: string | undefined;
  declaredSeq: number;
  proposal?: { parent?: string | undefined; candidates: string[]; basis: string } | undefined;
  refusal?: { why: string; todo: string } | undefined; // tira would refuse it, in plain words
  noop: boolean; // allowed, but nothing changes
  rule?: string | undefined;
  actor: string;
}

const STAGE_LINE: Record<string, string> = {
  declared: "It's declared; its file isn't drafted yet.",
  file_pending: "Its file (the summary and why) waits for approval.",
  filed: "Its file is approved; tira proposes where it goes next.",
  materialized: "It's a task now.",
  dropped: "It was dropped.",
};

function placementLine(f: IdeaFacts): string {
  const p = f.proposal;
  if (f.stage !== "node_pending" || !p) return "";
  if (p.parent !== undefined) return ` tira proposes it under ${p.parent}: ${p.basis}.`;
  const choose = p.candidates.length > 0 ? ` Candidates: ${list(p.candidates)}.` : "";
  return ` tira couldn't settle where it goes (${p.basis.replace(/^needs you: /, "")}): you pick.${choose}`;
}

const IDEA_MOVE: Record<string, string> = {
  APPROVE_FILE: " Approving files it; tira then proposes where it goes, and asks you again.",
  REJECT_FILE: " Rejecting drops it, with your reason.",
  APPROVE_NODE: " Approving makes it a task under the parent you name, to do.",
  REJECT_NODE: " Rejecting drops it, with your reason.",
};

function ideaDecision(f: IdeaFacts): string {
  const said = f.summary === undefined ? `Idea ${f.id}.` : `Idea ${f.id}: "${f.summary}".`;
  const why = f.why === undefined ? "" : ` Why: "${f.why}".`;
  const by = ` Declared${f.declaredBy === undefined ? "" : " by " + f.declaredBy} at seq ${f.declaredSeq}.`;
  const stage = f.stage === "node_pending" ? placementLine(f) : ` ${STAGE_LINE[f.stage] ?? ""}`;
  const move = f.refusal || f.noop ? "" : IDEA_MOVE[f.event] ?? "";
  return `${said}${why}${by}${stage}${move} Recorded as ${f.actor}.`;
}

function ideaAdvice(f: IdeaFacts): string {
  if (f.refusal) return `Don't run it: ${f.refusal.why}.`;
  if (f.noop) return "Nothing to do: it's already so.";
  const p = f.proposal;
  if (f.event === "APPROVE_FILE") return "Approve it if it's worth doing and the summary says what to build; reject it, with a reason, if not.";
  if (f.event === "REJECT_FILE") return "Reject it only if it isn't worth doing; say why, so whoever pushed it knows.";
  if (f.event === "APPROVE_NODE") {
    if (p?.parent !== undefined) return `Approve it under ${p.parent} if that's where it fits; change parent_id to put it elsewhere.`;
    return `Pick where it goes${p && p.candidates.length > 0 ? ` (${list(p.candidates)})` : ""}, then approve it.`;
  }
  return "Reject it only if it shouldn't become a task at all; if it belongs elsewhere, approve it with another parent_id.";
}

const IDEA_TRADEOFFS: Record<string, (f: IdeaFacts) => string> = {
  APPROVE_FILE: () => "An approved file is fixed: the idea moves on to placement, where it can still be dropped.",
  REJECT_FILE: () => "Dropped is final: if it comes back, it's pushed again as a new idea. Your reason stays in its history.",
  APPROVE_NODE: (f) => `It becomes a task (${f.id}) under its parent, and its parent can't close until it's done or cancelled.`,
  REJECT_NODE: () => "Dropped is final: if it comes back, it's pushed again as a new idea. Your reason stays in its history.",
};

const IDEA_PRACTICE: Record<string, string> = {
  APPROVE_FILE: "Judge the file on what it says, and the placement on where it fits: two separate questions.",
  REJECT_FILE: "Say why in a sentence: the reason is the only trace a dropped idea leaves.",
  APPROVE_NODE: "Put it under the task it helps finish.",
  REJECT_NODE: "Say why in a sentence: the reason is the only trace a dropped idea leaves.",
};

const IDEA_KIND: Record<string, string> = {
  APPROVE_FILE: "an idea's first approval (its file)",
  REJECT_FILE: "final (a dropped idea can't come back)",
  APPROVE_NODE: "an idea's second approval (where it goes)",
  REJECT_NODE: "final (a dropped idea can't come back)",
};

export function ideaBriefFor(f: IdeaFacts): Brief {
  const kind = f.refusal ? "refused by the rules" : IDEA_KIND[f.event] ?? f.event;
  return {
    decision: ideaDecision(f),
    recommendation: ideaAdvice(f),
    tradeoffs: IDEA_TRADEOFFS[f.event]?.(f) ?? "",
    practice: IDEA_PRACTICE[f.event] ?? "",
    kind: f.rule !== undefined ? `${kind}. The rule: ${f.rule}.` : `${kind}.`,
  };
}

// Why tira refuses an idea's approval at this stage, and what to do instead, in plain words: a
// stage skip (approving the placement while the file is still pending), or a step already taken.
export function ideaRefusal(stage: string, event: string, id: string, hasText: boolean): { why: string; todo: string } {
  const placing = event === "APPROVE_NODE" || event === "REJECT_NODE";
  if (stage === "materialized") return { why: "the idea is a task already", todo: `Open the task ${id} on the board.` };
  if (stage === "dropped") return { why: "the idea was dropped", todo: "If it's back, push it again as a new idea." };
  if (stage === "declared" && !placing) return { why: "its file isn't drafted yet", todo: hasText ? "tira drafts it from what the idea says; approve it then." : `Draft it first: tira send idea ${id} DRAFT_FILE summary="…" why="…".` };
  if (stage === "declared" || stage === "file_pending") return { why: "the file isn't approved yet, and the placement comes after the file", todo: "Approve the file first (or reject it). tira then proposes where it goes, and you approve that." };
  if (stage === "filed" && placing) return { why: "tira hasn't proposed where it goes yet", todo: "Wait for tira's proposal: it comes right after the file is approved." };
  return { why: "the file is already approved; this step is the placement", todo: "Approve or reject where it goes instead." };
}
