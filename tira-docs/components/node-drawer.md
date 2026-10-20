# Task drawer

**JTBD:** 11 — Verify the system isn't lying.

**What / why.** Click any task for its state, its marks and its full history, rejected
commands included. Words live here, not on the canvas.

**How to read it.** The path above the name, the state badge, marks (next, active, drained,
closed by tira, found during X), then "N of M children closed" and the history, oldest first.
tira's entries say why and which move they cite. An entry written before the rules version
marker carries a "legacy" tag: it was judged, and is replayed, under the legacy era's rules
(versioned rules, 2026-10-20).

## Devtool hook

- `.drawer` sections with ids `#t0`, `#t1`, … in tree order; the palette's index uses the same ids.
- `.legacy` on the tag of each entry with no rules era (Activity counts them too).

Assertion: every node is one click from its event trail.

**Falsifier.** A task's history leaves out an event the log has for it.
