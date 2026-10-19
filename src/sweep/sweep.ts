// Health sweeps (build plan phase 3; functional requirements, "Safety checks" and "hollow
// tasks"). On demand and read-only: `tira sweep` folds the log, then re-checks the result
// from its raw fields (parent pointers, child lists, depths, states) without the tree
// helpers the fold and the gates use, so a bug there shows up here instead of agreeing
// with itself. The write path and replay refuse anything that would break these rules,
// so a "broken" finding means the log or the code disagrees with the rules. "Attention"
// findings are legal, but worth a look.
import type { StoredEvent } from "../store/types.ts";
import type { Registry, TreeConfig } from "../tables/registry.ts";
import { compareCodeUnits, fold } from "../fold/fold.ts";
import { toIntent } from "../fold/events.ts";
import type { EntityState } from "../fold/types.ts";

export type Severity = "broken" | "attention";

export const CHECKS = [
  { id: "rules", severity: "broken", title: "the log follows the rules" },
  { id: "orphans", severity: "broken", title: "every task's parent exists" },
  { id: "loops", severity: "broken", title: "no loops in parents or in blocked_by" },
  { id: "links", severity: "broken", title: "parents and children agree" },
  { id: "counts", severity: "broken", title: "the counts add up" },
  { id: "depth", severity: "broken", title: "depths match the tree and the cap" },
  { id: "closed-parents", severity: "broken", title: "no closed parent has open work" },
  { id: "hollow", severity: "attention", title: "every task says what it is and when it's done" },
  { id: "regrown", severity: "attention", title: "finished work that grew new work" },
] as const satisfies readonly { id: string; severity: Severity; title: string }[];

export type CheckId = (typeof CHECKS)[number]["id"];

export interface Finding {
  key?: string; // the entity it is about, when there is one
  seq?: number; // the event it is about, when there is one
  detail: string;
}

export interface CheckResult {
  id: CheckId;
  severity: Severity;
  title: string;
  findings: Finding[];
}

export interface SweepReport {
  stream: string;
  atSeq: number; // the last event swept (0 for an empty stream)
  checks: CheckResult[]; // every check, in CHECKS order, findings sorted
  broken: number;
  attention: number;
}

// The fields a task's birth payload uses to say what it is and when it is done
// (functional requirements: "a written definition" and "finish criteria").
export const DEFINITION = "definition";
export const DONE_CRITERIA = "done_criteria";

type Findings = Map<CheckId, Finding[]>;
const add = (out: Findings, id: CheckId, f: Finding) => out.set(id, [...(out.get(id) ?? []), f]);
const stateOf = (cfg: TreeConfig, e: EntityState) => e.regions[cfg.region];
const closed = (cfg: TreeConfig, e: EntityState) => cfg.terminal.includes(stateOf(cfg, e) as string);
const written = (v: unknown) => typeof v === "string" && v.trim().length > 0;

