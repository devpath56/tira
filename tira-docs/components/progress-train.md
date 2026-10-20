# Progress line

**JTBD:** 1 — Track a branching build depth-first.

**What / why.** Every task is a stop on one line, in tree order, so "how much is done, and
what's left" is one glance.

**How to read it.** Filled stops are done (crossed out: dropped). The blue marker sits on the
next task ("on it" once started); hollow stops are what's left. Below, one line per parent: its
children as stops, and "1 of 3 tasks closed · 2 left".

## Devtool hook

- `[data-key]` on each task, exactly once, with `[data-state]`, `[data-cursor]`, `[data-active]` and `[data-drained]`.
- `[data-node-count]` and `[data-fold-tree-count]` on the page: they must be equal.

Assertion: every fold node appears once with the fold's flags (manual test M1).

**Falsifier.** A task on the progress line disagrees with `tira dump`.
