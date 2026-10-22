# Ideas (the Ideas column, ghost cards, the idea dialog)

**JTBD:** 7 — Keep ideas from dying in chat (and 8 — Approve, don't drive).

**What / why.** An idea an agent pushed (`tira idea`) is on the board before it is a task, so
it can't be lost and can't be mistaken for work. tira drafts its file and proposes where it
goes; a person only approves, twice: the file, then the placement. It is never drawn as a
task: a plain card or box with an IDEA tag (the tag is the whole difference), outside the counts.

**How to read it.** Kanban: the **Ideas** column comes first while any idea is open, one
card per idea, tagged IDEA, with its summary, its stage ("file to approve", "placement to
approve", or "needs a parent" in amber when tira couldn't settle one) and, once proposed,
"under table". Graph: a **ghost** box, tagged IDEA, joined by a dashed grey line under
the task tira proposed; until tira proposes (the file isn't approved yet), or while a person
must pick the parent, it sits on the top row. A dropped idea, or one that became a task,
leaves the board; its history stays in History. Click a card or a ghost for the idea's
dialog: its summary, why, where it goes and why (tira's proposal and its basis, or the
candidates), what happens next, and its history. Under `tira serve` the dialog offers its
stage's approvals, each through the decision dialog (`confirm-page.md`): **Approve file** /
**Reject file**, then **Approve placement** (tira's parent filled in as
`parent_id="table"`, editable; the candidates as buttons when it couldn't settle) /
**Reject placement**. A reject needs a reason. A stage skip, typed into the command (say,
approving the placement while the file is pending), is refused in the dialog in plain words,
with what to do instead, and nothing is written.

## Devtool hook

- `.col` "Ideas" in `.bv-kanban`; each idea's card is `.card.idea` with `[data-idea-card]` (the idea's key) and `[data-stage]`.
- `.ghost` on the Graph, with `[data-idea]` (the idea's key, never `[data-key]`: the M1 count is the tree's alone), `[data-stage]`, and `[data-parent]` once tira proposed a parent; `.loose` when a person must pick one. Its line is `.edges path.idea` with `[data-from]` and `[data-to]`.
- `.tag` marks a card or a ghost as an idea.
- `[data-idea-dialog]` on the idea's dialog (`#i0`, `#i1`, …); `.idea-file` holds Why, Goes under and Next.
- `[data-fill]` buttons in the placement's decision fill in `parent_id`.

Assertion: an open idea shows once in the Ideas column and once as a ghost, under its proposed
parent when it has one; a dropped or born idea shows in neither (`test/ideas.test.ts`).

**Falsifier.** An idea is drawn or counted as a task, a ghost sits under a task tira didn't
propose, or a stage skip is written to the log from the page.
