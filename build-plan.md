# MVP Build Plan — Deterministic Task-Tree Tracking

- **Date:** 2026-10-16
- **Status:** Plan only. No build authorization — building needs an explicit go-word.
- **Companions:** proposal (`proposal-deterministic-tracking-mvp-20261016.md`), functional requirements (`functional-requirements-deterministic-tracking-mvp-2026-10-16.md`), exec brief (126 trust queries), state chart (`tracking-mvp/charts/node-lifecycle.mjs`), demo (`tracking-mvp/demo/`)

## 0. What's already built (do not rebuild)

| Artifact | Location | Verified |
|---|---|---|
| Node lifecycle state machine (XState) | `tracking-mvp/charts/node-lifecycle.mjs` | Constructed + executed: 35 state×event pairs, all 5 states reachable, guards fire, no vacuous done |
| Claim pipeline state machine (XState) | `tracking-mvp/charts/claim-lifecycle.mjs` | Constructed + executed: 36 pairs, 50/50 checks — no-skip (no path to materialized bypasses filed), approval gates, bare-reject guard |
| State matrix + 3 delegated rulings | chat 2026-10-16 (idempotent no-ops; done→cancelled forbidden; add-child-to-done denied) | Rulings recorded in chart comments; reversible |
| 8 demo scenarios as D2 animations + HTML deck | `tracking-mvp/demo/` | Every board rendered + screenshot-verified against real D2 v0.9.0 |

The chart module is the transition function the fold engine will import directly — **test the machine, ship the machine.** The demo scenarios double as the acceptance test scripts (§5).

## 1. Architecture (4 components + UI)

```
event store — SQLite, append-only (interface: packing.md §3)
    │  write-time gates: schema, sequencing, evidence-on-COMPLETE,
    │  reason-on-REOPEN, add-child-to-done deny
    ▼
fold engine ──imports──▶ transition tables (charts/ are the verified source;
                           JSON + tiny runner is the preferred form)
    │  derives: tree, states, drain, DFS cursor; time-travel to event N
    ▼
completion contract + suggester (deterministic; receipts; advisory-only)
    │  vapor queue (declare → age → materialize)
    ▼
invariant sweeps (on-demand)
```

- **Language:** Node.js.
- **Storage:** SQLite, append-only events table, behind the narrow storage interface
  specified in `packing.md` §3 (`append` / `readStream` / `readAll` / `subscribe`).
  KurrentDB is the named upgrade path — the interface makes the swap one module.
  No second source of truth in MVP.
- **Interface:** lean UI in MVP, for manual edge testing (log viewer, replay-to-N
  stepper, derived-state inspector, event injection, denial surfacing). The UI reads
  derived state only and writes through the guarded write path. No server in MVP.
- **Packing (build/buy/clone per layer, OSS evaluation):** `packing.md`.
- **Docs/showcase:** Mintlify Starter (free tier) — docs authored as Markdown in this repo,
  git-synced to Mintlify; API reference via Scalar from the OpenAPI spec once the API lands.
  Rationale recorded in `packing.md` D8.

## 2. Build phases (sequenced; unblocked parts first)

**Phase 0 — Rulings.** The 6 open questions from the proposal (§7) plus the NODE.state cache question. Phases 1–2 do not wait for them (event schema is settled; append-at-end insertion is the delegated decision, reversible).

**Phase 1 — Event store + write gates.**
Append-only SQLite events table (schema in `packing.md` §3); gapless monotonic `seq`
(gaps are anomaly signals); every event carries eventId, stream, type, node ref,
payload, actor, timestamp. Write-time gates: COMPLETE requires `evidenceRef`; REOPEN
requires `reason`; ADD_CHILD under done/cancelled denied; unknown event types rejected;
out-of-order sequence rejected; duplicate eventIds are idempotent no-ops. Each gate is
a small falsifiable unit with its own tests. Guards run in the write path *before*
append — the store never validates domain rules.

**Phase 2 — Fold engine.**
Replay the event store through the transition tables (`charts/` are the verified source) to derive: node set, parent/child links, sibling order, states, drain predicate, DFS cursor. Supports fold-to-N (time travel). The fold is authoritative; any cached copy is labeled cache and loses on disagreement (per the state-model ruling 2026-10-16).

**Phase 3 — Completion contract + suggester.**
On every COMPLETE: legality check (was the transition valid?), unblock set (dependents actually unblocked, verified), backtrack target, invariant spot-check on the affected path, then the next-action suggestion with mandatory receipts (trigger event, ranking-function version, rejected alternatives, vapor caveat). Deterministic: same log ⇒ same suggestion. Advisory only — nothing auto-executes.

