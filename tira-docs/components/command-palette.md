# ⌘K palette

**JTBD:** 1 — Track a branching build depth-first (find), with 2 and 3 (act).

**What / why.** Find any task by a few letters and open its dialog, or type a verb first to
act on it: `start`, `unblock`, `complete`, `block`. One surface for Find and Direct. Only under
`tira serve`; the rendered page has no script.

**How to read it.** ⌘K (Ctrl-K) or "Search tasks in <project>" in the board's header, beside
its numbers (the sidebar's search is for projects: `project-switch.md`). Opened empty, it offers what needs
you first: the next task (◆ next), then work in progress, then blocked work, then the rest to
do; closed work last. Typed, matches rank exact name, then name prefix, then initials ("ls" →
loading_state), then a word inside the name, then any letters in order; ties keep tree order.
With a verb, only tasks whose state allows it are listed ("unblock " lists every blocked task).
Enter opens the task's dialog, or the decision dialog for a verb; while the board shows the
Graph, Enter moves the canvas to the task instead (its folds open, it is ringed and focused,
and Enter on it opens its dialog). A screen reader hears the highlighted match as the arrows
move (a combobox with `aria-activedescendant`).

## Devtool hook

- `[data-open-palette]` on the header's search that opens it (live page only).
- `#palette` on the palette; `[data-ms]` on it records the last ranking time.

Assertion: `src/serve/rank.mjs` is the one ranking, shared by the browser and the tests.

**Falsifier.** After ⌘K and at most 3 letters, a task is not among the visible matches (the
first 8, reachable with the arrow keys), or ranking takes 100 ms or more. On the 9-task demo
every task comes first; on a 100-task tree of look-alike names every task is visible but
not always first.
