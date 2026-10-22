# Theme switch

**JTBD:** 1 — Track a branching build depth-first (reading it comfortably, day or night).

**What / why.** Three small buttons on every page (at the foot of the sidebar on the board):
System (the default), Light and Dark, after Linear: quiet greys, one indigo accent, status
colours that mean one thing each. Three choices, no more (Isha, 2026-10-21). The page follows
the computer's setting until you pick one. It is CSS only (radio inputs before the page), so the rendered file still has no script;
under `tira serve` the choice is remembered per browser and carries to the confirm page.

**How to read it.** The highlighted button is the current choice. Print is always light.

## Devtool hook

- `[data-theme-switch]` on the three buttons.
- `[data-theme-choice]` on each radio (`system`, `light`, `dark`); `#th-system` is checked by default.

Assertion: picking Light on a dark system (or Dark on a light one) changes the page's colours;
under `tira serve` the choice survives a reload.

**Falsifier.** A forced choice is ignored, or a reload under `tira serve` drops it.
