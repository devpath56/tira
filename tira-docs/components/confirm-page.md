# Decision dialog (two views)

**JTBD:** 2 — Prove a task is done (and 5 — Change my mind honestly).

**What / why.** Every human input from the live page goes through this first, so nothing
fires by surprise, and every one has two views side by side (stacked on a phone):

1. **tira recommends** (read-only): the work in a nutshell, only what you need to know to
   decide. Every sentence comes from the log or the rules, nothing is guessed:
   - **Decision**: the task, where it sits, why and since when it is blocked, its subtasks, its proof, the move, and what tira will close first.
   - **Recommendation**: from the facts, e.g. "api is done now, so the wait looks over", "next in order is fetch_metrics", "it's the last open subtask of improve_visual", or "Don't run it: tira will refuse".
   - **Tradeoffs**, **Best practice**, **Kind** (routine, needs proof, needs a reason, final, an undo, a change of scope; refused) and the rule it must pass.
   - tira's check, and **what to do** when it would refuse.
2. **Your action — edit before sending**: the action as a tira command, filled in. It is
   complete when nothing is needed ("tira send node colors UNBLOCK"); empty quotes mark a
   value to fill in (`evidenceRef=""`, `reason=""`, a subtask's name). Any command can take
   `note="…"`, which the history keeps. The same text runs in a terminal. Live, reasons used
   before (and "waiting on" each other open task, not one it sits under) are chips that fill
   the reason in; a subtask under work already under way is pre-marked as found
   (`kind=discovered`), and elsewhere a chip adds it.

**An idea's two approvals use it too** (`ideas.md`): the Decision is the idea's summary, why,
who declared it and where tira proposes it go; Approve placement opens with tira's parent
filled in (`tira send idea pagination APPROVE_NODE parent_id="table"`, editable), or empty
with the candidates as buttons when tira couldn't settle one, and the parent is checked
before anything is written. A stage skip typed in (approving the placement while the file is
pending) is refused in plain words: "the file isn't approved yet, and the placement comes
after the file", with what to do instead.

**Blocking makes the wait a ticket.** Block asks "Blocked by": type a name and the command
becomes two lines, run in order (each checked by tira first; if the ticket isn't written,
neither is the block):

```
tira create node design_tokens --parent colors kind=discovered discovered_during=colors
tira send node colors BLOCK blocker="design_tokens" reason="waiting on design_tokens"
```

The ticket is a subtask of the blocked task, found while working on it, and the block names
it, so the two are linked everywhere (the dialogs, needs attention, Kanban, the Graph) and
colors can't be completed until its ticket is closed. Or pick an open task as the blocker: one
line, nothing created. A blocker must be an open task, not the task itself or one it sits
under. Without a reason written, the block waits on its ticket ("waiting on design_tokens").

"*Verb* — run it" sends the command; "Not now" (or Esc, or a click outside) closes it. It opens
as a dialog over the page, never a new page: the page's script fetches the packet alone
(`?fragment=1`) and posts from the dialog, so anything that stops the write comes back into
the dialog with your text kept. A direct link still gets the full confirm page (no script:
the reasons are listed as text).

**How the command is read.** Strictly, and never guessed at:

| You send | tira does |
|---|---|
| A command as offered, values filled in | Runs it, exactly as typed |
| A value left empty or only spaces | "Add the proof of work…" / "Add the reason…"; nothing written |
| Another task or verb than the one you opened | Shows what tira says about that one first; nothing written until you run it |
| A key the verb doesn't take, a flag (`--actor`), a verb the page doesn't send, a non-task type, an unclosed quote | Says why it can't run it; nothing written |
| Something tira would refuse | Says it would still refuse, and why; nothing written (a refused decision stays editable: **Check again**) |
| Anything, after the log moved | Shows the decision again, as it is now; nothing written |

## Devtool hook

- `[data-packet]` on the packet (in the dialog and on the page), with `[data-ok]` true or false.
- `[data-brief]` on the left view (tira recommends); `[data-you]` on the form; `[data-command]` on the command.
- `.confirm-dialog` on the live page's dialog; `[data-close-confirm]` on its way out.
- `[data-hint]` on what to do, when tira would refuse; `[data-error]` on why nothing was written; `[data-fills]` on the chips.
- `[data-blocked-by]` on a block's "Blocked by" field (the task's id).
- `[data-flash]` on the result shown after an action.

Assertion: the verdict is the write path's own decision (`WritePath.preview`: reserved
names, tira's closes, then the rules), and the form carries the seq it was decided on
(`seen`): if the log moved before you send, nothing is written and the decision is shown again.

**Falsifier.** An action is written without passing through this dialog, a command runs as
something other than what it says, or the left view states something the log doesn't.
