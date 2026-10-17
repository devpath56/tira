## Why build this?

- Devansh runs a factory where AI workers do the building — but tracking the work is a second job: who picked up what, what's moving, what went quiet, all reconstructed from chats, files, and lists at every status check.
- Twice the factory lied to him: a silent session was assumed stood down while alive; work was marked landed having skipped every check.
- Good ideas surface in conversation and die there — turning them into tracked work is manual effort nobody has.
- Then Isha builds tira: every piece of work written down once, as it happens, in a record nobody can rewrite — the live picture always computed from that record, never asserted from memory.
- Nothing can be called done without its proof attached; the machine simply refuses.
- Interrupted work remembers exactly what it was waiting on — resuming isn't archaeology. Ideas caught in chat become tracked work. Any moment can be rewound to see precisely what the factory believed then.
- What he couldn't do before: trust the picture. Now the system remembers, and he judges — Isha gave the factory a memory.

> [!IMPORTANT]
> **Exec Note**
> - **Phase 1 is a vertical slice, not a foundation layer.** It ships a generic core for work management: the event store, the storage interface, the fold, and the write gates — events in, derived state out, guards enforced on every write. It is *not* a product, *not* storage without logic, and *not* a second source of truth.
> - **The factory is customer #1.** The substrate thesis gets tested against the hardest real user immediately — real event types, real edge cases — instead of against demo scenarios.
> - **The storage interface keeps the core generic: the factory is the first vocabulary, never the only one.** SQLite implements it today, KurrentDB can replace it tomorrow — the fold, guards, and UI never touch storage directly.
> - **Phase 1's falsifier is armed: we will learn exactly where the simple model breaks — and that lesson is the deliverable.** Factory work orders track three things independently (authorized, picked up with proof, finished); the machine models a task on one dial. Where the three won't fit the one, the pinch points show precisely how the core must generalize — discovered now, not after four more phases are built on the wrong shape.

# tira — deterministic task-tree tracking

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

The pair tables are the spec. The JSON files are the canonical form (packing.md D3);
the XState machines are the verified executable reference — 176 differential checks
prove JSON ≡ XState on every state×event×guard-polarity. Build against the JSON;
no XState knowledge required.

| File | What it is | Verify |
|---|---|---|
| `charts/node-lifecycle.mjs` | Node states: unstarted → in_progress → done, plus blocked, cancelled. Guards: evidence on COMPLETE, reason on REOPEN. | `node charts/verify-node-lifecycle.mjs` (47 checks) |
| `charts/idea-lifecycle.mjs` | Vapor idea pipeline: declared → file_pending → filed → node_pending → materialized / dropped. Approval gates, no stage skipping. | `node charts/verify-idea-lifecycle.mjs` (50 checks) |

| `charts/node-lifecycle.json` / `charts/idea-lifecycle.json` | The canonical tables — 35 and 36 state×event pairs, machine-generated from the `.mjs` charts (`node charts/extract-tables.mjs`). **Never hand-edit**; re-run the extractor after any chart change. | `node charts/verify-tables.mjs` (176 differential checks: JSON ≡ XState on every pair) |

`npm install && npm run verify` runs all three (47 + 50 + 176 checks).

Rules the machines enforce:
- Events are the source of truth; states are derived by folding the log. On disagreement, the fold wins.
- `COMPLETE` requires `evidenceRef`; `REOPEN` and `REJECT_*` require `reason`.
- An idea cannot skip stages: no approval of what wasn't proposed (verified — no path to materialized bypasses filed).
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

## Code — Phase 1, Track A (generic core)

TypeScript run directly by Node ≥ 22.18 (type stripping; no build step). SQLite via the
built-in `node:sqlite`. Tests via `node:test`. `npm run check` = verify + typecheck + tests;
`npm run mutants` plants 42 known bugs and fails unless the suite catches every one.
CI runs both, and also re-extracts `charts/*.json` and fails on any difference (no hand edits).
No runtime dependencies: `xstate` is a dev dependency, used only by the chart verifiers.

