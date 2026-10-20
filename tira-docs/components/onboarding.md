# How to read this page (onboarding)

**JTBD:** 1 — Track a branching build depth-first (first-run).

**What / why.** Exposition one time and on demand, never on the worksurface (no pop-up). Under
`tira serve` the guide opens by itself on the first visit (once per browser); after that, and
always on the rendered page, a quiet "How to read this page" link next to the hash chip opens
it inline, and the chip opens it too.

**How to read it.** Three short paragraphs: the train, "by tira", and the hash.

## Devtool hook

- `[data-guide]` on the guide, with id `#guide`.
- `.how` on the link that opens it.

Assertion: exactly three paragraphs, on the train, by tira and the hash.

**Falsifier.** A first-time reader can't say what the train, the leaf and the hash mean after
reading it.
