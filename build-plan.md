# MVP Build Plan — Deterministic Task-Tree Tracking

- **Date:** 2026-10-16
- **Status:** Track A built + merged to main (PR #1, 2026-10-17); C1 go-word given 2026-10-17; everything else needs an explicit go-word.
- **Companions:** proposal (`proposal-deterministic-tracking-mvp-20261016.md`), functional requirements (`functional-requirements-deterministic-tracking-mvp-2026-10-16.md`), exec brief (126 trust queries), state chart (`tracking-mvp/charts/node-lifecycle.mjs`), demo (`tracking-mvp/demo/`)

## 0. What's already built (do not rebuild)

| Artifact | Location | Verified |
|---|---|---|
| Canonical transition tables (JSON) | `tracking-mvp/charts/node-lifecycle.json` (35 pairs), `tracking-mvp/charts/idea-lifecycle.json` (36 pairs) | Mechanically extracted from the charts; 176 differential checks prove JSON ≡ XState on every state×event×guard-polarity |
| Node lifecycle chart (XState, executable reference) | `tracking-mvp/charts/node-lifecycle.mjs` | Constructed + executed: 35 state×event pairs, all 5 states reachable, guards fire, no vacuous done (47 checks) |
| Idea pipeline chart (XState, executable reference) | `tracking-mvp/charts/idea-lifecycle.mjs` | Constructed + executed: 36 pairs, 50/50 checks — no-skip (no path to materialized bypasses filed), approval gates, bare-reject guard |
| State matrix + 3 delegated rulings | chat 2026-10-16 (idempotent no-ops; done→cancelled forbidden; add-child-to-done denied) | Rulings recorded in chart comments; reversible |
| 9 demo scenarios as D2 animations + HTML deck | `tracking-mvp/demo/` | Every board rendered + screenshot-verified against real D2 v0.9.0 |

The JSON tables are the transition function the fold engine builds against — language-agnostic, no XState knowledge required. The XState charts remain the verified executable reference (the differential test re-proves equivalence on every run). **Test the tables, ship the tables.** The demo scenarios double as the acceptance test scripts (§5).

## 1. Architecture (4 components + UI)

```
event store — SQLite, append-only (interface: packing.md §3)
    │  write-time gates: schema, sequencing, evidence-on-COMPLETE,
    │  reason-on-REOPEN, add-child-to-done deny
    ▼
fold engine ──builds against──▶ transition tables (charts/*.json are the canonical
                           source, mechanically extracted; 176 differential
                           checks prove JSON ≡ XState on every pair)
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
- **Regions (hardened 2026-10-16):** one region per entity lifecycle; joint configurations computed by fold, never enumerated; handoff events with correlation ids are the only cross-region coupling (`proposal-orthogonal-regions-lifecycle-engine-20261016.md`); `your_files/tools/region-scan.py` runs the overlap + guard scans at pack time (tier A).
- **Docs/showcase:** Mintlify Starter (free tier) — docs authored as Markdown in this repo,
  git-synced to Mintlify; API reference via Scalar from the OpenAPI spec once the API lands.
  Rationale recorded in `packing.md` D8.

## 2. Build phases (sequenced; unblocked parts first)

**Phase 0 — Rulings.** Mostly decided 2026-10-16 (see §7): the 7 README rulings, parent lifecycle, cursor rule, one-active-task gate, B1 writer model, E2 test placement. Genuinely open: D1 event-name casing (Isha's call), E1/E3 Phase-1 exit (his), group C factory questions (his, before B2), group F (later).

**Phase 1 — Vertical slice: store + fold + factory stream.**
The first build is end-to-end, not layered: SQLite event store behind the storage
interface (`packing.md` §3) + fold over the transition tables (`charts/*.json`, the
canonical spec — no XState dependency) + write gates
(COMPLETE requires `evidenceRef`; REOPEN requires `reason`; ADD_CHILD under
done/cancelled denied; duplicate eventIds are idempotent no-ops — guards run in the
write path *before* append, the store never validates domain rules; single
serialized writer — sessions emit, one dispatcher appends, scope void if a second
writer appears — N2 2026-10-17), with the
**factory stream as the first event vocabulary** — `brief.dispatched/claimed/evidence/
drop-written/verified`, `session.named/ended` (compaction packet §4.3, §5.3, §8.3).
The dashboard scenarios (S1–S9) serve as the executable test suite, not the product.
Dual-run begins here: derived state diffed against file state ad-hoc, on his request
(no scheduled job — N3 2026-10-17); divergence is the
signal that decides the cutover.
*Rationale (`packing.md` D9): the factory is customer #1; the substrate thesis is tested
against the hardest real user from day one, and the cutover decision gets measured
evidence instead of argument.*
*Falsifier: if the brief's 3-dimension state (gate × claim × outcome) doesn't fit the
node lifecycle cleanly, Phase 1 discovers the generalization the core needs — before
anything else is built on it.*
*Update 2026-10-16:* the generalization is specified and hardened — `proposal-orthogonal-regions-lifecycle-engine-20261016.md`: factor entity lifecycles into orthogonal regions, never flatten into a product machine above the enumeration budget; joint configurations computed by fold, never enumerated; handoff events with correlation ids as the only cross-region coupling; `your_files/tools/region-scan.py` (overlap + guard scans) instruments the NSM (0 enumerated product states) and counter-metric (0 cross-region guards) at pack time. The brief's 3-dimension state is the first composition to run through it.

**Phase 2 — Completion contract + suggester.**
On every COMPLETE: legality check (was the transition valid?), unblock set (dependents actually unblocked, verified), backtrack target, invariant spot-check on the affected path, then the next-action suggestion with mandatory receipts (trigger event, ranking-function version, rejected alternatives, vapor caveat). Deterministic: same log ⇒ same suggestion. Advisory only — nothing auto-executes.

**Phase 3 — Vapor pipeline + invariant sweeps.**
Vapor pipeline (idea machine): DECLARED → FILE_PENDING → FILED → NODE_PENDING → MATERIALIZED / DROPPED. The sweep proposes (drafts file, proposes parent+kind — deterministic); he approves at each gate (human-in-the-loop); the machine enforces no-skip, no double-approve, reason-on-reject. Breach/escalation is a derived predicate (like drain), not a state. Completion gate carries a `vapor_declared` attestation field. Sweeps (on-demand): orphans, cycles, done-parent⇒children-terminal, bidirectional parent↔child, count reconciliation, depth drift, hollow nodes (missing definition/done-criteria), drained-then-regrown subtrees. Stream placement (decided 2026-10-17): factory stream uses `brief.*` / `session.*` / `drop.*` namespaces (B1 tables as built); tira's vapor pipeline uses `idea.*` per N8. Handoff birth event is `node.born` (proposal F1, R2).

**Phase 4 — Lean UI (edge-testing rig).**
The UI wraps phases 1–3 for manual edge testing: event-log viewer, replay-to-N stepper,
derived-state inspector (cursor, drain flags, suggestions with receipts), manual event
injection through the guarded write path, and denial surfacing (rejected writes shown
with reasons). Clone Plane's component design patterns, not its code (AGPL-3.0 —
patterns only). The scenario test suite (§5: S1–S9 + T1–T8, event script in, asserted
fold out) lives in Phase 1 — Phase 4 is UI only (N6 2026-10-17). The D2 deck
remains the human-readable form of the same scripts.

## 3. In scope / out of scope

| Area | IN (MVP builds it) | OUT (explicitly parked) |
|---|---|---|
| Recording | Append-only sequenced event log; actor+timestamp per event; write-time gates (evidence, reason, deny rules) | Cryptographic tamper evidence (hash chain is a named hardening step) |
| State | 5-state node lifecycle (the tested chart); fold-derived tree, cursor, drain; time travel to N; orthogonal regions per hardened spec — one region per entity lifecycle, joint config by fold, never enumerated | Stored authoritative derived fields; any second source of truth; flat product machines above the enumeration budget |
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
| Track a branching build depth-first | Keep the dashboard tree; always know the cursor | 1 | S3, T2 |
| Prove a task is done | Complete only with evidence; denials are logged | 1, 2 | S2, T1 |
| Get interrupted and resume exactly | Block on a discovered dependency; cursor returns by replay | 1, 2 | S1 |
| Capture discovered work mid-flight | Add child with provenance; traversal order stays deterministic | 1 | S1, T7 |
| Change my mind honestly | Reopen with reason; bare reopen denied; audit trail intact | 1 | S6 |
| Kill unnecessary work cleanly | Cancel as terminal verdict; parent drains on done-or-cancelled | 1 | S7 |
| Keep ideas from dying in chat | Declare when prompted; system drafts file + proposes node; I approve at each gate; machine enforces order; breach escalates | 3 | S5, S9, T5 (T9–T12 referenced but undefined in §5 — define or drop) |
| Approve, don't drive | File drafts and node placements arrive proposed; my only job is approve/reject | 3 | S5, S9 |
| Know what a finish unlocked | Per-completion: legality, unblocks, backtrack target | 2 | S1, S3 |
| Get told what's next, with reasons | Deterministic suggestion + receipts; reproducible | 2 | S8, T6 |
| Verify the system isn't lying | Replay to any event N; invariant sweeps on demand | 1, 3 | T2, T8 |

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

Each test replays an event script and asserts the folded result. S1–S9 are the demo scenarios, now as tests; T1–T8 cover the guards and properties the demos don't.

| Test | Replays | Asserts (folded) |
|---|---|---|
| S1 interruption | BLOCK→ADD_CHILD→START→COMPLETE→UNBLOCK→COMPLETE | colors done, design_tokens done, cursor = loading_state; event chain replays identically |
| S2 done-without-proof | COMPLETE (bare) → COMPLETE (+evidence) | bare denied, state stays in_progress; evidenced → done |
| S7 false finish | START→CANCEL→START | cancelled terminal; START denied; improve_visual drains |
| S3 backtrack | (post S1+S2+S7 log) | cursor = table; drain predicates true up the chain |
| S5 vapor catch | DECLARE→(age)→MATERIALIZE | idea listed with age; then node under table, unstarted |
| S8 what's next | (post S5 log) | suggestion = START pagination + receipts reproduce on re-fold |
| S6 honest undo | REOPEN (bare) → REOPEN (+reason) → COMPLETE | bare denied; reasoned → in_progress; audit trail shows done→in_progress→done |
| S9 escalation | DECLARE → DRAFT_FILE → (3 days pass) → APPROVE_FILE (late) | breach predicate fires on unapproved idea; late approval resumes the pipeline; claim survived in the log |
| S4 scope creep | ADD_CHILD (denied) → REOPEN (+reason) → ADD_CHILD | denied on done branch; after re-open, child exists with provenance |
| T1 invalid transitions | COMPLETE from unstarted; UNBLOCK from in_progress; REOPEN from cancelled | all rejected; state unchanged; rejection logged |
| T2 replay determinism | Full S1–S8 log folded twice | byte-identical derived state; identical suggestion |
| T3 idempotent no-ops | double START / COMPLETE / BLOCK / CANCEL | single state change; duplicate events in log, no error |
| T4 done→cancelled path | CANCEL from done (denied); REOPEN→CANCEL | direct denied; via reopen lands cancelled |
| T5 vapor aging | DECLARE, advance clock, list | age computed; breach flagged past SLA; unmaterialized stays visible |
| T6 suggestion receipts | Same log, two runs | identical pick, identical rejected-alternatives list |
| T7 drained resurrection | ADD_CHILD under drained subtree | denied; after REOPEN(with reason) succeeds; subtree un-drains |
| T8 time travel | Fold to N for several N | historical states match the demo boards frame-for-frame |
| R1 region scans | chart JSONs + composition config through `region-scan.py` | overlap scan exits 0 (no event in >1 region except declared handoff pairs); guard scan reports 0 cross-region reads |
| R2 handoff replay | scripted log: `brief.claimed {claim_id: X}` → `node.born {claim_id: X}` | folds to brief-claim=claimed-active AND node=unstarted with matching X |
| R3 dangling handoff | log with `claim.materialized`, no `node.born` | dangling-handoff check lists X as pending, not an error |

## Demo checkpoints (added 2026-10-16) — Isha demos working features; UI starts thin at D1 and grows

**D0 — Core write path (now; Track A built).** Surface: `tira` CLI. Script: (1) create 3 nodes; (2) START one, COMPLETE with evidenceRef → done; (3) COMPLETE another without evidence → denied, `command.rejected` in the log; (4) wipe derived state, replay → identical tree. Exit: he runs the CLI himself.

**D1 — Tree + cursor + drain (after Track C1). First UI — deliberately thin.** Surface: read-only HTML page rendering the fold (tree, cursor highlight, drain flags); static render, reload to refresh. Script: S3 backtrack — build a tree, BLOCK + ADD_CHILD mid-flight, resume; cursor returns by replay; drain flags propagate up the chain. Exit: the tree is visible, not described. (Judgment call: this pulls a thin render forward from Phase 4 — ~1 hour of work — so every later demo is visual.)

**D2 — Regions composed (after Track B1 factory tables).** Surface: same HTML + region lanes. Script: the brief's 3-dimension state (gate × claim × outcome) rendered as composed regions, not one dial; handoff demo — `claim.materialized {claim_id: X}` → `node.born {claim_id: X}` with matching X; `region-scan.py` green on the composition. Exit: the orthogonal-regions spec is visible on screen.

**D3 — Dual-run live (after B2/B3).** Surface: HTML + divergence report panel. Script: real factory events land through the write path; he triggers the divergence comparison ad-hoc (no scheduled job — N3); 0 divergences shown. Exit: measured evidence, not a claim.

**D4 — Suggester (Phase 2).** Surface: HTML + "what's next" panel with receipts. Script: S8 — the suggester proposes the next task with its reason chain; completion contract enforced (`vapor_declared` attestation on the gate). Exit: a suggestion he can audit.

**D5 — Vapor pipeline (Phase 3).** Surface: HTML. Script: idea declared → filed → materialized as a node; `claim.*` namespace visible in the event stream; a stage-skip attempt → denied live. Exit: vapor → node, end to end.

**D6 — Edge-testing rig (Phase 4).** Surface: full lean UI. Script: manual event injection, on-demand sweep runs, S1–S9 + T1–T8 green. Exit: the suite he can break things against.

## Manual tests for checkpoints (added 2026-10-16 — QE pass)

Each names its oracle (what the tester compares against) and the stop authority. Blocking rule (decided 2026-10-16): a failed manual test blocks the next track — pre-committed, not decided in the moment.

| Test | Checkpoint | Oracle | Pass | Stop |
|---|---|---|---|---|
| M0 | D0 CLI | Specified: replay output byte-identical to pre-wipe derived state; denial row present in log | hashes match; `command.rejected` logged, never applied | him |
| M1 | D1 thin HTML | Derived: rendered tree node-for-node against `tira dump` CLI output; cursor highlight = fold cursor | counts match; every node present; drain flags match fold | him |
| M2 | D2 regions | Specified: `region-scan.py` exit 0; handoff `claim_id` identical in both lanes | 0 findings; X matches claim and node | him |
| M3 | D3 dual-run | Specified: divergence report reads 0, re-run twice identical | 0 divergences, repeatable | him |
| M4 | D4 suggester | Derived: receipts reproduce on re-fold (run twice) | identical pick + identical rejected-alternatives | him |
| M5 | D5 vapor | Specified: stage-skip denial in log; idea→node chain complete | skip denied; filed→materialized unbroken | him |
| M6 | D6 rig | Specified: S1–S9 + T1–T8 green | all green | him |

QE notes: (q04) a PASS on M1 licenses D2's lanes — so M1 checks completeness node-for-node, not "looks right"; a render that silently drops nodes would license D2 on a lie. (q12) M1 stays eyeball + CLI-diff — automating render assertions now costs more than the priced failure. (q05) M0/M3/M4 are re-run twice by construction: repeatability is the test.

## 6. Acceptance criteria

- **NSM:** 100% of completions emit the full per-completion contract purely from replay (proposal §Promise).
- **Counter-metric:** 0 false next-actions (receipts must reproduce on re-replay).
- **Gates:** no DONE without evidenceRef; no REOPEN without reason; no ADD_CHILD under done/cancelled without re-open — each breached in testing on purpose (T1, S2, S6, S4, T7) and each correctly denied.
- **Falsifiers (proposal):** one full feature tracked end-to-end with clean sweep and zero undeclared vapor on spot-check = PASS. Log abandoned 30 days, or one unreproducible suggestion, or one gateless DONE = FAIL.

## 7. Rulings (were open; decided 2026-10-16 via the group-A reply — struck through = closed)

1. ~~Discovered-child insertion: append-at-end~~ — decided: yes, append-at-end.
2. ~~Add-child-to-done: deny + explicit re-open~~ — decided: yes, deny + explicit re-open.
3. ~~Blocker model: tree-local refs; full graph parked~~ — decided: tree-local for the dashboard, DAG for the factory.
4. ~~Tamper evidence: sequence now, hash chain later~~ — decided: yes.
5. ~~Tree caps: depth 8, 20 children/parent~~ — decided: yes as recommended.
6. ~~NODE.state field: declared cache with fold-wins arbitration~~ — decided: yes, fold wins on disagreement.
7. ~~State-machine idempotency + done→cancelled policy~~ — decided: yes, duplicates are logged no-ops.

**Decided 2026-10-16** (group-A reply on the TIRA task):
- 7 README rulings: yes to 1–4, 6, 7 as recommended; #5 → tree-local blockers for the dashboard, DAG for the factory.
- Parents run the same 5-state lifecycle; COMPLETE denied at the write path until the subtree is drained.
- Cursor = first task in DFS order that isn't done, cancelled, or blocked.
- One active task = write gate, leaf-scoped ("active" = in_progress with no in_progress descendant); covers UNBLOCK into in_progress.
- Her Track-A defaults D2–D5 (attachment group D, not the demo checkpoints) confirmed as built; D1 casing (`node.created` vs `node.START`) open — Isha to pick one case.
- Group B via the faster alternative: she drafts the 5 factory tables, he confirms/corrects. B1 already decided (single append process, actors in metadata).
- E2 confirmed per N6: tests live in Phase 1, Phase 4 is UI only.
**Decided 2026-10-17** (B1 draft review):
- B1 factory tables signed off: yes to A1–A15 (A8 verdict values + A13 liveness stay open), C1–C6 confirmed.
- C1 go-word GIVEN (tree, drain, cursor).
- `node.born` over `node.created`; D1 thin HTML confirmed.
- Verified independently: `region-scan.py --all` on the 5 tables exits 0 (0 findings); BFS over H1–H6 reaches exactly the 10 joint combos.
- Review docs (regions proposal, `region-scan.py`, event architecture, functional reqs) pushed under `docs/` on the PR branch; PR #1 merged to main.

**Resolved since the proposal** (see `packing.md` §5):
- Log location → SQLite behind the storage interface (`packing.md` §3); KurrentDB is the named upgrade.
- Approval UX → chat (Muse/Claude); idea pipeline stays in our store (single source of truth).
- Transition tables are the spec; JSON + tiny runner preferred over the XState vehicle.
- Lean UI is in MVP scope, for manual edge testing.

*Phase 1 is unblocked and rescoped: vertical slice (store + fold + gates + factory stream) with rationale in `packing.md` D9. The dual-run probe starts here; the cutover decision gets measured evidence.*
