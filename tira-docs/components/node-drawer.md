# Task dialog

**JTBD:** 11 — Verify the system isn't lying.

**What / why.** Click any task (a Kanban card, a node on the graph, a
Needs Attention row, a ⌘K result) for its ticket, its state, its marks, its comments and its
full history, rejected commands included. It opens as a dialog over the page, never a side panel or a new page: the
page stays where it was underneath. Words live here, not on the canvas. A parent lists its
subtasks, each with its state and a click to its own dialog. A done task shows its **proof of
work** (the evidence on its completion: one of its commits shows as its short id, one click to
it on GitHub, and its message).

**The ticket** (2026-10-24, Isha) is what the work is: its **title** (the task's id stays its
key, under it), **description**, **steps**, **time estimate** ("2h", "1d") and **assignee**: a
person on the project, or one of its connected agents (Project settings → Connect agents).
Under `tira serve`, **Edit ticket** opens its form; each save is a new version of the whole
ticket, written as you. **Comments** follow, oldest first, each with who wrote it (an agent's
marked), when, and its seq; under `tira serve`, one to add. They're feedback for whoever works
on the task: its agent reads them through tira's MCP server, and can reply. Under `tira serve` the dialog offers what the task's
state allows: start, complete, block, unblock, cancel, reopen, add subtask; each opens its
decision dialog. It also offers **Show on graph**: the dialog closes, the board turns to the
Graph, and the canvas moves to the task (an idea's dialog does the same for its ghost).

**How to read it.** The path above the name, the state badge, marks (next, active, all
subtasks closed, closed by tira, found during X), the blocks link both ways ("Blocked by design_tokens" on the
blocked task, "Blocks colors" on its ticket, each one click away, with its state), then "N of
M children closed" and the history, oldest first.
tira's entries say why and which move they cite. An entry written before the rules version
marker carries a "legacy" tag: it was judged, and is replayed, under the legacy era's rules
(versioned rules, 2026-10-20). Close it with ×, a click on the dimmed page around it, or Esc
under `tira serve` (which also moves focus into the dialog, and back to the task on close).

## Devtool hook

- `.drawer` sections with ids `#t0`, `#t1`, … in tree order, `role="dialog"`; the palette's index uses the same ids.
- `.modal-box` on the centred box, `.scrim` on the dimmed page behind it (a link that closes the dialog).
- `.kids-list` on a parent's subtasks; `[data-proof]` on a done task's proof of work; `[data-links]` on the blocks link.
- `[data-ticket]` on the ticket, with `[data-ticket-description]`, `[data-ticket-steps]`, `[data-ticket-estimate]` and `[data-ticket-assignee]`; `[data-ticket-edit]` on Edit ticket (live only).
- `[data-comments]` on the comments, `[data-comment]` on each, `[data-comment-form]` on the one to add (live only).
- `[data-dialog-acts]` on the actions and `[data-show-on-graph]` (the task's key) on Show on graph (live page only).
- `.legacy` on the tag of each entry with no rules era (Activity counts them too).

Assertion: every node is one click from its event trail.

**Falsifier.** A task's history leaves out an event the log has for it.
