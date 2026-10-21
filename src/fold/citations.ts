// Citation resolution (citation-construction packet, slice S1): a pure function over the log
// that says what a done claim's citation points at. SHADOW: the fold reports it, nothing
// refuses on it. S3 makes F1 (proof points at nothing) and F2 (worker grades own homework)
// refusals out of these states; S4 makes F3 (file changed after approval) one out of `blob`.
//
// States (spec state space, in the order they are decided):
//   legacy        the claim carries no citation (written before citations existed)
//   wrong-type    not a citation object, or it cites an event that is not the check its
//                 claim class needs (the write path's own machine events are never checks)
//   dangling      it cites an event the log does not hold applied, or a file not at that commit
//   wrong-entity  the check speaks to another node / brief version than the claim
//   post-dated    the check is recorded at or after the claim
//   self-issued   the check's (component, actor) is the claim's: the worker graded itself
//   stale-blob    the bound file's blob at that commit is not the blob cited
//   resolving     every leg that can be checked holds
// Each resolution also carries its legs, so a leg that cannot be checked yet says so instead
// of passing silently: `blob` is "unverifiable" when no blob resolver is supplied (until S4).
import type { StoredEvent } from "../store/types.ts";
import { REJECTED } from "./events.ts";
import { DONE_TEST, MACHINE_CHECK, citationsOf, isEventCitation, isFileCitation } from "../tables/checks.ts";

export const CITATION_STATES = ["resolving", "dangling", "wrong-type", "wrong-entity", "post-dated", "self-issued", "stale-blob", "legacy"] as const;
export type CitationState = (typeof CITATION_STATES)[number];
export type Leg = "ok" | "fail" | "n/a" | "unverifiable";

export interface Resolution {
  state: CitationState;
  detail: string;
  legs: { exists: Leg; type: Leg; entity: Leg; order: Leg; issuer: Leg; blob: Leg };
  result?: string; // the cited check's own result (PASS / FAIL): S3 reads it, S1 only reports it
}

// The blob at a path, at a commit of a repo; undefined when the path is not there. Supplied by
// the caller (git, in S4), so resolution itself stays pure.
export type BlobAt = (ref: { repo?: string | undefined; commit?: string | undefined; path: string }) => string | undefined;

// Done-claim classes and the check event each cites (inventory: docs/citation-claim-inventory.md).
export const CLAIM_CLASSES: Record<string, { cites: string; speaksTo: (check: Record<string, unknown>, claim: { id: string; version?: number }) => boolean }> = {
  "node.complete": { cites: `${MACHINE_CHECK}.reported`, speaksTo: (p, c) => p.node === c.id },
  "drop.verified": { cites: `${DONE_TEST}.ran`, speaksTo: (p, c) => p.brief === c.id && p.version === c.version },
};

export interface ResolveOptions {
  blobAt?: BlobAt;
  // Who did the work being claimed, when it is not the claim's own actor (a drop's filer).
  worker?: string;
}

const NONE: Resolution["legs"] = { exists: "n/a", type: "n/a", entity: "n/a", order: "n/a", issuer: "n/a", blob: "n/a" };
const payloadOf = (e: StoredEvent): Record<string, unknown> => ((e.data as { payload?: Record<string, unknown> }).payload ?? {});
const entityOf = (e: StoredEvent): { id: string; version?: number } => (e.data as { entity: { id: string; version?: number } }).entity;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

