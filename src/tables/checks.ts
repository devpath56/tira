// Check events and the citation object (citation-construction packet, slice S1: substrate in
// shadow). Two new event types that later rules cite, and the shape a citation has. Nothing
// here refuses a claim: the write path still stamps era 2, and era 3 (the only tables whose
// guards read a citation) folds only rows a writer stamped era 3, which none does yet.
//
// Definitions of record (spec-evidence-citations-construction-20261021, H-032):
// - A citation is a typed object, never a string: { event_id } cites an event in the record;
//   { repo, commit, path, blob } cites file evidence. evidenceRef stays display prose and
//   carries no admissibility weight.
// - Checker identity is a (component, actor) pair: a check counts when the component that
//   emitted it is not the component that completes the claim. The write path's own machine
//   events (tira, dispatcher) are never checks.
// - The done-test event binds the test definition it ran by { path, blob }.
import type { GuardFn } from "./table.ts";
import type { EntityTypeDef } from "./registry.ts";
import { MACHINE_ACTOR } from "../fold/types.ts";
import { DISPATCHER } from "./factory.ts";

// The component that runs a brief's done test (the gate). Its done-test events speak to a drop.
export const GATE = "gate";
// done-test.ran: a done test was run for a brief version's drop (drop VERIFIED cites it).
export const DONE_TEST = "done-test";
// machine-check.reported: a named machine component checked a node's work (node COMPLETE cites it).
export const MACHINE_CHECK = "machine-check";
export const CHECK_RESULTS = ["PASS", "FAIL"] as const;

const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
// A git blob id: sha-1 (40 hex) or sha-256 (64 hex), lowercase.
export const BLOB = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The write path's own machine roles: what they write is never a check.
const isMachineRole = (actor: unknown) => actor === MACHINE_ACTOR || actor === DISPATCHER;

export type EventCitation = { event_id: string };
export type FileCitation = { repo: string; commit: string; path: string; blob: string };
export type Citation = EventCitation | FileCitation;

export const isEventCitation = (c: unknown): c is EventCitation =>
  isObj(c) && Object.keys(c).length === 1 && s(c.event_id);
export const isFileCitation = (c: unknown): c is FileCitation =>
  isObj(c) && Object.keys(c).length === 4 && s(c.repo) && s(c.commit) && s(c.path) && typeof c.blob === "string" && BLOB.test(c.blob);
export const isCitation = (c: unknown): c is Citation => isEventCitation(c) || isFileCitation(c);

// A claim's citations as written: `citation` is one citation object or a non-empty list of
// them. Absent means the claim cites nothing (legacy). Anything else is not a citation.
export function citationsOf(payload: Record<string, unknown>): { cited: false } | { cited: true; list: unknown[] } {
  if (!("citation" in payload)) return { cited: false };
  const c = payload.citation;
  return { cited: true, list: Array.isArray(c) ? c : [c] };
}
// Shape only (era 3): no citation, or every one is a typed citation object. Never resolution.
export const citationShapeOk = (payload: Record<string, unknown>): boolean => {
  const c = citationsOf(payload);
  return !c.cited || (c.list.length > 0 && c.list.every(isCitation));
};

export const CHECK_GUARDS: Record<string, GuardFn> = {
  // done-test.ran { brief, version, result, test: { path, blob }, component }
  doneTestWellFormed: ({ actor, payload }) => {
    const t = payload.test;
    return s(actor) && !isMachineRole(actor) && s(payload.component) && !isMachineRole(payload.component) &&
      s(payload.brief) && Number.isInteger(payload.version) && (payload.version as number) >= 1 &&
      (CHECK_RESULTS as readonly unknown[]).includes(payload.result) &&
      isObj(t) && s(t.path) && typeof t.blob === "string" && BLOB.test(t.blob);
  },
  // machine-check.reported { node, check, result, component }
  machineCheckWellFormed: ({ actor, payload }) =>
    s(actor) && !isMachineRole(actor) && s(payload.component) && !isMachineRole(payload.component) &&
    s(payload.node) && s(payload.check) && (CHECK_RESULTS as readonly unknown[]).includes(payload.result),
  // Era 3 (shadow): today's claim guards, and any citation the claim carries is a typed object.
  hasEvidenceRefCitationShape: ({ payload }) => s(payload.evidenceRef) && citationShapeOk(payload),
  orchestratorVerifiesPassCitationShape: (ctx) =>
    ctx.actor === "orchestrator" && ctx.actor !== ctx.entity.createdBy && ctx.payload.done_test_result === "PASS" && citationShapeOk(ctx.payload),
};

// Both are born recorded and never move: a check is a fact about a moment, not a lifecycle.
export function checkTypes(chart: (name: string) => EntityTypeDef["regions"][string]): EntityTypeDef[] {
  return [
    { type: DONE_TEST, createdAs: "RAN", createGuard: "doneTestWellFormed", keepBirth: true, regions: { lifecycle: chart("check-event.json") } },
    { type: MACHINE_CHECK, createdAs: "REPORTED", createGuard: "machineCheckWellFormed", keepBirth: true, regions: { lifecycle: chart("check-event.json") } },
  ];
}
