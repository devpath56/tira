# Decision dialog (the ticket, and your part)

**JTBD:** 2 — Prove a task is done (and 5 — Change my mind honestly).

**What / why.** Every human input from the live page goes through this first, so nothing
fires by surprise. Redesigned 2026-10-24 (Isha): it's about the work, not a command line. Two
views side by side (stacked on a phone):

1. **The ticket** (read-only): what the work is, from its ticket (`node-drawer.md`): its
   title, description, steps, time estimate and assignee. Above it, only when it matters, one
   line: what to do instead when tira would refuse (the rule's own words when it has no plainer
   ones), that nothing would change, or the finished parents it closes too.
2. **Your part**: what the move needs, as plain fields, and a **comment** (optional) that goes
   on the ticket, where its agent reads it. No command: the page writes the move from these
   fields (the same move `tira send` writes in a terminal).
   - **Complete**: the proof of work is a commit or a pull request of the project's repo. It
     opens at once on the commits tira has ("Checking GitHub…" while it looks: the task's own
     commits, about two seconds, no Jira, no whole sync; and the repo's latest commits and pull
     requests), the task's newest picked, in groups (This ticket, Recent commits, Pull requests);
     **Or paste** takes any other (a commit id, #12 or a link). What you pick is checked on GitHub
     and kept for the task. **Refresh** looks again.
   - **Block**: "Blocked by", a new ticket by name or an open task (live, the open tasks are
     chips), and a reason (optional: it waits on that ticket, if left empty).
   - **Add subtask**: its name; under work already under way it's marked as found, and
     elsewhere a chip marks it.
   - **Reopen**, a reject: a reason (reasons used before are chips).

**An idea's two approvals use it too** (`ideas.md`), with tira's own account on the left (the
idea's summary, why, who declared it, where tira proposes it go): Approve placement opens with
tira's parent in "Goes under", to change, or empty with the candidates as chips when tira
couldn't settle one, and the parent is checked before anything is written.

**Blocking makes the wait a ticket.** A new name in "Blocked by" makes the ticket first, a
subtask of the blocked task found while working on it, then the block on it, in order (if the
ticket isn't written, neither is the block). The two are linked everywhere (the dialogs, needs
attention, Kanban, the Graph), and the blocked task can't be completed until its ticket is
closed. A blocker must be an open task, not the task itself or one it sits under.

The move's button (**Complete**, **Block**, …) sends it; "Not now" (or Esc, or a click
outside) closes it. It opens as a dialog over the page: the page's script fetches the packet
alone (`?fragment=1`) and posts from the dialog, so anything that stops the write comes back
into the dialog with what you wrote kept. A direct link still gets the full confirm page (no
script: the chips are listed as text). A refused move has nothing to fill in: **Check again**.

**What stops a write**, nothing written: a value it needs left empty; a proof that isn't one
of the task's commits; a blocker that can't be; something tira would refuse (said, and why);
or the log moving after you opened it (the decision is shown again, as it is now).

## Devtool hook

- `[data-packet]` on the packet (in the dialog and on the page), with `[data-ok]` true or false.
- `[data-brief]` on the left view (the ticket, or tira's account of an idea), `[data-ticket]` on the ticket in it; `[data-you]` on the form, `[data-you-part]` on your part.
- `.confirm-dialog` on the live page's dialog; `[data-close-confirm]` on its way out.
- `[data-hint]` on what to do, when tira would refuse; `[data-error]` on why nothing was written; `[data-fills]` on the chips.
- `[data-field]` on each field (its name), `[data-blocked-by]` on Block's "Blocked by" (the task's id), `[data-comment-field]` on the comment.
- `[data-proof]` on Complete's commits, `[data-no-commits]` when there are none yet; `[data-commits-status]` on what the look on GitHub is doing or found (`[data-commits-fetch]`, its address, while it's to run), `[data-commits-again]` on Look on GitHub again.
- `[data-flash]` on the result shown after an action.

Assertion: the verdict is the write path's own decision (`WritePath.preview`: reserved
names, tira's closes, then the rules), and the form carries the seq it was decided on
(`seen`): if the log moved before you send, nothing is written and the decision is shown again.

**Falsifier.** An action is written without passing through this dialog, a task is completed
from the page with anything but one of its commits, or the left view states something the log
doesn't.
