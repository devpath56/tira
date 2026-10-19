# Engineering decision log

Every engineering or architectural call on tira, one row each. Add new rows at the top of
their section; never edit a decided row. If a call changes, add a new row that says what it
replaces.

| Column | Meaning |
|---|---|
| **Decision** | The question, phrased as a choice |
| **JTBD** | The job it serves, numbered as in `build-plan.md` §4: 1 Track a branching build depth-first · 2 Prove a task is done · 3 Get interrupted and resume exactly · 4 Capture discovered work mid-flight · 5 Change my mind honestly · 6 Kill unnecessary work cleanly · 7 Keep ideas from dying in chat · 8 Approve, don't drive · 9 Know what a finish unlocked · 10 Get told what's next, with reasons · 11 Verify the system isn't lying |
| **Recommendation** | What we do, and its status: **Decided** (with date) or **Open** (waiting on whom) |
| **NSM / CM tradeoff** | The north-star metric it moves, the counter-metric it risks, and whether that holds |
| **What it buys** | The outcome in one line |

## Decided 2026-10-19: replies to the six asks

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| How to clear the quality gate: exclude generated slide decks from the duplication check, or delete an old deck | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Accept the exclusion; delete nothing | NSM: green gate on main. CM: exclusion scope creep. Holds: the exclusion names generated files only, covers duplication only, and its reason is written down | Green gate without losing the demo or its history |
| Whether the write path recomputes every transition key and refuses a wrong one, not just checks its format | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Yes: recompute and refuse | NSM: transitions with verifiable provenance. CM: false refusals on legitimate rows. Traded for never silently mislabeling provenance; 5 test vectors pin the known edge cases | The key becomes a real integrity check, not a naming convention |
| Whether to sign off on the refusal record and override lifecycle tables | 2 — Prove a task is done | **Decided 2026-10-19.** Sign off | NSM: factory transitions emitting end to end. CM: table sprawl. Holds: refusal has no lifecycle, override has exactly one transition, and the 4h cap is enforced in code | Unblocks the merge: the factory side lands |
| Whether her reading of the divergence-report fixture is right, and what format to build it in | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Confirm; build to the locked JSONL format (no real sample exists yet) | NSM: time to a working divergence report. CM: fixture-reality mismatch. Locking the format now makes any future mismatch visible early | She starts the fixture today, not blocked on factory wiring |
| Whether to add a localhost-only server so the page's palette and actions can write to the log | 1 — Track a branching build depth-first | **Decided 2026-10-19.** Approve: localhost-only, every change through the guarded write path | NSM: a checkpoint runnable from the page alone. CM: safety surface. Holds iff the write path stays the single gate | The tracking page becomes operable, not just viewable |
| Whether to open the pull request for the health sweeps | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Go: open the PR | NSM: violations caught before they compound. CM: sweep noise. Holds: sweeps are on demand and read-only; precision is judged in review | The invariant layer gets reviewed in parallel |

## The log and replay

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Store the current state, or rebuild it from history | 11 — Verify the system isn't lying | **Decided 2026-10-16.** Rebuild everything by replaying an append-only log; nothing stores current state | NSM: replay reproduces state byte for byte. CM: replay cost grows with the log. Holds at MVP scale (about 2,800 events fold in ~45 ms); snapshots are the named fix | Every state is provable from its own history |
| Which event store | 11 — Verify the system isn't lying | **Decided 2026-10-16.** SQLite behind a four-call store interface; KurrentDB is the named upgrade | NSM: zero lost or duplicated events. CM: single-machine limits. Holds while there is one worker; a second writer voids the scope | No infrastructure now; a one-module swap later |
| How the rules are written | 2 — Prove a task is done | **Decided 2026-10-16.** JSON transition tables plus a small runner, not a state-machine framework | NSM: every (state, event) pair has an explicit outcome. CM: tables drifting from intent. Holds: mechanical extraction, 176 differential checks and the region scans | The tables are the spec, reviewable as data |
| Whether writing and replay use the same rule check | 11 — Verify the system isn't lying | **Decided 2026-10-17.** One legality function for both | NSM: zero anomalies on logs tira wrote. CM: changing a rule turns older history into anomalies. Accepted: the rules are part of the log's contract (README) | Anything that skipped the rules shows up on replay |
| What happens to a refused command | 2 — Prove a task is done | **Decided 2026-10-17.** Log it as a rejection; never apply it | NSM: every attempt is visible. CM: log noise. Holds: rejections are kept apart and shown in Activity | The denial itself is evidence |
| How retries behave | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Same event id = duplicate no-op; same id with different content = error | NSM: zero double rows from retries. CM: callers must supply stable ids. Holds: factory ids are derived from the transition | Crash-safe writes |
| How output stays byte-stable | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Sort keys by character code, never by locale; `tira dump --hash` | NSM: same log, same hash on any machine (verified 3× independently). CM: a less readable order. Holds: display sorts separately | A one-line proof that two people see the same state |
| How stored events are named | 1 — Track a branching build depth-first | **Decided 2026-10-17.** Lowercase, dash-separated, derived mechanically from table events (`node.born`, `node.start`) | NSM: one naming rule, zero hand-mapped names. CM: a rename breaks old logs. Holds: names are part of the log's contract | Names never drift from the tables |
| How many writers | 11 — Verify the system isn't lying | **Decided 2026-10-17.** One serialized writer per stream (a per-stream queue) | NSM: no lost updates. CM: throughput. Holds for one worker | No conflict semantics needed in the MVP |

