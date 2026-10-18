// A render-ready shape of the fold's tree for one stream: the single source both the
// text tree (`tira tree`) and the D1 HTML page (`tira render`) draw from, so the two
// can't disagree with each other or with `tira dump`.
import type { FoldResult } from "../fold/fold.ts";
import type { EntityState } from "../fold/types.ts";

export interface TreeRow {
  key: string;
  id: string;
  type: string;
  state: string; // the tree region's state
  depth: number;
  drained: boolean;
  cursor: boolean;
  active: boolean;
  discoveredDuring?: string;
  children: TreeRow[];
}

export interface StreamView {
  stream: string;
  lastSeq: number;
  roots: TreeRow[];
  nodeCount: number;
  cursor: string | null;
  active: string[];
  others: EntityState[]; // entities of non-tree types (e.g. ideas)
}

export function streamView(r: FoldResult, stream: string, treeRegion = "lifecycle"): StreamView {
  const inStream = r.entities.filter((e) => e.stream === stream);
  const byKey = new Map(inStream.map((e) => [e.key, e]));
  const summaries = r.trees[stream] ?? {};
  const derived = r.derived[stream] ?? {};
  const cursors = new Set(Object.values(summaries).map((s) => s.cursor).filter((c): c is string => c !== null));
  const actives = new Set(Object.values(summaries).flatMap((s) => s.active));
  let nodeCount = 0;
  const row = (e: EntityState): TreeRow => {
    nodeCount++;
    return {
      key: e.key,
      id: e.id,
      type: e.type,
      state: e.regions[treeRegion] ?? Object.values(e.regions)[0] ?? "",
      depth: e.tree?.depth ?? 1,
      drained: derived[e.key]?.drained === true,
      cursor: cursors.has(e.key),
      active: actives.has(e.key),
      ...(e.tree?.discoveredDuring === undefined ? {} : { discoveredDuring: e.tree.discoveredDuring }),
      children: (e.tree?.children ?? []).map((k) => byKey.get(k)).filter((c): c is EntityState => c !== undefined).map(row),
    };
  };
  const roots = Object.values(summaries).flatMap((s) => s.roots).map((k) => byKey.get(k)).filter((e): e is EntityState => e !== undefined).map(row);
  const firstCursor = Object.values(summaries).map((s) => s.cursor).find((c) => c !== null) ?? null;
  return {
    stream,
    lastSeq: r.lastSeq,
    roots,
    nodeCount,
    cursor: firstCursor,
    active: [...actives],
    others: inStream.filter((e) => e.tree === undefined),
  };
}

// Plain-text tree for the terminal.
export function textTree(v: StreamView): string[] {
  const out = [`stream ${v.stream} · seq ${v.lastSeq} · ${v.nodeCount} node(s) · cursor ${v.cursor ?? "—"} · active ${v.active.join(", ") || "—"}`];
  if (v.roots.length === 0) return [...out, "  (no tree yet)"];
  const width = Math.max(...flatten(v.roots).map((r) => (r.depth - 1) * 3 + r.id.length)) + 2;
  const walk = (rows: TreeRow[], prefix: string) => {
    rows.forEach((r, i) => {
      const last = i === rows.length - 1;
      const branch = r.depth === 1 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
      const label = `${branch}${r.id}`;
      const marks = [r.cursor ? "◆ cursor" : "", r.active ? "● active" : "", r.drained ? "drained" : "", r.discoveredDuring ? `found during ${r.discoveredDuring.replace(/^[^:]+:/, "")}` : ""].filter(Boolean).join("  ");
      out.push(`${label.padEnd(width)}${r.state.padEnd(12)}${marks}`.trimEnd());
      walk(r.children, r.depth === 1 ? "" : `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(v.roots, "");
  return out;
}

export function flatten(rows: TreeRow[]): TreeRow[] {
  return rows.flatMap((r) => [r, ...flatten(r.children)]);
}
