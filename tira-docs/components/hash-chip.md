# Hash chip

**JTBD:** 11 — Verify the system isn't lying.

**What / why.** "fingerprint · seq N · abcd…wxyz": the sha256 of the replayed log, so two people
can check they see the same state. It says what it is, and opens the guide, instead of hiding
the meaning in a tooltip. It sits quietly at the foot of the page, out of the top bar: you look
for it when you need it.

**How to read it.** Run `tira dump --hash` on the same log: the same value means the page shows
exactly what the log says. The full value is in the guide and on the page.

## Devtool hook

- `.verify` on the chip, linking to `#guide`.
- `[data-dump-hash]` on the page: the full hash.

Assertion: the page's full hash equals `tira dump --hash` for the same log.

**Falsifier.** The chip's hash differs from `tira dump --hash` on the same log.