## The task tree

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| When a parent counts as finished, and where "next" is | 1 — Track a branching build depth-first | **Decided 2026-10-18.** Finished = every direct child done or cancelled; "next" = the first open task, depth-first | NSM: one derived answer to "what now". CM: a finished parent left open. Covered by the next row | Mechanical, no judgment calls |
| Who closes finished parents | 1 — Track a branching build depth-first | **Decided 2026-10-18.** tira closes them when work moves on, under its own name, citing the move; replay re-checks every tira write | NSM: zero manual parent closes. CM: machine writes nobody asked for. Holds: each one cites a human move, and replay flags any that don't | The tree climbs itself |
| Closing a parent nobody started; the last open branch | 1 — Track a branching build depth-first | **Decided 2026-10-18.** A paired tira start + complete; the last branch of a tree stays open | NSM: every close is a legal transition. CM: two machine rows per close. Holds: the pair is checked as one on replay | No illegal jumps from unstarted to done |
| Whether anyone can write as `tira` or `dispatcher` | 11 — Verify the system isn't lying | **Decided 2026-10-18.** Both names reserved, in any casing and with look-alike letters | NSM: "by tira" always means tira. CM: false refusals on real names. Accepted: the look-alike list is narrow | Provenance labels can't be forged |
| Tree limits and adding work late | 4 — Capture discovered work mid-flight | **Decided 2026-10-16.** Depth 8, 20 children, new tasks at the end, nothing added under finished work without a reasoned re-open | NSM: deterministic traversal. CM: limits too tight. Holds: the limits are config, and refusals are logged | Bounded trees; scope creep is visible |
| Several top-level tasks; who found discovered work | 4 — Capture discovered work mid-flight | **Open: provisional, waiting on Devansh.** Several roots allowed; discovered work must name its finder and is tagged planned or discovered | NSM: every task has provenance. CM: provisional rules hardening by accident. Flagged at the source | Discovered work is traceable |

## The factory

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| How a brief's state is modelled | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Three separate dials (gate, claim, outcome), never one combined state; no rule inside a table reads another dial | NSM: 0 cross-dial guards (region scan). CM: joint meaning scattered. Holds: a declared handoff list plus 10 allowed configurations, which a random walk never leaves | Each table can be audited alone |
| Where cross-dial rules live | 11 — Verify the system isn't lying | **Decided 2026-10-19.** In a declared handoff policy, written by one reserved writer (the dispatcher), with correlation ids | NSM: every handoff traceable to its trigger. CM: the policy becoming a second codebase. Holds iff it stays declarative (checked at sign-off) | Joint meaning is computed in exactly one place |
| Concurrent commands and handoffs | 11 — Verify the system isn't lying | **Decided 2026-10-18.** The dispatcher re-checks "still due" inside the write queue | NSM: each handoff written once. CM: added complexity. Holds: tested with concurrent commands | No duplicate handoffs |
| Claims and drops by unnamed sessions; who renames | 2 — Prove a task is done | **Decided 2026-10-18.** Claiming or filing needs a named session; only the session, the orchestrator or Mac renames it | NSM: no claim that can never be released. CM: an extra naming step. Accepted | Every claim has an owner who can release it |
| A drop filed by someone other than the claimant | 2 — Prove a task is done | **Decided 2026-10-18.** It waits for the orchestrator; it is listed as pending, never auto-rejected | NSM: no silent rejections. CM: a pending pile. Holds: the pending report says why each one waits | Only the orchestrator rejects |
| Dependency loops and what's claimable | 1 — Track a branching build depth-first | **Decided 2026-10-18.** `blocked_by` loops refused at creation; claimable = gated, unclaimed, open, every dependency verified on any version | NSM: nothing waits forever. CM: refusing a legitimate graph. None: only true loops are refused | The claimable list can be trusted |
| Revisions | 2 — Prove a task is done | **Decided 2026-10-17.** Version 2+ supersedes; a superseded version takes no events and no drops | NSM: no work lands on a stale brief. CM: in-flight work stranded. Holds: the revision is explicit and logged | Revisions without rewriting history |
| An idea becoming a task | 8 — Approve, don't drive | **Decided 2026-10-18.** The approval writes `node.born` with the idea's id, under the approved parent | NSM: unbroken idea-to-task chain. CM: id clashes. Holds: a clash is listed as pending | The same id on both sides of the handoff |

