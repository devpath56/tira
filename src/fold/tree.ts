// Tree semantics (Track C1), computed from the fold — never stored.
// All reads here are SAME-lifecycle: one tree type's entities in one stream, through
// the view. Allowed per the regions rulings (2026-10-17); cross-lifecycle reads are not.
//
// Definitions (rulings 2026-10-16/17/18):
// - terminal:   state ∈ tree.terminal (node: done, cancelled)
// - drained:    has ≥1 child and every child is terminal — direct children only
//               (ruling 2026-10-18: "drain stays local"). A leaf is not drained: it is the work.
// - closing gate: COMPLETE and CANCEL only when every child is terminal (vacuously true
//               for a leaf) — "COMPLETE denied until the subtree is drained"; "no cancelling
//               a parent with open children".
// - active:     state = tree.active (node: in_progress) and no descendant is active-state
//               ("in_progress with no in_progress descendant").
// - awaiting close: drained, and still unstarted or in progress. tira closes it, as tira,
//               when work moves on outside it (ruling 2026-10-18: "the machine holds the pen").
// - cursor:     first open LEAF in depth-first order (roots, then children, in birth order).
//               Closed branches are not entered; blocked parents are (their children stay
//               workable). Parents awaiting close are skipped — tira closes them when you
//               move on, so the cursor never parks on a parent waiting for a click.
import type { TreeConfig } from "../tables/registry.ts";
import type { EntityState, StateView } from "./types.ts";

const stateOf = (cfg: TreeConfig, e: EntityState) => e.regions[cfg.region] as string;
export const isTerminal = (cfg: TreeConfig, e: EntityState) => cfg.terminal.includes(stateOf(cfg, e));
export const isActionable = (cfg: TreeConfig, e: EntityState) => cfg.actionable.includes(stateOf(cfg, e));

export function children(e: EntityState, view: StateView): EntityState[] {
  return (e.tree?.children ?? []).map((k) => view.getKey(k)).filter((c): c is EntityState => c !== undefined);
}

export const allChildrenTerminal = (cfg: TreeConfig, e: EntityState, view: StateView) =>
  children(e, view).every((c) => isTerminal(cfg, c));

export function isDrained(cfg: TreeConfig, e: EntityState, view: StateView): boolean {
  const kids = children(e, view);
  return kids.length > 0 && kids.every((c) => isTerminal(cfg, c));
}

export const awaitingClose = (cfg: TreeConfig, e: EntityState, view: StateView) =>
  isActionable(cfg, e) && isDrained(cfg, e, view);

function anyDescendant(e: EntityState, view: StateView, test: (d: EntityState) => boolean): boolean {
  return children(e, view).some((c) => test(c) || anyDescendant(c, view, test));
}

// Is `ancestor` the node `key` itself, or above it?
export function contains(ancestor: EntityState, key: string, view: StateView): boolean {
  let cur = view.getKey(key);
  while (cur) {
    if (cur.key === ancestor.key) return true;
    cur = cur.tree?.parent === undefined ? undefined : view.getKey(cur.tree.parent);
  }
  return false;
}

export function roots(type: string, view: StateView): EntityState[] {
  return view
    .all(type)
    .filter((e) => e.tree !== undefined && e.tree.parent === undefined)
    .sort((a, b) => a.createdSeq - b.createdSeq);
}

function preorder(type: string, view: StateView): EntityState[] {
  const out: EntityState[] = [];
  const walk = (e: EntityState) => {
    out.push(e);
    for (const c of children(e, view)) walk(c);
  };
  for (const r of roots(type, view)) walk(r);
  return out;
}

export function activeNodes(cfg: TreeConfig, type: string, view: StateView): EntityState[] {
  const isActiveState = (d: EntityState) => stateOf(cfg, d) === cfg.active;
  return preorder(type, view).filter((e) => isActiveState(e) && !anyDescendant(e, view, isActiveState));
}

export function cursor(cfg: TreeConfig, type: string, view: StateView): EntityState | undefined {
  let found: EntityState | undefined;
  const walk = (e: EntityState) => {
    if (found || isTerminal(cfg, e)) return; // the gates keep closed branches free of open work: a speed-up
    if (isActionable(cfg, e) && (e.tree?.children.length ?? 0) === 0) {
      found = e;
      return;
    }
    for (const c of children(e, view)) walk(c);
  };
  for (const r of roots(type, view)) walk(r);
  return found;
}

// The next parent tira should close when work moves on to `targetKey`: awaiting close and
// not containing the target. Deepest first, so closing it can drain (and then close) its
// own parent on the next call — the chain climbs one level per call.
export function nextCloseFor(cfg: TreeConfig, type: string, view: StateView, targetKey: string): EntityState | undefined {
  return preorder(type, view)
    .filter((e) => awaitingClose(cfg, e, view) && !contains(e, targetKey, view))
    .sort((a, b) => (b.tree?.depth ?? 1) - (a.tree?.depth ?? 1))[0];
}
