# Theme switch

**JTBD:** 1 — Track a branching build depth-first (reading it comfortably, day or night).

**What / why.** Three choices, picked in Profile settings' **Appearance** (each a card with a
small picture of the look) under `tira serve`, and as three small buttons at the foot of the
sidebar in a rendered file (which has no settings): System (the default), Light and Dark, all in Jira's palette (Atlassian's design tokens): white
or near-black surfaces, the sidebar a shade off, Jira blue as the one accent, Jira's status
lozenges (grey to do, blue in progress, green done, red blocked). The finish is Apple's (the
HIG; Isha, 2026-10-22): rounder corners, capsule buttons that give a little when pressed, soft
shadows, labels in the system font, sheets over a blurred page, a type scale of 11 to 28 (nothing
under 11), spacing on a 4-point rhythm, icons with even rounded strokes like Apple's symbols, and
44-point touch targets on a touch screen. Jira's colours stay (Isha, 2026-10-22). Three choices, no more (Isha,
2026-10-21). The page follows
the computer's setting until you pick one. It is CSS only (radio inputs before the page), so the rendered file still has no script;
under `tira serve` the choice is remembered per browser and carries to the confirm page.

**How to read it.** The highlighted button is the current choice. Print is always light.

## Devtool hook

- `[data-theme-switch]` on the three choices (Appearance's cards, or the rendered file's buttons).
- `[data-theme-choice]` on each radio (`system`, `light`, `dark`); `#th-system` is checked by default.

Assertion: picking Light on a dark system (or Dark on a light one) changes the page's colours;
under `tira serve` the choice survives a reload.

**Falsifier.** A forced choice is ignored, or a reload under `tira serve` drops it.
