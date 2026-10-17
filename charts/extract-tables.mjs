// Mechanical extraction of the canonical JSON transition tables from the
// verified XState chart objects. The .mjs charts are the single source of
// truth; this script makes JSON<->XState drift inexpressible (q08).
// NEVER hand-edit the JSON — re-run this after any chart change:
//   node charts/extract-tables.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeLifecycle } from "./node-lifecycle.mjs";
import { ideaLifecycle } from "./idea-lifecycle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = (fn) => fn.toString().replace(/\s+/g, " ");

// Human-authored, reviewable: normalized guard source -> { name, description }.
// Extraction THROWS on any guard fn not registered here — fail loud, never
// silently mislabel (q04).
const GUARD_REGISTRY = new Map([
  [
    `({ event }) => typeof event.evidenceRef === "string" && event.evidenceRef.length > 0`,
    { name: "hasEvidenceRef", description: "event.evidenceRef is a non-empty string" },
  ],
  [
    `({ event }) => typeof event.reason === "string" && event.reason.length > 0`,
    { name: "hasReason", description: "event.reason is a non-empty string" },
  ],
]);

function extract(chart) {
  const states = Object.keys(chart.states);
  const events = [...new Set(states.flatMap((s) => Object.keys(chart.states[s].on ?? {})))];
  const pairs = [];
  const usedGuards = new Map();
  for (const st of states) {
    const on = chart.states[st].on ?? {};
    for (const ev of events) {
      const def = on[ev];
      if (def === undefined) {
        pairs.push({ from: st, event: ev, outcome: "denied" });
      } else if (typeof def === "string") {
        pairs.push({ from: st, event: ev, outcome: "transition", to: def });
      } else if (def && typeof def === "object") {
        if (def.target) {
          let guardName = null;
          if (def.guard) {
            const reg = GUARD_REGISTRY.get(norm(def.guard));
            if (!reg) throw new Error(`unregistered guard on ${chart.id}: ${st} + ${ev}`);
            guardName = reg.name;
            usedGuards.set(reg.name, reg.description);
          }
          pairs.push({
            from: st, event: ev, outcome: "transition", to: def.target,
            ...(guardName ? { guard: guardName } : {}),
          });
        } else if (Object.keys(def).length === 0) {
          pairs.push({ from: st, event: ev, outcome: "noop" });
        } else {
          throw new Error(`unhandled transition def on ${chart.id}: ${st} + ${ev}`);
        }
      } else {
        throw new Error(`unhandled transition def on ${chart.id}: ${st} + ${ev}`);
      }
    }
  }
  return {
    id: chart.id,
    initial: chart.initial,
    states,
    events,
    pairs,
    guards: Object.fromEntries(usedGuards),
  };
}

for (const [chart, file] of [
  [nodeLifecycle, "node-lifecycle.json"],
  [ideaLifecycle, "idea-lifecycle.json"],
]) {
  const table = extract(chart);
  writeFileSync(join(HERE, file), JSON.stringify(table, null, 2) + "\n");
  console.log(`wrote ${file}: ${table.pairs.length} pairs, guards: ${Object.keys(table.guards).join(", ") || "none"}`);
}
