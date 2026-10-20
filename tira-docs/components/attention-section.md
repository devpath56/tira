# Needs attention

**JTBD:** 3 — Get interrupted and resume exactly (and 1 — Track a branching build depth-first).

**What / why.** The first thing on the page: what is blocked, grouped by the reason it was
blocked with, and what is being worked on. It is bounded by attention, not by tree size, so
it grows with work in progress, not with the number of tasks. Blocking a task needs a reason
with text (2026-10-20), so a new blocked row always says why; a legacy log's bare block shows
"no reason given". A finished active parent isn't listed: there is no decision in it, and tira
closes it when work moves on (ruling 2026-10-20); it stays in the tree. Stale work joins once
its time limit is ruled.

**How to read it.** "N need you", then one group per reason ("Blocked · waiting on the
design-token decision"), then "In progress". Each row: the task (click for its drawer), where
it sits in the tree, and since when ("blocked at seq 12"). Under `tira serve`, each row also
has its next action. Nothing needs you: "Nothing needs you", and the next task.

## Devtool hook

- `[data-attention-count]` on the section: the number of rows.
- `[data-attention-key]` on each row: the task's key. Rows don't reuse the train's per-task marker, so the M1 node count is untouched.
- `[data-reason]` on each blocked group: the reason, as given.

Assertion: the count = blocked tasks + active tasks in the fold, less active parents waiting for tira's close.

**Falsifier.** A stranger can't name what needs them within 5 seconds of opening the page.
