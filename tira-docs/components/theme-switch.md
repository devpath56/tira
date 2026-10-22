# Theme switch

**JTBD:** 1 — Track a branching build depth-first (reading it comfortably, day or night).

**What / why.** Four small buttons at the top right of every page: System (the default),
Light, Dark and Living. Light and Dark use Jira's status colours on calm surfaces (a warm
off-white page under white cards). Living (after Sylva's living world, and mockup B) is the
same page in moss greens: a done task blooms, a task to do is a bud, the task in progress
breathes, and the graph's lines are branches; it follows the computer's light or dark. Its
breathing stops for reduced motion. The page follows the computer's setting until you pick
one. It is CSS only (radio inputs before the page), so the rendered file still has no script;
under `tira serve` the choice is remembered per browser and carries to the confirm page.

**How to read it.** The highlighted button is the current choice. Print is always light.

## Devtool hook

- `[data-theme-switch]` on the four buttons, in the top bar.
- `[data-theme-choice]` on each radio (`system`, `light`, `dark`, `living`); `#th-system` is checked by default; `#th-living` picks Living.

Assertion: picking Light on a dark system (or Dark on a light one) changes the page's colours;
under `tira serve` the choice survives a reload.

**Falsifier.** A forced choice is ignored, or a reload under `tira serve` drops it.
