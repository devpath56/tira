# Lanes

**JTBD:** 11 — Verify the system isn't lying (for the factory).

**What / why.** A factory brief has three dials (gate, claim, outcome); the lanes show them side
by side, so the joint state is read, never flattened. Then sessions and drops, then handoffs,
each under its own label. The tab shows only when the stream has something for it: a plain
task tree has no Lanes tab.

**How to read it.** One row per brief, one column per dial. "Claimable now" or "needs X" under
the brief's name. Handoffs: "N waiting, M done"; each pair links the event that started it to
what the dispatcher wrote, by correlation id. An outcome of done-verified means the done test
said exactly PASS: the drop's table checks it, and since rules era 3 (2026-10-21) the brief's too.

## Devtool hook

- `.lanes-label` headings for each block.
- `[data-frontier]` on each brief: true when it is claimable now.
- `[data-correlation]` on each handoff pair.

Assertion: a brief is marked claimable exactly when the fold's frontier lists it.

**Falsifier.** A brief shows as claimable that the fold doesn't list, or a pair's ids differ.