**Phase 4 — Vapor pipeline + invariant sweeps.**
Vapor pipeline (claim machine): DECLARED → FILE_PENDING → FILED → NODE_PENDING → MATERIALIZED / DROPPED. The sweep proposes (drafts file, proposes parent+kind — deterministic); he approves at each gate (human-in-the-loop); the machine enforces no-skip, no double-approve, reason-on-reject. Breach/escalation is a derived predicate (like drain), not a state. Completion gate carries a `vapor_declared` attestation field. Sweeps (on-demand): orphans, cycles, done-parent⇒children-terminal, bidirectional parent↔child, count reconciliation, depth drift, hollow nodes (missing definition/done-criteria), drained-then-regrown subtrees.

**Phase 5 — Lean UI (edge-testing rig) + scenario test suite.**
The UI wraps phases 1–4 for manual edge testing: event-log viewer, replay-to-N stepper,
derived-state inspector (cursor, drain flags, suggestions with receipts), manual event
injection through the guarded write path, and denial surfacing (rejected writes shown
with reasons). Clone Plane's component design patterns, not its code (AGPL-3.0 —
patterns only). The test suite executes §5: every demo scenario (S1–S8) replayed as a
test, plus T1–T8. A scenario test = event script in, asserted fold out. The D2 deck
remains the human-readable form of the same scripts.

## 3. In scope / out of scope

| Area | IN (MVP builds it) | OUT (explicitly parked) |
|---|---|---|
| Recording | Append-only sequenced event log; actor+timestamp per event; write-time gates (evidence, reason, deny rules) | Cryptographic tamper evidence (hash chain is a named hardening step) |
| State | 5-state node lifecycle (the tested chart); fold-derived tree, cursor, drain; time travel to N | Stored authoritative derived fields; any second source of truth |
| Completion | Evidence-gated COMPLETE; per-completion contract (legality, unblocks, backtrack, spot-check) | Forecasting, pace estimates |
| Suggestions | Deterministic next-action with receipts; advisory-only | Suggestion quality scoring; push notifications; digests |
| Dynamic tree | Discovered-child insertion (append-at-end) with provenance; add-to-done denied + explicit re-open | Priority insertion; full blocker graph + cycle detection (tree-local blocked-by only) |
| Vapor | Declare → age/breach → materialize pipeline | Chat-vs-file forensics; auto-declaration from chat |
| Safety | On-demand invariant sweeps; hollow-node detection | Stall/starvation detection; auto-healing; background monitoring |
| Workers | Single worker, self-authorized | Multi-worker: double-claim, concurrent merge, conflicting suggestions — scope void if a second writer appears |
| Interface | Lean UI for manual edge testing (reads derived state; writes via guarded path) | Server, mobile, multi-user |

## 4. JTBD — possible in MVP vs deferred

**Possible in MVP** (each maps to a phase + tests):

| Job | What the user can do | Phase | Tests |
|---|---|---|---|
| Track a branching build depth-first | Keep the dashboard tree; always know the cursor | 2 | S3, T2 |
| Prove a task is done | Complete only with evidence; denials are logged | 1, 3 | S2, T1 |
| Get interrupted and resume exactly | Block on a discovered dependency; cursor returns by replay | 2, 3 | S1 |
| Capture discovered work mid-flight | Add child with provenance; traversal order stays deterministic | 1, 2 | S1, T7 |
| Change my mind honestly | Reopen with reason; bare reopen denied; audit trail intact | 1, 2 | S6 |
| Kill unnecessary work cleanly | Cancel as terminal verdict; parent drains on done-or-cancelled | 1, 2 | S7 |
| Keep ideas from dying in chat | Declare when prompted; system drafts file + proposes node; I approve at each gate; machine enforces order; breach escalates | 4 | S5, S9, T5, T9–T12 |
| Approve, don't drive | File drafts and node placements arrive proposed; my only job is approve/reject | 4 | S5, S9 |
| Know what a finish unlocked | Per-completion: legality, unblocks, backtrack target | 3 | S1, S3 |
| Get told what's next, with reasons | Deterministic suggestion + receipts; reproducible | 3 | S8, T6 |
| Verify the system isn't lying | Replay to any event N; invariant sweeps on demand | 2, 4 | T2, T8 |

**Deferred post-MVP** (each names its un-parking condition):

