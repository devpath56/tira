# Needs attention

**JTBD:** 3 — Get interrupted and resume exactly (and 1 — Track a branching build depth-first).

**What / why.** The first thing on the page: what is blocked, grouped by the reason it was
blocked with, and what is being worked on. It is bounded by attention, not by tree size, so
it grows with work in progress, not with the number of tasks. Blocking a task needs a reason
with text (2026-10-20), so a new blocked row always says why; a legacy log's bare block shows
"no reason given". A finished active parent isn't listed: there is no decision in it, and tira
closes it when work moves on (ruling 2026-10-20); it stays in the tree. Stale work joins once
its time limit is ruled.

**For you** (Isha, 2026-10-26: "tell me when I'm supposed to chime in"). Under `tira serve`, first,
what is yours to answer: an @mention of you in a task's comments that you haven't replied to since
("claude-code asked you: …", in its words, the leading @you left off; **Reply** opens its dialog),
a task assigned to you that no one has started (**Start**), and an idea waiting for a person to
approve its file or its place (**Review**). An agent that needs a person @mentions them (its
comment tool says so), so the question waits here until they reply. The rendered file knows no
one, so it has no For you.

**How to read it.** "N need you" (a click on that line folds the whole section to it, and back;
under `tira serve` it stays as you left it, per browser), then For you, then one group per reason ("Blocked · waiting on the
design-token decision"), then "In progress". When more than 3 tasks need you, each blocked
group folds to one line (its reason, the tasks' names, how many), so the board stays near the
top of the page; a click opens it. The task being worked on never folds, and a group holding
the task the last action changed opens by itself. Under `tira serve` the groups you open stay
open across the reload after every action. Each row: the task (click for its dialog), where
it sits in the tree, what it waits on when the block named a ticket ("waiting on
design_tokens", one click to it, with its state; "ready to unblock" once that ticket is
closed), and since when ("blocked at seq 12"). Under `tira serve`, each row also has its next
action. A task in progress whose subtasks are still open can't be completed yet (they close
first), so its row offers no Complete: it says "2 of 8 subtasks open · next: …" (one click to the
next) and offers **Start next**, beside Block. Nothing needs you: "Nothing needs you", and the next task.

## Devtool hook

- `[data-attention-count]` on the section: the number of rows; `.att-fold` (`details[data-remember]`) folds it.
- `[data-attention-key]` on each row: the task's key. Rows don't reuse the train's per-task marker, so the M1 node count is untouched.
- `[data-reason]` on each blocked group: the reason, as given; folded, the group's line carries the tasks' `.names`.
- `[data-blocked-by]` on a row's blocker ticket; `[data-ready]` once that ticket is closed.
- `[data-group]` on each group (`for-you`, `blocked`, `in_progress`); `[data-for-you]` on each row of For you: why it's yours (`mentioned`, `assigned`, `idea`).

Assertion: the count = blocked tasks + active tasks in the fold, less active parents waiting for tira's close.

**Falsifier.** A stranger can't name what needs them within 5 seconds of opening the page.