// The structural checks, over one stream's folded entities. Exported so tests can feed it
// state the fold would never produce.
export function checkStructure(entities: readonly EntityState[], registry: Registry, out: Findings = new Map()): Findings {
  const byKey = new Map(entities.map((e) => [e.key, e]));
  for (const def of registry.types()) {
    const cfg = def.tree;
    if (!cfg) continue;
    const nodes = entities.filter((e) => e.type === def.type).sort((a, b) => compareCodeUnits(a.key, b.key));
    if (nodes.length === 0) continue;
    const parentOf = (e: EntityState) => e.tree?.parent;
    const kidsOf = (e: EntityState) => e.tree?.children ?? [];

    // orphans: a parent that doesn't exist, or isn't a task of the same type
    for (const e of nodes) {
      if (!e.tree) { add(out, "orphans", { key: e.key, detail: "has no place in the tree" }); continue; }
      const p = parentOf(e);
      if (p === undefined) continue;
      const parent = byKey.get(p);
      if (!parent) add(out, "orphans", { key: e.key, detail: `its parent ${p} doesn't exist` });
      else if (parent.type !== def.type) add(out, "orphans", { key: e.key, detail: `its parent ${p} isn't a ${def.type}` });
    }

    // loops: following parents from a task comes back to it. On the way, each task's depth
    // (root = 1), or null when its parents don't end at a root (an orphan's chain, or a
    // loop). A walk stops at a task an earlier walk reached, so each loop is found once;
    // it is spelled from its smallest key.
    const depthOf = new Map<string, number | null>();
    for (const e of nodes) {
      const path: string[] = [];
      let cur: EntityState | undefined = e;
      let base: number | null;
      for (;;) {
        if (!cur) { base = null; break; } // a missing parent
        if (depthOf.has(cur.key)) { base = depthOf.get(cur.key) as number | null; break; }
        if (path.includes(cur.key)) {
          const loop = rotate(path.slice(path.indexOf(cur.key)));
          add(out, "loops", { key: loop[0] as string, detail: `parents loop: ${[...loop, loop[0]].join(" → ")}` });
          base = null;
          break;
        }
        path.push(cur.key);
        const p = parentOf(cur);
        if (p === undefined) { base = 0; break; }
        const next = byKey.get(p);
        cur = next?.type === def.type ? next : undefined;
      }
      for (const [i, k] of [...path].reverse().entries()) depthOf.set(k, base === null ? null : base + i + 1);
    }

    // links: a parent lists exactly the tasks that name it as their parent, once each
    for (const p of nodes) {
      const listed = new Set<string>();
      for (const c of kidsOf(p)) {
        if (listed.has(c)) { add(out, "links", { key: p.key, detail: `lists ${c} twice` }); continue; }
        listed.add(c);
        const child = byKey.get(c);
        if (!child) add(out, "links", { key: p.key, detail: `lists ${c}, which doesn't exist` });
        else if (child.type !== def.type) add(out, "links", { key: p.key, detail: `lists ${c}, which isn't a ${def.type}` });
        else if (parentOf(child) !== p.key) add(out, "links", { key: p.key, detail: `lists ${c}, whose parent is ${parentOf(child) ?? "none (a root)"}` });
      }
    }
    for (const c of nodes) {
      const p = parentOf(c);
      const parent = p === undefined ? undefined : byKey.get(p);
      if (parent?.type === def.type && !kidsOf(parent).includes(c.key)) add(out, "links", { key: c.key, detail: `names ${p} as its parent, but ${p} doesn't list it` });
    }

    // counts: walking down from the roots reaches every task exactly once; at most one
    // task is being worked on; no parent has more children than the cap. Iterative, and
    // each task is walked once however often it is listed, so no shape of child lists
    // can blow the stack or the clock.
    const reached = new Map<string, number>();
    const todo = nodes.filter((e) => e.tree && parentOf(e) === undefined).map((e) => e.key).reverse();
    while (todo.length > 0) {
      const k = todo.pop() as string;
      const n = (reached.get(k) ?? 0) + 1;
      reached.set(k, n);
      if (n > 1) continue;
      const e = byKey.get(k) as EntityState;
      for (const c of [...kidsOf(e)].reverse()) if (byKey.get(c)?.type === def.type) todo.push(c);
    }
    const unreached = nodes.filter((e) => !reached.has(e.key)).length;
    if (unreached > 0) add(out, "counts", { detail: `${nodes.length} ${def.type}s, but only ${nodes.length - unreached} are reached from the roots` });
    for (const [k, n] of reached) if (n > 1) add(out, "counts", { key: k, detail: `reached ${n} times from the roots` });
    if (cfg.oneActive) {
      // working with nothing working below it: mark every ancestor of a working task
      const working = (e: EntityState) => stateOf(cfg, e) === cfg.active;
      const above = new Set<string>();
      for (const w of nodes.filter(working)) {
        let p = parentOf(w);
        const seen = new Set<string>();
        while (p !== undefined && !seen.has(p)) {
          seen.add(p);
          above.add(p);
          p = byKey.get(p)?.tree?.parent;
        }
      }
      const active = nodes.filter((e) => working(e) && !above.has(e.key)).map((e) => e.key);
      if (active.length > 1) add(out, "counts", { detail: `${active.length} tasks in progress at once (${active.join(", ")}); the gate allows one` });
    }
    for (const p of nodes) {
      const n = kidsOf(p).length;
      if (n > cfg.maxChildren) add(out, "counts", { key: p.key, detail: `has ${n} children; the cap is ${cfg.maxChildren}` });
    }

    // depth: the recorded depth is where the task sits, within the cap
    for (const e of nodes) {
      const d = depthOf.get(e.key);
      if (d === undefined || d === null || !e.tree) continue; // its parents don't reach a root, so there's no depth to compare
      if (e.tree.depth !== d) add(out, "depth", { key: e.key, detail: `records depth ${e.tree.depth}, but sits at depth ${d}` });
      if (d > cfg.maxDepth) add(out, "depth", { key: e.key, detail: `sits at depth ${d}; the cap is ${cfg.maxDepth}` });
    }

    // closed parents: a done or cancelled task has only done or cancelled children
    for (const p of nodes) {
      if (!closed(cfg, p)) continue;
      for (const c of kidsOf(p)) {
        const child = byKey.get(c);
        if (child && !closed(cfg, child)) add(out, "closed-parents", { key: p.key, detail: `is ${stateOf(cfg, p)}, but ${c} is ${stateOf(cfg, child)}` });
      }
    }
  }

  // loops in dependency graphs (brief blocked_by), between current versions
  for (const def of registry.types()) {
    const field = def.dependsOn;
    if (field === undefined) continue;
    const all = entities.filter((e) => e.type === def.type);
    const current = all.filter((e) => e.version === undefined || !all.some((n) => n.id === e.id && n.version === (e.version as number) + 1));
    const edges = new Map<string, string[]>();
    for (const e of current) {
      const deps = e.born?.[field];
      edges.set(e.id, Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : []);
    }
    const seen = new Set<string>();
    const done = new Set<string>();
    const reported = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (done.has(id)) return;
      if (seen.has(id)) {
        const ordered = rotate(path.slice(path.indexOf(id)));
        if (!reported.has(ordered.join(" "))) {
          reported.add(ordered.join(" "));
          add(out, "loops", { key: `${def.type}:${ordered[0]}`, detail: `${field} loops: ${[...ordered, ordered[0]].join(" → ")}` });
        }
        return;
      }
      seen.add(id);
      for (const d of edges.get(id) ?? []) if (edges.has(d)) visit(d, [...path, id]);
      seen.delete(id);
      done.add(id);
    };
    for (const id of [...edges.keys()].sort(compareCodeUnits)) visit(id, []);
  }
  return out;
}