| Job | Why deferred | Un-parks when |
|---|---|---|
| Coordinate with a second worker on the tree | Single-worker assumption; concurrency needs conflict semantics | A second writer appears (proposal falsifier 1) |
| Prove history wasn't tampered with | Sequence gaps suffice for one trusted operator | Threat model includes a malicious operator |
| Get reminded without asking | MVP is pull-only by design | He asks for push, or a missed-event incident like 2026-10-06 recurs |
| Know when work is stalled/starving | Detection without agreed thresholds is nagging | He defines stall/starvation thresholds worth enforcing |
| Forecast when things finish | No pace data in MVP; forecasting on n<30 is noise (count-don't-rate) | n≥30 completions with measured durations |
| Know if suggestions are actually good | Scoring needs outcome data the MVP doesn't collect | Suggestion log exists + he wants quality measured |
| Catch what I forgot to declare | Chat forensics is a separate system | Vapor queue stays empty while chat produces decisions (proposal falsifier) |
| Model cross-branch dependencies | Tree-local blocked-by covers the dashboard slice | A real cycle or cross-branch block appears in practice |

## 5. Test plan — scenarios as executable tests

Each test replays an event script and asserts the folded result. S1–S8 are the demo scenarios, now as tests; T1–T8 cover the guards and properties the demos don't.

| Test | Replays | Asserts (folded) |
|---|---|---|
| S1 interruption | BLOCK→ADD_CHILD→START→COMPLETE→UNBLOCK→COMPLETE | colors done, design_tokens done, cursor = loading_state; event chain replays identically |
| S2 done-without-proof | COMPLETE (bare) → COMPLETE (+evidence) | bare denied, state stays in_progress; evidenced → done |
| S7 false finish | START→CANCEL→START | cancelled terminal; START denied; improve_visual drains |
| S3 backtrack | (post S1+S2+S7 log) | cursor = table; drain predicates true up the chain |
| S5 vapor catch | DECLARE→(age)→MATERIALIZE | claim listed with age; then node under table, unstarted |
| S8 what's next | (post S5 log) | suggestion = START pagination + receipts reproduce on re-fold |
| S6 honest undo | REOPEN (bare) → REOPEN (+reason) → COMPLETE | bare denied; reasoned → in_progress; audit trail shows done→in_progress→done |
| S9 escalation | DECLARE → DRAFT_FILE → (3 days pass) → APPROVE_FILE (late) | breach predicate fires on unapproved claim; late approval resumes the pipeline; claim survived in the log |
| S4 scope creep | ADD_CHILD (denied) → REOPEN (+reason) → ADD_CHILD | denied on done branch; after re-open, child exists with provenance |
| T1 invalid transitions | COMPLETE from unstarted; UNBLOCK from in_progress; REOPEN from cancelled | all rejected; state unchanged; rejection logged |
| T2 replay determinism | Full S1–S8 log folded twice | byte-identical derived state; identical suggestion |
| T3 idempotent no-ops | double START / COMPLETE / BLOCK / CANCEL | single state change; duplicate events in log, no error |
| T4 done→cancelled path | CANCEL from done (denied); REOPEN→CANCEL | direct denied; via reopen lands cancelled |
| T5 vapor aging | DECLARE, advance clock, list | age computed; breach flagged past SLA; unmaterialized stays visible |
| T6 suggestion receipts | Same log, two runs | identical pick, identical rejected-alternatives list |
| T7 drained resurrection | ADD_CHILD under drained subtree | denied; after REOPEN(with reason) succeeds; subtree un-drains |
| T8 time travel | Fold to N for several N | historical states match the demo boards frame-for-frame |

## 6. Acceptance criteria

- **NSM:** 100% of completions emit the full per-completion contract purely from replay (proposal §Promise).
- **Counter-metric:** 0 false next-actions (receipts must reproduce on re-replay).
- **Gates:** no DONE without evidenceRef; no REOPEN without reason; no ADD_CHILD under done/cancelled without re-open — each breached in testing on purpose (T1, S2, S6, S4, T7) and each correctly denied.
- **Falsifiers (proposal):** one full feature tracked end-to-end with clean sweep and zero undeclared vapor on spot-check = PASS. Log abandoned 30 days, or one unreproducible suggestion, or one gateless DONE = FAIL.

## 7. Open rulings required (carried over, still awaiting word — his or Isha's)

1. Discovered-child insertion: append-at-end (delegated; reversible).
2. Add-child-to-done: deny + explicit re-open (delegated; reversible).
3. Blocker model: tree-local refs; full graph parked.
4. Tamper evidence: sequence now, hash chain later.
5. Tree caps: depth 8, 20 children/parent (recommended).
6. NODE.state field: declared cache with fold-wins arbitration (state-model ruling 2026-10-16; needs confirmation).
7. State-machine idempotency + done→cancelled policy (delegated 2026-10-16; reversible).

**Resolved since the proposal** (see `packing.md` §5):
- Log location → SQLite behind the storage interface (`packing.md` §3); KurrentDB is the named upgrade.
- Approval UX → chat (Muse/Claude); claim pipeline stays in our store (single source of truth).
- Transition tables are the spec; JSON + tiny runner preferred over the XState vehicle.
- Lean UI is in MVP scope, for manual edge testing.

*Phase 1 is unblocked: the event store decision is made and the interface is specified.*
