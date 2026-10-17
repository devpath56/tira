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
}

// Everything a guard may look at. Guards must be pure in these inputs (no clock,
// no I/O): the fold re-runs them on replay and must reach the same verdict.
export interface GuardContext {
  payload: Record<string, unknown>;
  actor: string | undefined;
  entity: EntityState;
  view: StateView;
}

export type GuardFn = (ctx: GuardContext) => boolean;

const nonEmptyString = (v: unknown) => typeof v === "string" && v.length > 0;

// Executable form of the guard descriptions in the JSON tables.
export const DEFAULT_GUARDS: Record<string, GuardFn> = {
  hasEvidenceRef: ({ payload }) => nonEmptyString(payload.evidenceRef),
  hasReason: ({ payload }) => nonEmptyString(payload.reason),
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
    } else if (p.to !== undefined || p.guard !== undefined) {
      fail(`${key}: ${p.outcome} pair must not carry to/guard`);
    }
    if (p.guard && !(p.guard in t.guards)) fail(`${key}: guard ${p.guard} not declared`);
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
  if (pair.outcome === "noop") return { outcome: "noop", from, to: from };
  if (pair.guard) {
    const impl = guards[pair.guard];
    if (!impl) throw new Error(`table ${table.id}: no implementation for guard ${pair.guard}`);
    if (!impl(ctx)) return { outcome: "guard-failed", from, to: from, guard: pair.guard };
  }
  return { outcome: "transition", from, to: pair.to as string, ...(pair.guard ? { guard: pair.guard } : {}) };
}
