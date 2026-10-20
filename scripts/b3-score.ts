// Scores a blind round of the B3 fixture: locked verdicts against the manifest, per event
// id, mechanically. The bar: every planted divergence caught with its own kind, and no clean
// transition called anything but OK.
//
//   node scripts/b3-score.ts [manifest.json] [verdicts.json]   (defaults: fixtures/b3/)
//
// Exits 0 when the bar is met, 1 when it isn't.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Manifest } from "./b3-fixture.ts";

export interface Score {
  ids: number; // event ids in the manifest
  right: number; // verdicts that equal the manifest's
  planted: number;
  caught: number; // planted ids called by their own kind
  clean: number;
  falsePositives: number; // clean ids called anything but OK (or not called)
  outside: string[]; // verdicts on ids the manifest doesn't have
  unanswered: string[]; // manifest ids with no verdict
  misses: { event_id: string; transition: string; expected: string; got: string }[];
  barMet: boolean;
}

export function score(manifest: Manifest, verdicts: Record<string, string>): Score {
  const known = new Set(manifest.verdicts.map((m) => m.event_id));
  const misses: Score["misses"] = [];
  let caught = 0;
  let falsePositives = 0;
  for (const m of manifest.verdicts) {
    const got = verdicts[m.event_id] ?? "(none)";
    if (got !== m.verdict) misses.push({ event_id: m.event_id, transition: m.transition, expected: m.verdict, got });
    if (m.verdict !== "OK" && got === m.verdict) caught++;
    if (m.verdict === "OK" && got !== "OK") falsePositives++;
  }
  const planted = manifest.verdicts.filter((m) => m.verdict !== "OK").length;
  const outside = Object.keys(verdicts).filter((id) => !known.has(id));
  const unanswered = [...known].filter((id) => verdicts[id] === undefined);
  return {
    ids: known.size, right: known.size - misses.length, planted, caught, clean: known.size - planted, falsePositives,
    outside, unanswered, misses, barMet: caught === planted && falsePositives === 0 && outside.length === 0,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(process.argv[2] ?? "fixtures/b3/manifest.json", "utf8")) as Manifest;
  const locked = JSON.parse(readFileSync(process.argv[3] ?? "fixtures/b3/verdicts.json", "utf8")) as { verdicts: Record<string, string> };
  const s = score(manifest, locked.verdicts);
  console.log(`${s.right}/${s.ids} verdicts right · planted caught ${s.caught}/${s.planted} · false positives ${s.falsePositives}/${s.clean} clean · ids outside the manifest ${s.outside.length} · unanswered ${s.unanswered.length}`);
  for (const m of s.misses) console.log(`  ${m.transition}: expected ${m.expected}, got ${m.got}`);
  console.log(s.barMet ? "bar met: all planted caught, 0 false positives" : "bar NOT met");
  process.exitCode = s.barMet ? 0 : 1;
}
