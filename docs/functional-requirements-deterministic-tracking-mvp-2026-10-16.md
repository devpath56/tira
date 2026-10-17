# Functional Requirements — Deterministic Task-Tree Tracking MVP

- **Date:** 2026-10-16
- **Status:** Draft, companion to the exec brief and factory proposal
- **Exec brief:** `your_files/exec-brief-deterministic-tracking-mvp-2026-10-16.md` (scope table + 126 tagged trust queries)
- **Proposal:** `your_files/proposal-deterministic-tracking-mvp-20261016.md` (Promise / NSM / counter-metric / falsifiers — parked at Propose stage)

Plain-language statement of what the MVP does and deliberately doesn't do. If a requirement isn't on this page, it's out of scope.

## IN SCOPE — what the system does

**Recording everything**
- Every change is written as an event in a log that only ever grows — nothing gets edited or deleted. Each event gets the next sequence number, so a gap in numbering is itself a red flag.
- Every event says who did it, when, and what changed. A "done" event must point at proof, or it's rejected on the spot.

**The task tree**
- There are no saved "current" fields to go stale. The tree — parents, children, order, depth, states — is rebuilt by replaying the log whenever you ask.
- Each task has one parent (except the dashboard itself), one state: not started, in progress, blocked, done, or cancelled.

**Finishing work**
- Marking something done requires naming what "done" meant and pointing at the evidence. No evidence, no done.
- The moment something completes, the system tells you four things: was that finish legitimate, what just got unblocked, where you backtrack to next, and a quick integrity check on that branch.

**What's next**
- Every suggestion explains itself: what triggered it, the rule it used to pick, what else it considered and why those lost, and what waits while you do it.
- Same events always produce the same suggestion — it's machinery, not vibes. And it never acts on its own; it only suggests.

**Adding work mid-flight**
- New tasks discovered while working get tacked onto the end of the child list, tagged with who found them, during which task, and whether they were planned or discovered.
- Trying to add work under a finished branch is denied — you have to explicitly re-open it, with a reason, and that re-opening is itself logged.

**Vapor control**
- Anything important said in chat but not yet filed goes on a visible list with its age. Old unfiled items get flagged.
- The system can list "hollow" tasks — nodes that exist in the tree but have no written definition or finish criteria.

**Safety checks**
- On demand, it sweeps for corruption: orphaned tasks, loops, a "done" parent with unfinished children, counts that don't add up, depths that drifted.

## OUT OF SCOPE — what it deliberately doesn't do

**Other people**
- It's built for one worker. No double-booking detection, no merging two people's completions, no resolving conflicting suggestions. If a second worker ever shows up, the scope is void and gets renegotiated.

**Fancy security**
- No cryptographic proof the log wasn't tampered with. Sequence numbers catch gaps; a truly malicious operator rewriting history is out of scope for now.

**Smart automation**
- No forecasting when things finish, no "here's your morning digest," no push notifications, no detecting stalled or starving branches, no auto-healing anything broken. It flags problems; it doesn't fix them.
- It logs its suggestions but doesn't score them — so "the system keeps giving bad advice" isn't measurable yet, and that's stated openly, not hidden.

**Deep forensics**
- No diffing chat transcripts against files to catch distortion, no investigating what died in past compactions, no tracking which files went stale while chat moved on. The vapor list is the control; the forensics wait.

## One-line version

It reliably records what happened, derives the tree from that record, verifies every finish, and tells you what's next with its reasoning attached — for one person, on the dashboard, with everything else explicitly parked.
