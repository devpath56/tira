# Dashboard-IMDP — deterministic task-tree tracking MVP

A single-worker system that tracks hierarchical work depth-first: every mutation is an
append-only event, and all state (tree, cursor, drain) is derived by replaying the log.
Nothing is stored as "current" — the fold is authoritative.

## Start here

1. **The story** — `demo/demo-deck-v6.html`: 9 scenarios, story-first, then the machine.
   Keyboard: `n` next, `b` back.
2. **The plan** — `build-plan.md`: phases, in/out scope, JTBDs, test plan, acceptance criteria.
3. **The spec** — `charts/`: two executable XState machines. These are not diagrams;
   they are the transition functions the implementation must honor.

## The spec (executable)

| File | What it is | Verify |
|---|---|---|
| `charts/node-lifecycle.mjs` | Node states: unstarted → in_progress → done, plus blocked, cancelled. Guards: evidence on COMPLETE, reason on REOPEN. | `node charts/verify-node-lifecycle.mjs` (47 checks) |
| `charts/claim-lifecycle.mjs` | Vapor claim pipeline: declared → file_pending → filed → node_pending → materialized / dropped. Approval gates, no stage skipping. | `node charts/verify-claim-lifecycle.mjs` (50 checks) |

`npm install && npm run verify` runs both.

Rules the machines enforce:
- Events are the source of truth; states are derived by folding the log. On disagreement, the fold wins.
- `COMPLETE` requires `evidenceRef`; `REOPEN` and `REJECT_*` require `reason`.
- A claim cannot skip stages: no approval of what wasn't proposed (verified — no path to materialized bypasses filed).
- Terminality is expressed by the transition tables, not by `type: "final"`
  (XState completes the actor on entering a final state, which made the ruled REOPEN
  unreachable — see the chart comments).

## Build order

Phase 1: event store + write gates → Phase 2: fold engine (imports these charts directly)
→ Phase 3: completion contract + suggester → Phase 4: vapor pipeline + sweeps
→ Phase 5: CLI + test suite.
Details in `build-plan.md`. The D2 sources in `demo/*.d2` are the acceptance scenarios
(S1–S8 + S9); `demo/build_deck.py` rebuilds the deck from them.

## Decisions you can take

Devansh resolved: claim-pipeline approvals happen in chat (Muse/Claude).
Everything below is yours — each carries a recommendation; take it or come back:

1. **Log location** (needed before Phase 1) — recommendation: VM workspace, co-located with the worker.
2. **Tree caps** — recommendation: depth 8, 20 children per parent.
3. **NODE.state field** — recommendation: declared cache; on disagreement the fold wins.
4. **Discovered-child insertion** — recommendation: append-at-end (deterministic).
5. **Add child under a done branch** — recommendation: deny; explicit re-open with reason.
6. **Blocker model** — recommendation: tree-local blocked-by refs (no cycle detection in MVP).
7. **Tamper evidence** — recommendation: sequence numbers now, hash chain later.
8. **Idempotency** — duplicate START/COMPLETE/BLOCK/CANCEL are logged no-ops (already in the charts).

## Key concepts (30 seconds)

- **Replay**: the system re-runs the event log to recompute the present. No `current_task` field exists.
- **Drain**: a subtree with no actionable work left (every child done-or-cancelled) — the backtrack trigger. Derived, like the cursor.
- **Claim pipeline**: vapor → file → node. The sweep proposes (deterministic), the human approves, the machine enforces the order.
- **Approve, don't drive**: the human's job is judgment at gates, never remembering state.
