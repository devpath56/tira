// Factory vocabulary (Track B1, tables signed off 2026-10-17: A1–A15 with A8 and A13
// open, core changes C1–C6). Five tables in charts/: the brief's three regions (gate,
// claim, outcome), session, drop. Every guard reads only the payload, the actor, its
// own entity and its OWN region's captured data: 0 cross-region guards. Everything
// that couples regions or entities is a handoff the dispatcher writes (handoffs.ts).
import type { GuardFn } from "./table.ts";
import type { EntityTypeDef } from "./registry.ts";
import type { EntityState, StateView } from "../fold/types.ts";
import { isIsoTime, isoMs } from "../time.ts";
import { isOracle, VERDICTS } from "../fold/labels.ts";
import { byBirth } from "../fold/view.ts";

// Role names are literal actor ids (A15). The dispatcher is the single append process
// for handoff receivers (N2, A9); the write path reserves its name like tira's.
export const ORCHESTRATOR = "orchestrator";
export const DISPATCHER = "dispatcher";
export const MAC = "mac";
export const USER = "user";
const ROLES = new Set([ORCHESTRATOR, DISPATCHER, MAC, USER, "tira"]);

// Event writing (B2, ruling 2026-10-19): factory transitions emit their tira event with a
// deterministic id, "fx:" + the sha256 of the transition (src/write/fxkey.ts), so a crash-retry
// is a duplicate, never a second row. The fx: prefix marks transition-embedded rows.
export const FX_KEY = /^fx:[0-9a-f]{64}$/;
// An override lasts at most this long (ruling: per-incident, operator-invoked, 4h auto-expiry).
export const OVERRIDE_MAX_MS = 4 * 60 * 60 * 1000;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// A5: only dependency blocks recover (H6); the others need a revise.
export const BLOCK_REASONS = ["dependency", "verdict", "retries-exhausted", "defective"] as const;

const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// The dependency graph (blocked_by, fixed per version: A4), read from the birth payload.
export const depsOf = (b: EntityState): string[] => (Array.isArray(b.born?.blocked_by) ? (b.born?.blocked_by as string[]).filter(s) : []);
export const isSuperseded = (view: StateView, e: EntityState) =>
  e.version !== undefined && view.get({ type: e.type, id: e.id, version: e.version + 1 }) !== undefined;
// A dependency is met once any version of it has a verified drop (drops only land on current versions).
export const verifiedDrop = (view: StateView, briefId: string) =>
  view.all("drop").filter((d) => d.id === briefId && d.regions.lifecycle === "verified").sort((a, b) => a.lastSeq - b.lastSeq)[0];
export const unverifiedDeps = (view: StateView, b: EntityState) => depsOf(b).filter((id) => !verifiedDrop(view, id));
// The claimable frontier (factory vocabulary: "sessions pick from the available frontier; the
// DAG orders, the session doesn't choose"): current briefs that are gated, unclaimed, open, and
// whose every blocked_by is verified, in birth order.
export const frontier = (view: StateView): EntityState[] =>
  view.all("brief")
    .filter((b) => !isSuperseded(view, b) && b.regions.gate === "gated" && b.regions.claim === "unclaimed" && b.regions.outcome === "open" && unverifiedDeps(view, b).length === 0)
    .sort(byBirth);

// The verify vocabulary is exactly {"PASS"} (incident 2; convention verify-vocabulary-pass):
// no other casing, no padding, no lookalike, no non-string. The one place a verdict is read.
export const PASS = "PASS";
export const verifies = (result: unknown): boolean => result === PASS;

