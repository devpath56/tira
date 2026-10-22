# How to read this page (onboarding)

**JTBD:** 1 — Track a branching build depth-first (first-run).

**What / why.** Exposition one time and on demand, never on the worksurface (no pop-up). Under
`tira serve` the guide opens by itself on the first visit (once per browser); after that, and
always on the rendered page, **Help** (a ? at the foot of the sidebar, titled "How to read this
page") opens it as a dialog over the page, and History's fingerprint chip opens it too.

**How to read it.** Three short paragraphs: the board (Kanban and Graph), "by tira", and the fingerprint.

## Devtool hook

- `[data-guide]` on the guide, with id `#guide`.
- `.how` on the link that opens it.

Assertion: exactly three paragraphs, on the board, by tira and the hash.

**Falsifier.** A first-time reader can't say what the board's two styles, the bolt and the hash mean after
reading it.
