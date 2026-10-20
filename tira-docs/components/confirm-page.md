# Confirm page (the decision packet)

**JTBD:** 2 — Prove a task is done (and 5 — Change my mind honestly).

**What / why.** Every action from the live page goes through this page first, so nothing fires
by surprise. Two parts, visibly separate: what tira says (read-only), and what you decide
(the fields you fill in, and the button).

**How to read it.** "What tira says": the move (in progress → done), the rule it must pass, the
record it will leave (who, which seq), what tira will do next (a parent it will close), and its
check: allowed, or "tira would refuse this" with the reason. "What you decide": the evidence or
the reason, then the button. After it, the page shows what happened, a refusal included.

## Devtool hook

- `[data-packet]` on the page, with `[data-ok]` true or false.
- `[data-tira-says]` on the read-only part; `[data-you]` on the form.
- `[data-flash]` on the result shown after an action.

Assertion: the verdict is the write path's own decision (`WritePath.preview`: reserved
names, tira's closes, then the rules), and the form carries the seq it was decided on
(`seen`): if the log moved before you submit, nothing is written and the packet is shown again.

**Falsifier.** An action is written without passing through this page, or the page says
"allowed" and the write is refused (for a reason other than a field you left empty).