// A loop's members, starting from the smallest key, so each loop has one spelling.
function rotate(loop: string[]): string[] {
  const start = loop.indexOf([...loop].sort(compareCodeUnits)[0] as string);
  return [...loop.slice(start), ...loop.slice(0, start)];
}

// Sweep one stream, as of `upToSeq` (default: the whole log). One fold: it replays the
// stream with `upToSeq` (so a cut in the middle of tira's close is not an anomaly, as in
// `tira state --at`), and the history checks ride along on it.
export function sweep(log: readonly StoredEvent[], registry: Registry, stream: string, opts: { upToSeq?: number } = {}): SweepReport {
  const events = log.filter((e) => e.stream === stream).sort((a, b) => a.seq - b.seq);
  const out: Findings = new Map();
  const history = regrown(registry, out);
  const r = fold(events, registry, { ...(opts.upToSeq === undefined ? {} : { upToSeq: opts.upToSeq }), onApply: history });
  const entities = r.entities.filter((e) => e.stream === stream);

  for (const a of r.anomalies) add(out, "rules", { seq: a.seq, detail: `${a.type}: ${a.problem}` });
  checkStructure(entities, registry, out);
  hollow(entities, events, registry, out);

  const checks = CHECKS.map((c) => ({
    ...c,
    findings: [...(out.get(c.id) ?? [])].sort(
      (a, b) => compareCodeUnits(a.key ?? "", b.key ?? "") || (a.seq ?? 0) - (b.seq ?? 0) || compareCodeUnits(a.detail, b.detail),
    ),
  }));
  const count = (s: Severity) => checks.filter((c) => c.severity === s).reduce((n, c) => n + c.findings.length, 0);
  return { stream, atSeq: r.lastSeq, checks, broken: count("broken"), attention: count("attention") };
}

// hollow: a task whose birth didn't say what it is, or when it's done. A task born from an
// idea (idea → node.born {idea_id}) takes what its idea's birth said.
function hollow(entities: readonly EntityState[], events: readonly StoredEvent[], registry: Registry, out: Findings): void {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const byKey = new Map(entities.map((e) => [e.key, e]));
  const birthOf = (e: EntityState | undefined): Record<string, unknown> => {
    const birth = e === undefined ? undefined : bySeq.get(e.createdSeq);
    return (birth ? toIntent(birth, (t, v) => registry.creationName(t, v))?.payload : undefined) ?? {};
  };
  for (const e of entities) {
    if (!registry.get(e.type)?.tree) continue;
    const own = birthOf(e);
    const idea = typeof own.idea_id === "string" ? birthOf(byKey.get(`idea:${own.idea_id}`)) : {};
    const has = (field: string) => written(own[field]) || written(idea[field]);
    const missing = [DEFINITION, DONE_CRITERIA].filter((f) => !has(f));
    if (missing.length > 0) add(out, "hollow", { key: e.key, detail: `no ${missing.join(" or ")}` });
  }
}

// regrown: a child born under a task that had been done and was re-opened (scope creep:
// "work under a finished branch needs an explicit re-open, with a reason"). Read in the
// sweep's one fold. A drained parent that is still open taking a child is ordinary
// planning (the un-drain window, ruling 2026-10-18), so it isn't flagged.
function regrown(registry: Registry, out: Findings) {
  const closedAt = new Map<string, { seq: number; state: string }>(); // task -> when it last closed, and how
  return (e: StoredEvent, intent: { kind: string }, ev: { key: string; regions: Record<string, string>; outcome: string; tree?: { parent?: string } }) => {
    const cfg = registry.get(e.type.slice(0, e.type.indexOf(".")))?.tree;
    if (!cfg) return;
    const p = ev.tree?.parent;
    const was = p === undefined ? undefined : closedAt.get(p);
    if (intent.kind === "create" && p !== undefined && was !== undefined) {
      add(out, "regrown", { key: p, seq: e.seq, detail: `was ${was.state} at seq ${was.seq}, then ${ev.key} was added` });
    }
    const state = ev.regions[cfg.region] as string;
    if (ev.outcome === "transition" && cfg.terminal.includes(state)) closedAt.set(ev.key, { seq: e.seq, state });
  };
}