// One citation of one claim. `applied(id)`: the event with that id, if the fold applied it in
// the claim's stream (a rejected command or an anomaly is not in the record).
export function resolveCitation(
  claim: StoredEvent,
  citation: unknown,
  applied: (eventId: string) => StoredEvent | undefined,
  opts: ResolveOptions = {},
): Resolution {
  const legs = { ...NONE };
  const out = (state: CitationState, detail: string, extra: Partial<Resolution> = {}): Resolution => ({ state, detail, legs, ...extra });
  const blobLeg = (ref: Parameters<BlobAt>[0], want: string): { leg: Leg; got?: string | undefined } => {
    if (!opts.blobAt) return { leg: "unverifiable" };
    const got = opts.blobAt(ref);
    return { leg: got === want ? "ok" : "fail", got };
  };

  if (isFileCitation(citation)) {
    const { leg, got } = blobLeg(citation, citation.blob);
    legs.blob = leg;
    if (leg === "fail" && got === undefined) {
      legs.exists = "fail";
      return out("dangling", `${citation.path} is not in ${citation.repo} at ${citation.commit}`);
    }
    legs.exists = leg === "unverifiable" ? "unverifiable" : "ok";
    if (leg === "fail") return out("stale-blob", `${citation.path} at ${citation.commit} is blob ${got}, not ${citation.blob}`);
    return out("resolving", leg === "ok" ? `${citation.path} at ${citation.commit} is blob ${citation.blob}` : `file citation well-formed; blob unverifiable until S4`);
  }
  if (!isEventCitation(citation)) {
    legs.type = "fail";
    return out("wrong-type", `not a citation object: ${JSON.stringify(citation) ?? String(citation)}`);
  }

  const cls = CLAIM_CLASSES[claim.type];
  const check = applied(citation.event_id);
  if (!check) {
    legs.exists = "fail";
    return out("dangling", `${citation.event_id} is not an applied event in ${claim.stream}`);
  }
  legs.exists = "ok";
  if (!cls || check.type !== cls.cites) {
    legs.type = "fail";
    return out("wrong-type", cls ? `${claim.type} cites a ${cls.cites}; ${citation.event_id} is a ${check.type}` : `${claim.type} is not a done-claim class`);
  }
  legs.type = "ok";
  const p = payloadOf(check);
  const subject = entityOf(claim);
  const result = str(p.result);
  if (!cls.speaksTo(p, subject)) {
    legs.entity = "fail";
    return out("wrong-entity", `${citation.event_id} speaks to ${JSON.stringify(p.node ?? { brief: p.brief, version: p.version })}, not ${claim.type.split(".")[0]}:${subject.id}${subject.version === undefined ? "" : `@${subject.version}`}`, result ? { result } : {});
  }
  legs.entity = "ok";
  if (check.seq >= claim.seq) {
    legs.order = "fail";
    return out("post-dated", `${citation.event_id} is seq ${check.seq}, at or after the claim (seq ${claim.seq})`, result ? { result } : {});
  }
  legs.order = "ok";
  // Checker identity is the (component, actor) pair: a check counts when the component that
  // emitted it is not the one completing the claim (a claim's component is its own
  // `component` if it names one, else its actor), and was not emitted by the worker.
  const checkComponent = str(p.component) ?? check.metadata.actor;
  const claimComponent = str(payloadOf(claim).component) ?? claim.metadata.actor;
  const sameComponent = checkComponent !== undefined && checkComponent === claimComponent;
  const byWorker = opts.worker !== undefined && (checkComponent === opts.worker || check.metadata.actor === opts.worker);
  if (sameComponent || byWorker) {
    legs.issuer = "fail";
    const who = `(${checkComponent}, ${check.metadata.actor})`;
    return out("self-issued", sameComponent ? `${citation.event_id} was emitted by ${who}, the component completing the claim` : `${citation.event_id} was emitted by ${who}, the worker ${opts.worker}`, result ? { result } : {});
  }
  legs.issuer = "ok";
  // A done test binds the test definition it ran by { path, blob }.
  const t = p.test as { path?: unknown; blob?: unknown } | undefined;
  if (check.type === `${DONE_TEST}.ran` && t && typeof t.path === "string" && typeof t.blob === "string") {
    const { leg, got } = blobLeg({ repo: str(p.repo), commit: str(p.commit), path: t.path }, t.blob);
    legs.blob = leg;
    if (leg === "fail") return out("stale-blob", `the done test's definition ${t.path} is blob ${got ?? "(absent)"}, not ${t.blob}`, result ? { result } : {});
  }
  return out("resolving", legs.blob === "unverifiable" ? `${citation.event_id} resolves; test blob unverifiable until S4` : `${citation.event_id} resolves`, result ? { result } : {});
}

// Every citation of one claim; a claim with none is one `legacy` resolution.
export function resolveClaim(
  claim: StoredEvent,
  applied: (eventId: string) => StoredEvent | undefined,
  opts: ResolveOptions = {},
): Resolution[] {
  const c = citationsOf(payloadOf(claim));
  if (!c.cited) return [{ state: "legacy", detail: `${claim.type} carries no citation`, legs: { ...NONE } }];
  if (c.list.length === 0) return [{ state: "wrong-type", detail: "an empty citation list", legs: { ...NONE, type: "fail" } }];
  return c.list.map((x) => resolveCitation(claim, x, applied, opts));
}

// The same over a plain log: every non-rejection in the claim's stream counts as applied.
// For tests and readers without a fold; the fold passes what it really applied.
export function resolveOverLog(log: readonly StoredEvent[], claim: StoredEvent, opts: ResolveOptions = {}): Resolution[] {
  const byId = new Map(log.filter((e) => e.stream === claim.stream && e.type !== REJECTED).map((e) => [e.eventId, e]));
  return resolveClaim(claim, (id) => byId.get(id), opts);
}
