// Tree semantics (Track C1), computed from the fold — never stored.
// All reads here are SAME-lifecycle: one tree type's entities in one stream, through
// the view. Allowed per the regions rulings (2026-10-17); cross-lifecycle reads are not.
//
// Definitions (rulings 2026-10-16/17; interpretation flagged where noted):
// - terminal:   state ∈ tree.terminal (node: done, cancelled)
// - drained:    has ≥1 child and every child is terminal (README: "every child
//               done-or-cancelled"). A leaf is not "drained": it is the work.
// - COMPLETE gate: allowed only when every child is terminal (vacuously true for a
//               leaf) — "COMPLETE denied at the write path until the subtree is drained".
// - active:     state = tree.active (node: in_progress) and no descendant is active-state
//               (ruling A4: "in_progress with no in_progress descendant").
// - cursor:     first node in depth-first preorder (roots, then children, in birth order;
//               closed branches are not entered) that is actionable AND completable now —
//               a leaf, or a parent whose children are all terminal.
//               INTERPRETATION: the ruling says "first task in DFS order that isn't done,
//               cancelled or blocked"; read literally that is always the root, since a
//               parent stays open until its subtree is done. Scoped to finishable work, as
//               "active" is scoped in A4 — so a drained-but-open parent becomes the cursor
//               ("complete me") and the backtrack climbs by completing it, while a parent
//               with a blocked child is passed over (it can't complete yet).
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

function anyDescendant(e: EntityState, view: StateView, test: (d: EntityState) => boolean): boolean {
  return children(e, view).some((c) => test(c) || anyDescendant(c, view, test));
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
    if (found || isTerminal(cfg, e)) return; // work under a closed node is not live
    if (isActionable(cfg, e) && allChildrenTerminal(cfg, e, view)) {
      found = e;
      return;
    }
    for (const c of children(e, view)) walk(c);
  };
  for (const r of roots(type, view)) walk(r);
  return found;
}