## Factory event writing

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Event ids for factory transitions | 11 — Verify the system isn't lying | **Decided 2026-10-19.** `fx:` + sha256 of the transition's canonical JSON | NSM: zero double rows on retry. CM: factory and tira hashing differently. Holds: 5 test vectors, `tira key`, and the recompute check above | Crash-safe emission |
| A refusal's own id | 11 — Verify the system isn't lying | **Decided 2026-10-19.** The refusal is named by the refused transition's key; its own row uses its own key, never that one | NSM: reconciling twice records once, and the refused transition still lands later. CM: two keys to explain. Holds: README walkthrough | Outages leave a record without blocking recovery |
| Who records a refusal | 2 — Prove a task is done | **Open: waiting on Devansh (#5).** The refused transition's own actor; no refusal for a transition with no actor | NSM: every refusal has an owner. CM: one less writer role. Holds: every factory guard names its actor | No anonymous refusals |
| How times are read | 11 — Verify the system isn't lying | **Open: waiting on Devansh (#5).** Strict ISO-8601 with `Z` or an offset, parsed by tira itself | NSM: replay gives the same answer in every time zone (tested in 4). CM: the factory must send zones. Accepted | No time-zone drift in replay |
| Override expiry details | 11 — Verify the system isn't lying | **Open: waiting on Devansh (#5).** Expiry can't predate the start; a repeat expiry only by operators; "late" uses the factory's expiry time | NSM: the log records its own violations. CM: trusting the factory's clock. Holds: an outage records expiries after the fact | Break-glass stays bounded and visible |

## The page

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| What the checkpoint page is made of | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Static, self-contained HTML, no JavaScript; same log, same bytes; every task once, with data attributes | NSM: the hand check (page against `tira dump`) passes. CM: can't act from the page. Addressed by the localhost server above | The page itself is checkable evidence |
| How progress is shown | 1 — Track a branching build depth-first | **Decided 2026-10-18.** A progress train plus board, lanes and activity; words live in drawers; follows the system's light or dark setting | NSM: a stranger names what needs them in ≤5 s (next round). CM: hiding detail. Holds: drawers and Activity keep the full detail | Progress readable at a glance |

## Testing and quality

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| How the plan's tests run | 11 — Verify the system isn't lying | **Decided 2026-10-17.** As JSON event scripts through the real dispatcher. Each also checks: same bytes twice and from shuffled input, no anomalies at any point, nothing broken in the sweep | NSM: every plan scenario executable in CI. CM: scripts drifting from intent. Holds: the runner self-tests every kind of expectation | The plan's tests are the suite |
| Proving the tests aren't hollow | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Planted-bug runner: each planted bug must fail the suite; a bug that doesn't apply cleanly is an error; a 5-minute timeout | NSM: 100% of planted bugs caught. CM: planter and checker are the same person. Addressed by the blind round | Evidence the suite catches real breaks |
| Independent review | 11 — Verify the system isn't lying | **Decided 2026-10-18.** An adversarial review after each piece; every finding fixed with a test and a planted bug | NSM: findings fixed before merge. CM: review time. Accepted: it caught the time-zone replay bug and a 62 s sweep | Catches the builder's blind spots |
| A blind planted-bug round | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Isha plants 10 faults on a branch; Devansh runs the suite; a fault counts as caught only if the suite fails twice | NSM: 10/10 caught. CM: flaky failures counting as catches. Holds: the fail-twice rule | Independent evidence, before Track A sign-off |

## Health sweeps

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| How the sweeps check state | 11 — Verify the system isn't lying | **Open: PR approved, not yet opened.** Re-check the replayed state from raw fields, without the helpers replay uses | NSM: replay bugs caught. CM: some logic duplicated. Accepted | A bug can't agree with itself |
| What fails a sweep | 11 — Verify the system isn't lying | **Open: in the sweeps PR.** "Broken" exits 3; "to look at" never fails it | NSM: 0 broken on logs written through the rules. CM: noise from things to look at. Holds after the next row | Real failures stand apart from things worth a glance |
| What "finished work that grew" means | 5 — Change my mind honestly | **Open: in the sweeps PR.** Done, re-opened, then extended; adding to an open parent is ordinary planning | NSM: scope creep visible. CM: false flags. Fixed: from 90% of new tasks to 0 on a 2,800-event log | The flag means something |
| What makes a task hollow | 7 — Keep ideas from dying in chat | **Open: in the sweeps PR.** No `definition` or `done_criteria` at birth; a task born from an idea reads them from the idea | NSM: hollow tasks listed. CM: the whole current seed tree is hollow. Accepted until scenarios set the fields | "What is it, and when is it done" becomes checkable |
| Sweep cost | 11 — Verify the system isn't lying | **Decided 2026-10-19.** One replay with a read-only hook; walks visit each task once | NSM: a sweep in under 100 ms at MVP scale (45 ms). CM: a new hook in replay. Holds: read-only, with a planted bug | On-demand sweeps stay instant |

## Code quality and working agreement

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Paths given to the region-scan script | 11 — Verify the system isn't lying | **Open: in #6.** Only paths inside the folder it runs from, checked the way SonarCloud's rule describes | NSM: security rating A on main. CM: refusing a legitimate outside path. Accepted: the scan runs from the repo root | Safe to call from an agent |
| How work reaches main | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Stacked PRs with merge commits; Devansh merges; push only on Isha's OK; every diff scanned for personal data first (public repo) | NSM: zero unreviewed merges. CM: slower merges. Accepted | Every change on main was reviewed |
