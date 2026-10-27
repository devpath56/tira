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
   - **Complete**: the proof of work is a commit or a pull request of the project's repo, typed or
     pasted in one field (a commit's id or link, #12 or a pull request's link). No list of ids to
     pick from. As you type (at once on a paste), tira checks it on GitHub and says what it found
     ("Found: …") or why it can't be one; nothing is written until Complete, which checks it again
     and keeps it for the task. Work of any other type (on the ticket: a spec, a design, research and
     the rest; Isha, 2026-10-26: "only for code a PR is a must, otherwise any link or screenshot") is
     proven by a link to it, or a file: **Attach a file** puts it in (a screenshot, a PDF) and the field
     names it; no GitHub check. When tira has a reviewer (Muse, src/serve/review.ts) and a person
     marked the task for review (its Review switch), Complete asks it first: passed, the task is done ("Muse
     reviewed it: passed"); problems, each a fix subtask under the task and the task left open; it
     couldn't run, nothing is written and it says why. **Complete it without Muse's review: your
     call** lets the person completing it decide, said on the task. After three reviews that asked
     for changes, only a person can complete it.
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
- `[data-proof-check]` on Complete's proof field (its value, the address that checks it on GitHub as it's typed), `[data-proof-said]` on what the check found or why not. (Work that isn't code: its Attach a file carries its upload address, and Complete without review shows when Muse would review it.)
- `[data-flash]` on the result shown after an action.

Assertion: the verdict is the write path's own decision (`WritePath.preview`: reserved
names, tira's closes, then the rules), and the form carries the seq it was decided on
(`seen`): if the log moved before you send, nothing is written and the decision is shown again.

**Falsifier.** An action is written without passing through this dialog, a task is completed
from the page with anything but one of its commits, or the left view states something the log
doesn't.
