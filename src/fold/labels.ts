// Outcome labels (KAN-8, build piece 0): an oracle's later judgment of an approval.
//
// Shape (decided in this slice): a dedicated `label` entity type in the brief's own stream,
// keyed to (brief, verifying event id) by its birth payload — not an annotation pair on the
// brief-outcome table. done-verified (brief-outcome) and verified (drop) are terminal and
// deny every outgoing event; a label is a new event of its own, so it adds no transition to
// either chart and edits nothing already in the log. One approval takes any number of labels.
//
// A label is born `label.recorded` with payload
//   { brief, verifying_event_id, verdict: found-bad | confirmed-good, evidence }
// written as `oracle:<who>`. The write path and the fold judge it against the log the same
// way (labelProblem): the verifying event must be an applied drop.verified for that brief,
// the evidence must be an event earlier in the same log, and the oracle must not be the
// approval's own approver. Rates are derived here at read time; nothing is stored.
import type { StoredEvent } from "../store/types.ts";
import { skeleton } from "../text.ts";
import type { EntityState } from "./types.ts";
import type { Intent } from "./evaluate.ts";

export const LABEL = "label";
export const APPROVAL = "drop.verified"; // the approval a label judges: the orchestrator's VERIFIED on a drop
export const VERDICTS = ["found-bad", "confirmed-good"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Oracles write under a reserved namespace: "oracle:<who>". Only labels may be written so,
// and labels may be written no other way.
export const ORACLE_PREFIX = "oracle:";
export const isOracle = (actor: string | undefined): actor is string =>
  actor !== undefined && skeleton(actor).startsWith(ORACLE_PREFIX) && skeleton(actor).length > ORACLE_PREFIX.length;
const oracleName = (actor: string) => skeleton(actor).slice(ORACLE_PREFIX.length);

export const isLabelBirth = (intent: Intent): boolean => intent.kind === "create" && intent.entity.type === LABEL;

// What the log holds as of the label: every event before it (evidence may cite any), and
// the ones the fold applied (only an applied approval can be judged).
export interface LogLookup {
  seen(eventId: string): StoredEvent | undefined;
  applied(eventId: string): StoredEvent | undefined;
}

export type LabelProblem = { self: boolean; detail: string };

// Why this label may not stand, judged on the log before it; undefined when it may.
// `self` marks the approver labelling its own approval: inadmissible by construction.
export function labelProblem(intent: Intent, log: LogLookup): LabelProblem | undefined {
  const p = intent.payload;
  const vid = p.verifying_event_id;
  const approval = typeof vid === "string" ? log.applied(vid) : undefined;
  if (!approval || approval.type !== APPROVAL) {
    return { self: false, detail: `verifying_event_id ${String(vid)} is not an applied ${APPROVAL} in this log` };
  }
  const judged = (approval.data as { entity?: { id?: unknown } }).entity?.id;
  if (judged !== p.brief) return { self: false, detail: `${String(vid)} approved the drop for ${String(judged)}, not brief ${String(p.brief)}` };
  const approver = approval.metadata.actor;
  if (isOracle(intent.actor) && approver !== undefined && oracleName(intent.actor) === skeleton(approver)) {
    return { self: true, detail: `${intent.actor} is ${approver}, who approved ${String(vid)}: an approver never labels its own approval` };
  }
  const ev = p.evidence;
  if (typeof ev !== "string" || !log.seen(ev)) return { self: false, detail: `evidence ${String(ev)} does not resolve to an event in this log` };
  return undefined;
}

export interface ApprovalLabels {
  brief: string;
  verdict: Verdict; // found-bad if any admissible label says so
  labels: { key: string; actor: string; verdict: Verdict }[]; // every oracle's word, kept apart
}

export interface LabelSummary {
  labels: number; // admissible label events
  labeled: number; // approvals with at least one admissible label
  foundBad: number; // labeled approvals marked bad
  disagreements: number; // labeled approvals whose oracles disagree
  anomalies: number; // label events the fold refused (excluded from every count above)
  approvals: Record<string, ApprovalLabels>; // verifying event id -> its labels
}

// The derived view of one stream's labels, from the label entities the fold applied and
// the label events it refused.
export function summarize(labels: readonly EntityState[], refused: number): LabelSummary {
  const approvals: Record<string, ApprovalLabels> = {};
  for (const l of labels) {
    const b = l.born ?? {};
    const vid = b.verifying_event_id as string;
    const verdict = b.verdict as Verdict;
    const a = (approvals[vid] ??= { brief: b.brief as string, verdict, labels: [] });
    a.labels.push({ key: l.key, actor: l.createdBy ?? "", verdict });
    if (verdict === "found-bad") a.verdict = "found-bad";
  }
  const all = Object.values(approvals);
  return {
    labels: labels.length,
    labeled: all.length,
    foundBad: all.filter((a) => a.verdict === "found-bad").length,
    disagreements: all.filter((a) => new Set(a.labels.map((x) => x.verdict)).size > 1).length,
    anomalies: refused,
    approvals,
  };
}