export const FACTORY_GUARDS: Record<string, GuardFn> = {
  isOrchestrator: ({ actor }) => actor === ORCHESTRATOR,
  orchestratorWithReason: ({ actor, payload }) => actor === ORCHESTRATOR && s(payload.reason),
  fromDispatcher: ({ actor }) => actor === DISPATCHER,
  dispatcherWithReason: ({ actor, payload }) => actor === DISPATCHER && s(payload.reason),
  sessionClaimsForItself: ({ actor, payload }) => s(payload.session) && actor === payload.session,
  fromClaimantOrDispatcher: ({ actor, own }) => actor === DISPATCHER || (s(actor) && actor === own?.claimant),
  blockReasonValid: ({ actor, payload }) => actor === DISPATCHER && (BLOCK_REASONS as readonly unknown[]).includes(payload.block_reason),
  wasDependencyBlock: ({ actor, own }) => actor === DISPATCHER && own?.block_reason === "dependency",
  // Incident 1: a session ends only by its own word, Mac process evidence, or the user.
  // Never a timeout, never a VM's inference.
  declaredByAllowed: ({ actor, payload, entity }) =>
    (payload.declared_by === "self" && actor === entity.id) ||
    (payload.declared_by === "mac-evidence" && actor === MAC) ||
    (payload.declared_by === "user" && actor === USER),
  // Ruling 2026-10-18: a session is renamed only by itself, the orchestrator, or Mac evidence.
  renamedByAllowed: ({ actor, entity }) => s(actor) && (actor === entity.id || actor === ORCHESTRATOR || actor === MAC),
  // Incident 2: the filer never verifies its own drop, and nothing verifies without a PASS.
  orchestratorVerifiesPass: ({ actor, payload, entity }) =>
    actor === ORCHESTRATOR && actor !== entity.createdBy && verifies(payload.done_test_result),

  // Births (core change C2).
  // A3/A4: the orchestrator creates a brief version; blocked_by is fixed per version.
  briefBirth: ({ actor, payload, entity }) => {
    if (actor !== ORCHESTRATOR) return false;
    if (payload.slice_ref !== undefined && !s(payload.slice_ref)) return false;
    const deps = payload.blocked_by;
    if (deps === undefined) return true;
    return Array.isArray(deps) && deps.every(s) && new Set(deps).size === deps.length && !deps.includes(entity.id);
  },
  // B2: a transition refused while tira was down, recorded on recovery from the factory's
  // journal. Its id is the refused transition's fx: key, so reconciling twice records it once.
  // Recorded under the refused transition's own actor (its trigger): every factory guard
  // checks the actor, so a transition with none could never have been legal.
  refusalWellFormed: ({ actor, payload, entity }) => {
    const t = payload.transition;
    return s(actor) && FX_KEY.test(entity.id) && isObj(t) && s(t.type) && s(t.id) && s(t.event) && s(payload.reason) && isIsoTime(payload.journaled_at);
  },
  // B2: an override is per-incident, invoked by an operator, and lasts at most 4 hours.
  overrideInvokedByOperator: ({ actor, payload }) => {
    if (actor !== USER && actor !== ORCHESTRATOR) return false;
    const invoked = isoMs(payload.invoked_at);
    const expires = isoMs(payload.expires_at);
    if (!s(payload.incident) || !s(payload.reason) || invoked === undefined || expires === undefined) return false;
    return expires > invoked && expires - invoked <= OVERRIDE_MAX_MS;
  },
  // ... and expires no earlier than it was invoked (the expiry time is the factory's word).
  expiryRecorded: ({ actor, payload, entity }) => {
    const at = isoMs(payload.expired_at);
    const invoked = isoMs(entity.born?.invoked_at);
    return (actor === USER || actor === ORCHESTRATOR || actor === MAC) && at !== undefined && invoked !== undefined && at >= invoked;
  },

  // A11: a session's identity is its stable birth name, and it names itself.
  sessionNamesItself: ({ actor, entity }) => s(actor) && actor === entity.id,
  // A9: sessions file drops; a role can't (the filer is who the claim is checked against).
  dropFiledBySession: ({ actor }) => s(actor) && !ROLES.has(actor),
  // KAN-8: an oracle labels an approval (fold/labels.ts). What it cites is checked against
  // the log by the write path and the fold; the guard checks only the label's own shape.
  labelWellFormed: ({ actor, payload }) =>
    isOracle(actor) && s(payload.brief) && s(payload.verifying_event_id) && s(payload.evidence) && (VERDICTS as readonly unknown[]).includes(payload.verdict),
};

export function factoryTypes(chart: (name: string) => EntityTypeDef["regions"][string]): EntityTypeDef[] {
  return [
    {
      type: "brief",
      versioned: true, // brief_id@version
      revisedAs: "REVISED", // A3: v1 brief.created, v2+ brief.revised {supersedes}
      createGuard: "briefBirth",
      keepBirth: true, // blocked_by and slice_ref, fixed per version (A4)
      dependsOn: "blocked_by", // G7: a second graph, checked for cycles at every birth and revision
      mustExist: [{ on: "CLAIMED", type: "session", from: "payload.session" }], // ruling 2026-10-18: a named session claims
      derived: {
        // what this brief still waits for (empty once every blocked_by is verified)
        waitingOn: (b, { view }) => unverifiedDeps(view, b),
      },
      regions: { gate: chart("brief-gate.json"), claim: chart("brief-claim.json"), outcome: chart("brief-outcome.json") },
    },
    { type: "session", createdAs: "NAMED", createGuard: "sessionNamesItself", regions: { lifecycle: chart("session.json") } },
    // A12: one drop per brief version, enforced by identity (drop:<brief>@<version>).
    // A14: a drop for a superseded brief version is refused, so it can't satisfy dependents.
    // B2: refusals and overrides, so the log holds what happened while tira was unreachable.
    { type: "refusal", createdAs: "RECORDED", createGuard: "refusalWellFormed", keepBirth: true, regions: { lifecycle: chart("refusal.json") } },
    {
      type: "override", createdAs: "INVOKED", createGuard: "overrideInvokedByOperator", keepBirth: true, regions: { lifecycle: chart("override.json") },
      derived: {
        // still active past its expiry: the log records its own violation (needs `now`)
        overdue: (o, { now }) => o.regions.lifecycle === "active" && (isoMs(now) ?? -Infinity) > (isoMs(o.born?.expires_at) ?? Infinity),
        // expired later than it should have, by the expiry time the factory reported
        late: (o) => o.regions.lifecycle === "expired" && (isoMs(o.context?.lifecycle?.expired_at) ?? -Infinity) > (isoMs(o.born?.expires_at) ?? Infinity),
      },
    },
    {
      type: "drop", versioned: true, createdAs: "FILED", createGuard: "dropFiledBySession", followsVersionsOf: "brief",
      mustExist: [{ on: "birth", type: "session", from: "actor" }], // ruling 2026-10-18: a named session files
      regions: { lifecycle: chart("drop.json") },
    },
    // KAN-8: an oracle's judgment of an approval, keyed to (brief, verifying event id) by its
    // birth payload; 1:N per approval. Born recorded and never moves (fold/labels.ts).
    { type: "label", createdAs: "RECORDED", createGuard: "labelWellFormed", keepBirth: true, regions: { lifecycle: chart("label.json") } },
  ];
}
