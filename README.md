# Dashboard-IMDP — deterministic task-tree tracking MVP

A single-worker system that tracks hierarchical work depth-first: every mutation is an
append-only event, and all state (tree, cursor, drain) is derived by replaying the log.
Nothing is stored as "current" — the fold is authoritative.

## Start here

1. **The story** — `demo/demo-deck-v6.html`: 9 scenarios, story-first, then the machine.
   Keyboard: `n` next, `b` back.
2. **The plan** — `build-plan.md`: phases, in/out scope, JTBDs, test plan, acceptance criteria.
3. **The packing** — `packing.md`: build/buy/clone per layer, the storage interface
   (SQLite now, KurrentDB as the named upgrade), UI scope, decision log.
4. **The spec** — `charts/`: the transition tables in executable form. These are not diagrams;
   they are the transition functions the implementation must honor.

## The spec (executable)

The pair tables are the spec; the XState machines below are their verified executable
form (packing.md D3: JSON tables + a tiny runner are the preferred going-forward form —
the tables transfer verbatim from these 47/50 checks).

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

Phase 1: vertical slice — event store (SQLite, via the storage interface in `packing.md` §3)
+ fold + write gates + factory stream vocabulary (brief/session/drop events); dual-run
probe begins here
→ Phase 2: completion contract + suggester → Phase 3: vapor pipeline + sweeps
→ Phase 4: lean UI (edge-testing rig) + test suite.
Rationale for the Phase 1 scope: `packing.md` D9 (factory as customer #1).
Details in `build-plan.md`. The D2 sources in `demo/*.d2` are the acceptance scenarios
(S1–S8 + S9); `demo/build_deck.py` rebuilds the deck from them.

## Docs & showcase

Public documentation is authored as Markdown in this repo and published via
**Mintlify Starter (free)** — custom domain, git sync, API playground, and search
included. Rationale: the free tier's gates (no AI assistant, no preview deployments,
no analytics, 5 editor seats) don't constrain a two-person public showcase, and
docs stay MDX-in-git, so Docusaurus is a clean exit if we ever outgrow it.
API reference renders via Scalar from the OpenAPI spec once the API lands.
Internal knowledge (runbooks, decision logs) lives in BookStack, not here.

## Decisions

**Resolved** (see `packing.md` §5 for rationale):
- Claim-pipeline approvals happen in chat (Muse/Claude).
- Event store: SQLite behind the storage interface (`packing.md` §3); KurrentDB is the named upgrade path.
- Claim pipeline lives in our store (single source of truth).
- Transition tables are the spec; JSON + tiny runner preferred over a framework vehicle.
- Lean UI is in MVP scope, for manual edge testing.

**Still yours** — each carries a recommendation; take it or come back:

1. **Tree caps** — recommendation: depth 8, 20 children per parent.
2. **NODE.state field** — recommendation: declared cache; on disagreement the fold wins.
3. **Discovered-child insertion** — recommendation: append-at-end (deterministic).
4. **Add child under a done branch** — recommendation: deny; explicit re-open with reason.
5. **Blocker model** — recommendation: tree-local blocked-by refs (no cycle detection in MVP).
6. **Tamper evidence** — recommendation: sequence numbers now, hash chain later.
7. **Idempotency** — duplicate START/COMPLETE/BLOCK/CANCEL are logged no-ops (already in the charts).

## Key concepts (30 seconds)

- **Replay**: the system re-runs the event log to recompute the present. No `current_task` field exists.
- **Drain**: a subtree with no actionable work left (every child done-or-cancelled) — the backtrack trigger. Derived, like the cursor.
- **Claim pipeline**: vapor → file → node. The sweep proposes (deterministic), the human approves, the machine enforces the order.
- **Approve, don't drive**: the human's job is judgment at gates, never remembering state.
