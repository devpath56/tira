// Tiny runner over the canonical JSON transition tables.
// Guard implementations are the executable form of the tables' guard
// descriptions; verify-tables.mjs proves they match the XState machines
// on every pair x guard-polarity (the differential is the control against
// runner/chart drift).
import { readFileSync } from "node:fs";

export const loadTable = (path) => JSON.parse(readFileSync(path, "utf8"));

const GUARD_IMPLS = {
  hasEvidenceRef: (ev) => typeof ev.evidenceRef === "string" && ev.evidenceRef.length > 0,
  hasReason: (ev) => typeof ev.reason === "string" && ev.reason.length > 0,
};

export function step(table, from, event) {
  const row = table.pairs.find((p) => p.from === from && p.event === event.type);
  if (!row || row.outcome === "denied") return from; // invalid event: stay
  if (row.outcome === "noop") return from; // valid no-op: stay
  if (row.guard) {
    const impl = GUARD_IMPLS[row.guard];
    if (!impl) throw new Error(`no implementation for guard ${row.guard}`);
    if (!impl(event)) return from; // guard violated: stay
  }
  return row.to;
}

export function run(table, events) {
  let s = table.initial;
  for (const e of events) s = step(table, s, typeof e === "string" ? { type: e } : e);
  return s;
}
