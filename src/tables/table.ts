// Transition tables — the canonical JSON form in charts/*.json (packing.md D3).
// This runner extends charts/transition-runner.mjs in one essential way: step()
// returns the OUTCOME, not just the next state. The write path needs it — a valid
// no-op is appended, a denied event is rejected — and the two look identical if
// you only compare states (the gap measured in the acceptance review).
import { readFileSync } from "node:fs";
import type { EntityState, StateView } from "../fold/types.ts";

export type PairOutcome = "transition" | "noop" | "denied";

export interface Pair {
  from: string;
  event: string;
  outcome: PairOutcome;
  to?: string;
  guard?: string;
  // Region-local captured data (B1 core change C3): on this pair, set each field from
  // "payload.<name>", or clear it with null. Guards may read their OWN region's
  // captured data (GuardContext.own), never another region's.
  capture?: Record<string, string | null>;
}

export interface Table {
  id: string;
  initial: string;
  states: string[];
  events: string[];
  pairs: Pair[];
  guards: Record<string, string>; // guard name -> human description
}

export type StepOutcome = PairOutcome | "guard-failed";

export interface StepResult {
  outcome: StepOutcome;
  from: string;
  to: string; // === from unless outcome is "transition"
  guard?: string;
  capture?: Record<string, string | null>; // the pair's capture, on transition or noop
}

// Everything a guard may look at. Guards must be pure in these inputs (no clock,
// no I/O): the fold re-runs them on replay and must reach the same verdict.
export interface GuardContext {
  payload: Record<string, unknown>;
  actor: string | undefined;
  entity: EntityState;
  view: StateView;
  own?: Record<string, unknown>; // this region's captured data (C3); never another region's
}

export type GuardFn = (ctx: GuardContext) => boolean;

const nonEmptyString = (v: unknown) => typeof v === "string" && v.length > 0;

// Executable form of the guard descriptions in the JSON tables.
export const DEFAULT_GUARDS: Record<string, GuardFn> = {
  hasEvidenceRef: ({ payload }) => nonEmptyString(payload.evidenceRef),
  hasReason: ({ payload }) => nonEmptyString(payload.reason),
  // A reason with text, not only spaces (ruling 2026-10-20: for BLOCK and REOPEN alike, so
  // the gate and the page agree on what a reason is). Rules era 2; era 1 used hasReason.
  hasReasonText: ({ payload }) => typeof payload.reason === "string" && payload.reason.trim().length > 0,
};

export function validateTable(t: Table): Table {
  const fail = (msg: string): never => {
    throw new Error(`table ${t.id}: ${msg}`);
  };
  if (!t.states.includes(t.initial)) fail(`initial ${t.initial} is not a state`);
  const seen = new Set<string>();
  for (const p of t.pairs) {
    const key = `${p.from}+${p.event}`;
    if (seen.has(key)) fail(`duplicate pair ${key}`);
    seen.add(key);
    if (!t.states.includes(p.from)) fail(`unknown state ${p.from}`);
    if (!t.events.includes(p.event)) fail(`unknown event ${p.event}`);
    if (p.outcome === "transition") {
      if (!p.to || !t.states.includes(p.to)) fail(`${key}: bad target ${p.to}`);
    } else if (p.to !== undefined) {
      fail(`${key}: ${p.outcome} pair must not carry a target`);
    } else if (p.outcome === "denied" && p.guard !== undefined) {
      // a no-op may be guarded (who may record it, e.g. a session rename); a denied pair may not
      fail(`${key}: a denied pair must not carry a guard`);
    }
    if (p.guard && !(p.guard in t.guards)) fail(`${key}: guard ${p.guard} not declared`);
    if (p.capture !== undefined) {
      if (p.outcome === "denied") fail(`${key}: a denied pair must not capture`);
      for (const [field, src] of Object.entries(p.capture)) {
        if (!/^[a-z][a-z0-9_]*$/.test(field)) fail(`${key}: bad capture field ${field}`);
        if (src !== null && !/^payload\.[a-zA-Z][a-zA-Z0-9_]*$/.test(src)) fail(`${key}: capture ${field} must be null or payload.<field>`);
      }
    }
  }
  if (seen.size !== t.states.length * t.events.length) {
    fail(`expected ${t.states.length * t.events.length} pairs, got ${seen.size}`);
  }
  return t;
}

export const loadTable = (path: string | URL): Table =>
  validateTable(JSON.parse(readFileSync(path, "utf8")) as Table);

export function step(
  table: Table,
  from: string,
  event: string,
  guards: Record<string, GuardFn>,
  ctx: GuardContext,
): StepResult {
  const pair = table.pairs.find((p) => p.from === from && p.event === event);
  if (!pair || pair.outcome === "denied") return { outcome: "denied", from, to: from };
  const capture = pair.capture ? { capture: pair.capture } : {};
  if (pair.guard) {
    const impl = guards[pair.guard];
    if (!impl) throw new Error(`table ${table.id}: no implementation for guard ${pair.guard}`);
    if (!impl(ctx)) return { outcome: "guard-failed", from, to: from, guard: pair.guard };
  }
  if (pair.outcome === "noop") return { outcome: "noop", from, to: from, ...capture };
  return { outcome: "transition", from, to: pair.to as string, ...(pair.guard ? { guard: pair.guard } : {}), ...capture };
}

// A region's captured data after a pair's capture: fields set from the payload (a
// missing payload field captures nothing), or cleared with null.
export function applyCapture(
  prev: Record<string, unknown> | undefined,
  capture: Record<string, string | null> | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!capture) return prev;
  const next: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [field, src] of Object.entries(capture)) {
    if (src === null) delete next[field];
    else {
      const v = payload[src.slice("payload.".length)];
      if (v === undefined) delete next[field];
      else next[field] = v;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
