# Hash chip

**JTBD:** 11 — Verify the system isn't lying.

**What / why.** "fingerprint · seq N · abcd…wxyz": the sha256 of the replayed log, so two people
can check they see the same state. It is for an audit, not a daily read, so it sits at the top
of the History dialog (with the divergence check), opened from **History** under the project's
name, not on the board. It says what it is ("fingerprint"), and its tooltip gives the full value
and how to check it. Help no longer explains it (Isha, 2026-10-26): Help is for doing the work,
and the fingerprint is for checking it.

**How to read it.** Run `tira dump --hash` on the same log: the same value means the page shows
exactly what the log says. The full value is in the chip's tooltip and on the page.

## Devtool hook

- `.verify` on the chip (its full value in its tooltip), in the History dialog's `.log-top`; `[data-open-log]` on the History button that opens `#history` (`[data-log]`).
- `[data-dump-hash]` on the page: the full hash.

Assertion: the page's full hash equals `tira dump --hash` for the same log.

**Falsifier.** The chip's hash differs from `tira dump --hash` on the same log.