| Path | What it is |
|---|---|
| `src/store/` | `EventStore` interface (`packing.md` §3) + SQLite implementation: append-only triggers, gapless `seq`, idempotent `eventId`, `expectedRevision` |
| `src/tables/` | Runner over `charts/*.json`: `step()` returns the **outcome** (transition / no-op / denied / guard-failed). Registry: entity type → one or more tables (parallel regions), cross-region invariant, versioned identity, guards that see fold state + actor |
| `src/fold/` | `fold(log, {upToSeq, now, vantage})`: replay-to-N, derived predicates, rejections, anomalies; `canonicalJson` for byte-identical refolds. `evaluate()` is the one legality function shared with the write path |
| `src/cli/`, `scripts/tira.ts` | `tira` CLI for manual testing (below) |
| `src/write/` | Guarded write path: replay → evaluate → append the event, or append `command.rejected`. Submits to one stream of one store are queued across all `WritePath` instances (many actors, one writer); cross-process races retry on `expectedRevision` with jittered backoff |

Not in Track A: tree/DAG semantics (drain, cursor, frontier — C1), factory tables (B1),
emission + dual-run (B2–B3).

### Manual testing: the `tira` CLI

A file-backed rig until the lean UI lands. Writes go through the guarded write path;
reads are folds — the CLI never sets state. `node scripts/tira.ts --help` for everything.

```
node scripts/tira.ts types                                            # entity types, states, events
node scripts/tira.ts create node colors --actor isha
node scripts/tira.ts send node colors START
node scripts/tira.ts send node colors COMPLETE                        # REJECTED guard-failed, exit 2
node scripts/tira.ts send node colors COMPLETE evidenceRef=palette.png
node scripts/tira.ts log                                              # raw log, rejections included
node scripts/tira.ts state                                            # entities, rejections, anomalies
node scripts/tira.ts replay 3                                         # state as of event 3
node scripts/tira.ts dump                                             # full derived state, canonical JSON
node scripts/tira.ts dump --hash                                      # sha256 of that JSON
```

Store: `--db` (default `$TIRA_DB`, else `./tira.db`; `*.db` is git-ignored). Tree: `--stream`
(default `$TIRA_STREAM`, else `tasktree-main`). `key=value` payload values are strings;
use `--payload '{"k":1}'` for other types. `--event-id` makes a re-send a `duplicate`.
Event names work in either form (`COMPLETE` or `complete`, `ADD_CHILD` or `add-child`).
`--json` on any command. Exit codes: 0 ok · 2 rejected by the rules · 1 usage/error.

### Demo D0 script (build-plan.md "Demo checkpoints", manual test M0)

Run from this folder. Nothing derived is ever stored: every command, including `dump`,
replays the raw log from scratch. So step 4's "wipe derived state, replay" is shown by
replaying in a fresh store that holds only a copy of the raw log, and comparing hashes.

```
export TIRA_DB=d0.db
node scripts/tira.ts create node a && node scripts/tira.ts create node b && node scripts/tira.ts create node c   # 1
node scripts/tira.ts send node a START && node scripts/tira.ts send node a COMPLETE evidenceRef=proof.png        # 2: a -> done
node scripts/tira.ts send node b START && node scripts/tira.ts send node b COMPLETE                              # 3: REJECTED, exit 2
node scripts/tira.ts log                                                   # 3: command.rejected row in the log
node scripts/tira.ts state                                                 # 3: ...and b is still in_progress (never applied)
node scripts/tira.ts dump --hash                                           # 4: hash of the derived state
cp d0.db d0-fresh.db && node scripts/tira.ts --db d0-fresh.db dump --hash  # 4: same hash from a fresh replay
node scripts/tira.ts dump --hash                                           # M0 re-run: identical again
```

M0 passes when both hashes match and the `command.rejected` row is in the log but `b`
never reached `done`. `rm d0.db d0-fresh.db` to start over.

**Event names (D1, decided):** stored types are lowercase-kebab, derived mechanically
from the table events: `node.created`, `node.start`, `node.add-child`, `command.rejected`.

**Provisional choices, pending the PM** (each is flagged at its source):
entities are created by an explicit `create` command at their tables' initial states;
an `eventId` names one command (same id + same content = duplicate, same id + different
content = error); malformed commands throw rather than being logged; `eventId` is globally
unique, so re-using one in another stream throws; `subscribe()` is at-least-once with an
`onError` hook.

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
