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
Each save is a new version of the whole ticket, written as you. **Comments** follow, oldest first, each with who wrote it (an agent's
marked), when, and its seq; under `tira serve`, one to add. They're feedback for whoever works
on the task: its agent reads them through tira's MCP server, and can reply. Under `tira serve` the dialog offers what the task's
state allows: start, complete, block, unblock, cancel, reopen (and, under its subtasks, add
one); each opens its decision dialog. It also offers **Show on graph**: the dialog closes, the board turns to the
Graph, and the canvas moves to the task (an idea's dialog does the same for its ghost).

**How to read it** (laid out 2026-10-24, Isha). At the top, where it sits: the project (back to
the board) and the tickets above it, each one click away; for a subtask, "2 of 3" with the sister
subtask before and after. Then two columns. **The work**: the title (the id under it); the
description and steps; its **subtasks**, each a row with its state, name (and id), estimate and
who it's assigned to (an agent's spark, a person's initials), one click to its own dialog, under
"closed/all" and its meter, with **+ Add subtask** beside them while it can take one; then its
activity. **Beside**, its properties: status on one line (with marks: next, all subtasks
closed, closed by tira; "active" isn't one, since in progress says it: Isha, 2026-10-26) and what it
allows (a task whose subtasks are still open offers neither Complete nor Cancel, which they'd
refuse, and says how many are open); assignee; estimate (its subtasks' added up under it, a day as
8 hours, to the half hour); parent, with its progress (a top-level task has no Parent row); **Found in** (the task it was
found while working on, one click away); **Work type** (Isha, 2026-10-26: code, spec, design,
research, data, testing, ops, decision, docs or other; its ticket's, or tira's guess from its words,
said so, code when nothing points elsewhere; live, a pick that keeps guessing until changed);
**Review** (a switch a person turns on: Muse checks the work before it's done; with no Meta Model API
key set, it says it needs one); the blocks link both ways
("Blocked by design_tokens" on the blocked task, "Blocks colors" on its ticket); its Jira issue and
pull requests; its proof of work; Show on graph. On a phone the properties come first. Few words:
labels and placeholders, no sentences explaining what's empty.

**In sections** (Isha, 2026-10-26: "everything feels melted together"). The ticket's key and id
sit over its title; the title wraps to show whole. Then each part under its own small label:
**Description** (at a reading width, as it's meant: paragraphs, lists, **bold**, `code`, links),
**Steps** (only when a script or an agent wrote some: numbered, read only), **Subtasks**, and **Activity**:
the comments and the history as two tabs over one place, Comments first (as Jira's). The comments
read as a thread: each writer's round mark (an agent's spark, a person's initials) on a line that
joins them, then who, when and what (as the description reads, with any files: a picture as itself,
a PDF or a document as a chip with its name and size, each opening in a new tab; Muse's reviews among them, under muse-review-bot: passed, or
the changes it asked for, each a fix subtask, with the tokens it used); and, above them, each agent tira started on the task when
someone @mentioned it, with **Watch its session** one click away); under them, the box to reply, with your mark beside it, its
**Comment** button inside it, how to mention and send, and **Attach** (a paperclip): pictures, PDFs,
text and office documents, 5 MB each, five to a comment, also dropped on the box or a picture pasted
into it; each goes up as it's added and shows as a chip until the comment is sent.

Under `tira serve` the ticket is edited where it shows (no Edit fold; Isha, 2026-10-26: "not
neat", "not modern"): the title is the heading, lit up under the pointer, edited in place: one line,
Enter or leaving it saves. The description reads as it's meant until you click it (or press Enter
on it); then it's an editor with buttons for bold, italic, code, a bulleted or numbered list and a
link, and its own **Save** and **Cancel** (Cmd/Ctrl+Enter saves, Esc cancels). The fields beside it,
work type, review, assignee and effort, save as soon as they're picked. Every save is the whole
ticket, so steps it has stay. With no script, the description is a plain field and one Save saves.
tira's entries say why and which move they cite. An entry written before the rules version
marker carries a "legacy" tag: it was judged, and is replayed, under the legacy era's rules
(versioned rules, 2026-10-20). Close it with ×, a click on the dimmed page around it, or Esc
under `tira serve` (which also moves focus into the dialog, and back to the task on close).

## Devtool hook

- `.drawer` sections with ids `#t0`, `#t1`, … in tree order, `role="dialog"`; the palette's index uses the same ids.
- `.modal-box` on the centred box, `.scrim` on the dimmed page behind it (a link that closes the dialog).
- `.tk-crumbs` on where it sits, `[data-siblings]` on a subtask's place among its sisters; `.tk-side` on the properties, `[data-parent]` on the parent there.
- `[data-subtasks]` on the subtasks, `.kids-list` on their rows, `[data-subtask]` on each row (its key); `[data-proof]` on a done task's proof of work; `[data-links]` on the blocks link.
- `[data-ticket-key]` under the ticket's title: its `TIRA_<PROJECT>_<n>` (and its id, when a title shows instead).
- `[data-ticket]` on the ticket, with `[data-ticket-description]`, `[data-ticket-steps]`, `[data-ticket-estimate]` and `[data-ticket-assignee]`; `[data-ticket-form]` on the ticket's form (live only).
- `[data-comments]` on the comments, `[data-comment]` on each, `[data-comment-form]` on the one to add (live only); `[data-history-pane]` on the history, the other tab; `[data-tab]` on each tab's radio (`c`, `h`).
- `[data-ticket-kind]` on Work type and `[data-ticket-review]` on Review, beside; `[data-save-on-change]` on each field there that saves itself, `[data-save-on-leave]` on the title.
- `[data-desc]` on the description, `[data-desc-view]` on it as it reads, `[data-desc-tool]` on each mark button (its kind), `[data-desc-cancel]` on Cancel (live only).
- `[data-comment-file]` on Attach (its upload address), `[data-comment-adds]` on the files being added (live only); a comment's own files sit under its words.
- `[data-ticket-links]` under a description being edited: its web addresses, as links (live only). `[data-found-in]` on Found in, beside.
- `[data-dialog-acts]` on the actions and `[data-show-on-graph]` (the task's key) on Show on graph (live page only); `[data-subtasks-open]` on the line saying how many subtasks close first.
- `.legacy` on the tag of each entry with no rules era (Activity counts them too).

Assertion: every node is one click from its event trail.

**Falsifier.** A task's history leaves out an event the log has for it.
