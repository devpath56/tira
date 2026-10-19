// Factory vocabulary (Track B1, tables signed off 2026-10-17: A1–A15 with A8 and A13
// open, core changes C1–C6). Five tables in charts/: the brief's three regions (gate,
// claim, outcome), session, drop. Every guard reads only the payload, the actor, its
// own entity and its OWN region's captured data: 0 cross-region guards. Everything
// that couples regions or entities is a handoff the dispatcher writes (handoffs.ts).
import type { GuardFn } from "./table.ts";
import type { EntityTypeDef } from "./registry.ts";

// Role names are literal actor ids (A15). The dispatcher is the single append process
// for handoff receivers (N2, A9); the write path reserves its name like tira's.
export const ORCHESTRATOR = "orchestrator";
export const DISPATCHER = "dispatcher";
export const MAC = "mac";
export const USER = "user";
const ROLES = new Set([ORCHESTRATOR, DISPATCHER, MAC, USER, "tira"]);

// A5: only dependency blocks recover (H6); the others need a revise.
export const BLOCK_REASONS = ["dependency", "verdict", "retries-exhausted", "defective"] as const;

const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;

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
  // Incident 2: the filer never verifies its own drop, and nothing verifies without a PASS.
  orchestratorVerifiesPass: ({ actor, payload, entity }) =>
    actor === ORCHESTRATOR && actor !== entity.createdBy && payload.done_test_result === "PASS",

  // Births (core change C2).
  // A3/A4: the orchestrator creates a brief version; blocked_by is fixed per version.
  briefBirth: ({ actor, payload, entity }) => {
    if (actor !== ORCHESTRATOR) return false;
    if (payload.slice_ref !== undefined && !s(payload.slice_ref)) return false;
    const deps = payload.blocked_by;
    if (deps === undefined) return true;
    return Array.isArray(deps) && deps.every(s) && new Set(deps).size === deps.length && !deps.includes(entity.id);
  },
  // A11: a session's identity is its stable birth name, and it names itself.
  sessionNamesItself: ({ actor, entity }) => s(actor) && actor === entity.id,
  // A9: sessions file drops; a role can't (the filer is who the claim is checked against).
  dropFiledBySession: ({ actor }) => s(actor) && !ROLES.has(actor),
};

export function factoryTypes(chart: (name: string) => EntityTypeDef["regions"][string]): EntityTypeDef[] {
  return [
    {
      type: "brief",
      versioned: true, // brief_id@version
      revisedAs: "REVISED", // A3: v1 brief.created, v2+ brief.revised {supersedes}
      createGuard: "briefBirth",
      keepBirth: true, // blocked_by and slice_ref, fixed per version (A4)
      regions: { gate: chart("brief-gate.json"), claim: chart("brief-claim.json"), outcome: chart("brief-outcome.json") },
    },
    { type: "session", createdAs: "NAMED", createGuard: "sessionNamesItself", regions: { lifecycle: chart("session.json") } },
    // A12: one drop per brief version, enforced by identity (drop:<brief>@<version>).
    // A14: a drop for a superseded brief version is refused, so it can't satisfy dependents.
    { type: "drop", versioned: true, createdAs: "FILED", createGuard: "dropFiledBySession", followsVersionsOf: "brief", regions: { lifecycle: chart("drop.json") } },
  ];
}
