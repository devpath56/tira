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

## Code — Phase 1: Track A (generic core) + Track C1 (tree)

TypeScript run directly by Node ≥ 22.18 (type stripping; no build step). SQLite via the
built-in `node:sqlite`. Tests via `node:test`. `npm run check` = verify + typecheck + tests;
`npm run mutants` plants 116 known bugs and fails unless the suite catches every one.
CI runs both, re-extracts `charts/*.json` and fails on any difference (no hand edits), and
runs `docs/tools/region-scan.py --all` in **warn mode** (reported, not blocking — the
regions proposal's graduation rule). No runtime dependencies: `xstate` is a dev
dependency, used only by the chart verifiers.

| Path | What it is |
|---|---|
| `src/store/` | `EventStore` interface (`packing.md` §3) + SQLite implementation: append-only triggers, gapless `seq`, idempotent `eventId`, `expectedRevision` |
| `src/tables/` | Runner over `charts/*.json`: `step()` returns the **outcome** (transition / no-op / denied / guard-failed). Registry: entity type → one or more tables (regions, coupled only by handoff events — no cross-region invariant), versioned identity, per-type birth name (`node.born`), and a same-lifecycle `tree` config |
| `src/fold/` | `fold(log, {upToSeq, now, vantage})`: replay-to-N, derived predicates (incl. `drained`), per-stream tree summary (roots, cursor, active), rejections, anomalies; `canonicalJson` for byte-identical refolds. `evaluate()` is the one legality function shared with the write path; `tree.ts` holds the tree rules |
| `src/write/` | Guarded write path: replay → evaluate → append the event, or append `command.rejected`. Submits to one stream of one store are queued across all `WritePath` instances (many actors, one writer); cross-process races retry on `expectedRevision` with jittered backoff |
| `src/render/` | D1: the thin read-only HTML page and the text tree, both drawn from one view of the fold |
| `src/cli/`, `scripts/tira.ts` | `tira` CLI for manual testing (below) |

**Track C1 — the tree (rulings 2026-10-16/17/18).** Same-lifecycle rules only. The node
table is unchanged (same 5-state lifecycle); tira's own closes go through it like anyone's.

| Rule | Behaviour |
|---|---|
| Birth | `node.born {parent_id?, kind?, discovered_during?}`. Children are appended at the end (ruling 1). `kind` = planned (default) or discovered; discovered must name `discovered_during`. The actor is recorded |
| Parent's own table | A child is born only if the parent's table accepts `ADD_CHILD` — so done or cancelled parents refuse children until re-opened with a reason (ruling 4) |
| Caps | Depth ≤ 8 (root = 1), ≤ 20 children per parent (ruling 1) |
| Drain | A parent drains when every **direct** child is done or cancelled. A leaf never drains (it is the work) |
| Closing gate | A parent can't COMPLETE, and can't be CANCELLED, while any child is open — close the children first, one by one if you like (rulings A2, 2026-10-18) |
| Re-open order | A task under a done parent can't be re-opened; re-open the parent first, with a reason (2026-10-18) |
| One active task | "Active" = in_progress with no in_progress descendant (ruling A4). Checked on the would-be tree, so START, UNBLOCK and REOPEN are all covered; descending into a child of the active task is allowed |
| **tira holds the pen** | When you start work (START / UNBLOCK / REOPEN into in progress) **outside** a drained, still-open parent, tira writes that parent's completion itself — `node.start` (if nobody started it) + `node.complete`, as actor `tira`, through the same rule checker, each citing your move (`trigger` + `causationId`). Closing one parent can drain its own parent, so the chain climbs. tira's events land in the same atomic append as your move, just ahead of it. If your move is rejected, tira writes nothing. "Moving on" means starting work; blocking, cancelling or completing elsewhere doesn't count. Starting an ancestor of a finished branch is outside that branch, so it counts (2026-10-18) |
| One close, two events | tira's start + complete of an unstarted parent count as one close: the one-active rule judges the end state (the parent is done again one event later), so tira can close a finished branch while you're working elsewhere. Every other rule still applies. A close is all or nothing: if any step is refused, tira keeps none of that parent's events, logs the refusal under its own name, and your move still lands |
| Protected name | `tira` is reserved in anything that reads as it (casing, spacing, invisible characters, accents, common lookalike letters): any caller claiming it is refused (`reserved-actor`) and logged without the name; a retry with the same eventId is a duplicate. A payload can't claim it either — only the caller's actor counts |
| Replay check | On replay, every tira event must cite a move, and the very next non-tira event must be that move, into in progress, outside the parent tira closed — or it's an anomaly. tira may only write to finished parents. Its start gets the one-close treatment only when its complete (same node, same move) is the very next event and lands. "Closed by tira" follows whoever made the last real change, so a repeat click on a done parent doesn't wipe it |
| Cursor | First **open leaf** in depth-first order (birth order). Closed branches aren't entered; blocked parents are (their children stay workable); parents waiting for tira are skipped, so the cursor never parks on a parent waiting for a click |
| Last branch | The final branch of a tree has nowhere to move on to, so it stays open until someone closes it or starts work elsewhere (decided with Isha 2026-10-18) |

### Manual testing: the `tira` CLI

A file-backed rig. Writes go through the guarded write path; reads are folds — the CLI
never sets state. `node scripts/tira.ts --help` for everything.

```
node scripts/tira.ts types                                            # entity types, states, events
node scripts/tira.ts create node dashboard --actor isha
node scripts/tira.ts create node colors --parent dashboard            # a child (node.born with parent_id)
node scripts/tira.ts send node colors START
node scripts/tira.ts send node colors COMPLETE                        # REJECTED guard-failed, exit 2
node scripts/tira.ts send node colors COMPLETE evidenceRef=palette.png
node scripts/tira.ts tree                                             # tree + ◆ cursor, ● active, drained, closed by tira
node scripts/tira.ts render --out tira.html                           # D1 page; re-run and reload to refresh
node scripts/tira.ts log                                              # raw log, rejections included
node scripts/tira.ts state                                            # entities, rejections, anomalies
node scripts/tira.ts replay 3                                         # state as of event 3
node scripts/tira.ts dump --hash                                      # sha256 of the canonical derived state
```

Store: `--db` (default `$TIRA_DB`, else `./tira.db`; `*.db` and `tira.html` are git-ignored).
Tree: `--stream` (default `$TIRA_STREAM`, else `tasktree-main`). `key=value` payload values
are strings; use `--payload '{"k":1}'` for other types. `--event-id` makes a re-send a
`duplicate`. Event names work in either form (`COMPLETE` or `complete`, `ADD_CHILD` or
`add-child`). `--json` on any command. Exit codes: 0 ok · 2 rejected by the rules · 1 usage/error.

### Demo D0 script (manual test M0)

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
never reached `done`. `rm d0.db d0-fresh.db` to start over. Stores written before C1 hold
`node.created` births, which now show as anomalies: start them over.

### Demo D1 script (manual test M1): S3 backtrack, visible — tira closes the branch

```
export TIRA_DB=d1.db TIRA_STREAM=tasktree-dash TIRA_ACTOR=isha
t() { node scripts/tira.ts "$@"; }
t create node dashboard && t create node metrics_card --parent dashboard
t create node fetch_metrics --parent metrics_card && t create node improve_visual --parent metrics_card
for n in colors loading_state font; do t create node $n --parent improve_visual; done
t create node table --parent dashboard && t create node filters --parent dashboard
t send node fetch_metrics START && t send node fetch_metrics COMPLETE evidenceRef=api.md
t send node colors START && t send node colors BLOCK                                       # interrupted
t create node design_tokens --parent improve_visual kind=discovered discovered_during=colors
t send node design_tokens START && t send node design_tokens COMPLETE evidenceRef=token-spec.md
t send node colors UNBLOCK && t send node colors COMPLETE evidenceRef=palette.png          # resumed
t send node loading_state START && t send node loading_state COMPLETE evidenceRef=spinner.mp4
t send node font START && t send node font CANCEL                                          # improve_visual drains
t tree                                                                # cursor: table; improve_visual waits for tira
t send node table START                    # moving on: tira closes improve_visual, then metrics_card, citing this
t render --out d1.html && t tree && t dump --hash                     # both parents "closed by tira"; drain climbed
```

M1 passes when the page (`d1.html`) shows every node from `t dump` exactly once with the
same state, drain flag, cursor (◆ next) and active task (the glowing node). The ✓ chip at
the top right shows the hash; hover it, or open **Activity**, for the full value, which
must equal `t dump --hash`. The page's `data-node-count` must equal
`data-fold-tree-count`. Parents tira closed carry a leaf. Click any task to open its
drawer and history; tira's entries say why and which move they cite. Closing the branch
took no clicks beyond moving on to `table`.

The page has three views:

| View | Shows |
|---|---|
| **Tree** (default) | Branches grow from the root; tasks are buds (to do), glowing (in progress), blossoms (done) or fallen petals (dropped). A dashed ring means tira closes it when you move on; a leaf means tira closed it |
| **Board** | Jira-style status columns of the work (the leaf tasks), with a strip of parents and their "children closed" meters above |
| **Activity** | The whole log, newest first, including rejected commands, anomalies, other entities and the full hash |

Words live in the drawers, not on the canvas. The page follows the system's light or dark
setting. It is self-contained (no JS, fonts or scripts from the network; tabs and drawers
are CSS), so the bytes still depend only on the fold. Motion is CSS only and turns off
for reduced motion and for print.

**Event names (D1, decided):** stored types are lowercase-kebab, derived mechanically
from the table events: `node.born` (decided 2026-10-17), `node.start`, `node.add-child`,
`idea.created`, `command.rejected`.

**Decided 2026-10-18 (backtrack ruling).** Drain stays local; every parent completion is an
explicit recorded event; tira writes the ones nobody clicks, when work moves on. Build-plan
§5's S3 row is stale on drain (Devansh is updating it): at post-S1+S2+S7 the cursor is
`table` and improve_visual is drained; metrics_card drains once tira closes improve_visual,
which happens when you start `table`. Two calls made with Isha: a parent nobody started is
closed with a tira start + complete; the last branch of a tree stays open (above).

**Also decided 2026-10-18:** a blocked parent's children stay workable; T7 = no new child
under a done or cancelled parent, while a drained-but-open parent accepts one and un-drains.

**Provisional choices, pending the PM** (each is flagged at its source):
- Several roots in one stream are allowed (D0 uses three); depth counts the root as 1.
- Discovered work must carry an actor ("who found it"); `kind` must be planned or
  discovered when given; `parent_id` is rejected on types without a tree.
- Replay re-checks births and gates, so changing the caps or gate rules later would turn
  older history into anomalies. Treat them as part of the log's contract.
- Entities are created by an explicit `create` command at their tables' initial states;
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
