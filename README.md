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
> - **The storage interface keeps the core generic: the factory is the first vocabulary, never the only one.** Postgres implements it for every live tira (hosted, the only live store), SQLite for tests — the fold, guards, and UI never touch storage directly.
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
   (Postgres, hosted, the only live store; SQLite for tests), UI scope, decision log.
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

TypeScript run directly by Node ≥ 22.18 (type stripping; no build step). Postgres via `pg`
(the live store); SQLite via the built-in `node:sqlite` (tests, and `tira import`'s source). Tests via `node:test`. `npm run check` = verify + typecheck + tests;
`npm run mutants` plants 911 known bugs and fails unless the suite catches every one;
`npm run mutants:check` proves in under a second that each one still lands exactly once.
Each bug stops at its first failing test (the one that caught it last time first, then
likely test files), one bug per core, so a warm run takes minutes, not the best part of an hour.
CI runs the match check first, then both (with a throwaway Postgres service, so the Postgres store's tests and planted bugs run too), re-extracts `charts/*.json` and fails on any difference (no hand edits), and
runs `docs/tools/region-scan.py --all` in **warn mode** (reported, not blocking — the
regions proposal's graduation rule). One runtime dependency, `pg` (the Postgres driver); `xstate` is a dev
dependency, used only by the chart verifiers.

| Path | What it is |
|---|---|
| `src/store/` | `EventStore` interface (`packing.md` §3) + SQLite and Postgres implementations, held to the same contract tests: append-only triggers, gapless `seq`, idempotent `eventId`, `expectedRevision`; `open.ts` opens the live Postgres store from `$TIRA_DATABASE_URL` and refuses anything else |
| `src/tables/` | Runner over `charts/*.json`: `step()` returns the **outcome** (transition / no-op / denied / guard-failed). Registry: entity type → one or more tables (regions, coupled only by handoff events — no cross-region invariant), versioned identity, per-type birth name (`node.born`), and a same-lifecycle `tree` config |
| `src/fold/` | `fold(log, {upToSeq, now, vantage})`: replay-to-N, derived predicates (incl. `drained`), per-stream tree summary (roots, cursor, active), rejections, anomalies; `canonicalJson` for byte-identical refolds. `evaluate()` is the one legality function shared with the write path; `tree.ts` holds the tree rules |
| `src/write/` | Guarded write path: replay → evaluate → append the event, or append `command.rejected`. Submits to one stream of one store are queued across all `WritePath` instances (many actors, one writer); cross-process races retry on `expectedRevision` with jittered backoff |
| `src/render/` | D1: the thin read-only HTML page and the text tree, both drawn from one view of the fold |
| `src/divergence/` | B3: the divergence watchdog's differ, pure (records in, report out); `tira divergence` reads its inputs (below, "Divergence watchdog") |
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
| **Versioned rules** | Every event the write path appends carries the rules era it was decided under (`metadata.era`), and replay judges each event by its own era's tables, so a rule change governs new writes only and never rewrites history (ruling 2026-10-20). Events with no era were written before the marker: the legacy era (1), replayed under the tables as first built (`charts/eras/`, frozen and hash-pinned); the page tags them "legacy". An era this build doesn't know is an anomaly. **Era 2** (2026-10-20): BLOCK needs a reason, and BLOCK's and REOPEN's reason must have text, not only spaces. **Era 3** (2026-10-21): a brief's VERIFIED_DONE needs a PASS (`dispatcherWithPass`: the dispatcher, and a `done_test_result` read through the same `verifies` as the drop's); eras 1 and 2 replay under the brief outcome table as first built (`charts/eras/brief-outcome.era1.json`) |
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
node scripts/tira.ts serve --actor isha                               # the page, live, on 127.0.0.1:4747: search and actions
node scripts/tira.ts idea "pagination would be good in table" --why "long tables scroll forever" --actor claude
                                                                      # an agent pushes an idea: tira drafts its file, says where it goes
node scripts/tira.ts ideas                                            # the stream's ideas: stage, parent, summary
node scripts/tira.ts link --repo acme/app --jira-site https://acme.atlassian.net --jira DOG --actor isha
node scripts/tira.ts connect-jira --email you@example.com            # asks for the API token, keeps it privately
node scripts/tira.ts sync                                             # PRs in, Jira issues out, people's Jira moves back
node scripts/tira.ts log                                              # raw log, rejections included
node scripts/tira.ts state                                            # entities, rejections, anomalies
node scripts/tira.ts replay 3                                         # state as of event 3
node scripts/tira.ts dump --hash                                      # sha256 of the canonical derived state
node scripts/tira.ts sweep                                            # health checks; exit 3 if something is broken
```

Store: the Postgres database in `$TIRA_DATABASE_URL` (or `--db URL`), in schema `$TIRA_SCHEMA` (default `tira`); see "Running on Postgres" below. `tira.html` is git-ignored.
Tree: `--stream` (default `$TIRA_STREAM`, else `tasktree-main`). `key=value` payload values
are strings; use `--payload '{"k":1}'` for other types. `--event-id` makes a re-send a
`duplicate`. Event names work in either form (`COMPLETE` or `complete`, `ADD_CHILD` or
`add-child`). `--json` on any command. Exit codes: 0 ok · 2 rejected by the rules · 3 the health
sweep found something broken · 1 usage/error.

### Running on Postgres (the only live store)

tira keeps its data in one Postgres database, hosted from day one (`packing.md` D11, D12;
`docs/decision-log.md`). Every command, `tira serve` and factory emission included, reads and
writes it; a SQLite file is refused, and nothing is made in the folder you ran from. Setting
it up, with Neon as the example: [`docs/hosted-postgres.md`](docs/hosted-postgres.md).

- **The connection string** goes in `$TIRA_DATABASE_URL` (your shell, or the repo's gitignored
  `.env`), not on the command line. Any standard Postgres string works; a database on another
  machine needs TLS: `sslmode=verify-full` (or at least `require`). tira never prints it.
- **`$TIRA_SCHEMA`** (or `?schema=NAME` on the string) picks a schema in that database, default
  `tira`: a demo or a trial gets its own, and they never touch each other.
- **People's accounts** live there too, beside the log (Isha, 2026-10-22): who may sign in,
  each person's GitHub and Jira links, sessions (as hashes), display names and tira's app keys,
  shared by everyone who runs `tira serve` on that database. Every token and secret is sealed
  (AES-256-GCM) with **`$TIRA_SECRET_KEY`**, which is never stored there: the database alone signs
  no one in. Set it to a long random string, the **same on every computer** (keep it with the
  connection string); without it `tira serve` won't start on Postgres. A computer's old
  `credentials.json` is brought over by its first `tira serve` (what the database lacks; nothing it
  holds changes). Jira API-token logins (`tira connect-jira`) and the page token stay on each
  computer.
- **Old SQLite logs** come over once: `tira import <file.db>` copies every event as it was (id,
  seq, stream, data, metadata, record time) into an empty schema, checks each stream's
  fingerprint before and after, and adds nothing when run again.

```
export TIRA_DATABASE_URL='postgresql://…?sslmode=verify-full'    # your hosted database (docs/hosted-postgres.md)
export TIRA_SECRET_KEY='<a long random string, the same for everyone>'   # seals people's tokens
node scripts/tira.ts create node dashboard --actor isha       # first use makes the tables and triggers, in schema "tira"
TIRA_SCHEMA=demo node scripts/tira.ts import ~/old/live.db    # once: an old log into its own schema, fingerprints checked
```

Tests need no network: they use SQLite in memory (or a throwaway file they open themselves). The
Postgres store's contract tests, the scenario suite and the ideas tests on Postgres, the import,
and the tests that run tira as its own process need a database: `TIRA_PG_URL=<a local or CI database> npm test`.
Without it they're skipped, and `npm run mutants` lists the Postgres planted bugs as not run;
CI runs everything against a throwaway Postgres service container (no secret involved). The
tests work in their own schemas and drop them after. A local Docker Postgres for that:
`docker run -d --name tira-pg -e POSTGRES_USER=tira -e POSTGRES_PASSWORD=<pick one> -e POSTGRES_DB=tira -p 127.0.0.1:5433:5432 postgres:17`.

In production the schema is made once by its owner; tira then connects as a login that owns
nothing and may only insert into and read the events table (and update its counter): the
triggers refuse edits, deletes and truncates, and not owning the table refuses a drop. The
accounts tables (`account_apps`, `account_access`, `account_github`, `account_atlassian`,
`account_names`, `account_sessions`) are the one place that login also updates and deletes:
the owner makes them once (the first `tira serve` with the owner's string does it; later runs
create nothing), then grants that login SELECT, INSERT, UPDATE and DELETE on those six, and
nothing more. Other systems sharing the database (the factory's own schema and roles) get no
rights on schema `tira`.

### Demo D0 script (manual test M0)

Run from this folder. Nothing derived is ever stored: every command, including `dump`,
replays the raw log from scratch. So step 4's "wipe derived state, replay" is shown by
replaying in a fresh store that holds only a copy of the raw log, and comparing hashes.

```
export TIRA_SCHEMA=demo_d0                                                 # a schema of its own in your database
node scripts/tira.ts create node a && node scripts/tira.ts create node b && node scripts/tira.ts create node c   # 1
node scripts/tira.ts send node a START && node scripts/tira.ts send node a COMPLETE evidenceRef=proof.png        # 2: a -> done
node scripts/tira.ts send node b START && node scripts/tira.ts send node b COMPLETE                              # 3: REJECTED, exit 2
node scripts/tira.ts log                                                   # 3: command.rejected row in the log
node scripts/tira.ts state                                                 # 3: ...and b is still in_progress (never applied)
node scripts/tira.ts dump --hash                                           # 4: hash of the derived state, replayed from the raw log
node scripts/tira.ts dump --hash                                           # M0 re-run: replayed again from scratch, identical
```

M0 passes when both hashes match and the `command.rejected` row is in the log but `b`
never reached `done`. Pick a new `TIRA_SCHEMA` to start over. Stores written before C1 hold
`node.created` births, which now show as anomalies: start them over.

### Demo D1 script (manual test M1): S3 backtrack, visible — tira closes the branch

```
export TIRA_SCHEMA=demo_d1 TIRA_STREAM=tasktree-dash TIRA_ACTOR=isha
t() { node scripts/tira.ts "$@"; }
t create node dashboard && t create node metrics_card --parent dashboard
t create node fetch_metrics --parent metrics_card && t create node improve_visual --parent metrics_card
for n in colors loading_state font; do t create node $n --parent improve_visual; done
t create node table --parent dashboard && t create node filters --parent dashboard
t send node fetch_metrics START && t send node fetch_metrics COMPLETE evidenceRef=api.md
t send node colors START                                                                    # interrupted: the wait becomes a ticket
t create node design_tokens --parent colors kind=discovered discovered_during=colors
t send node colors BLOCK blocker=design_tokens "reason=waiting on the design-token decision"
t send node design_tokens START && t send node design_tokens COMPLETE evidenceRef=token-spec.md
t send node colors UNBLOCK && t send node colors COMPLETE evidenceRef=palette.png          # resumed
t send node loading_state START && t send node loading_state COMPLETE evidenceRef=spinner.mp4
t send node font START && t send node font CANCEL                                          # improve_visual drains
t tree                                                                # cursor: table; improve_visual waits for tira
t send node table START                    # moving on: tira closes improve_visual, then metrics_card, citing this
t render --out d1.html && t tree && t dump --hash                     # both parents "closed by tira"; drain climbed
```

M1 passes when the page (`d1.html`) shows every node from `t dump` exactly once with the
same state, drain flag, cursor (the ◆ pin) and active task (the ringed node), on the board's
Graph style. The chip at
the top right shows the hash; hover it, or open **History**, for the full value, which
must equal `t dump --hash`. The page's `data-node-count` must equal
`data-fold-tree-count`. Parents tira closed carry tira's mark (a bolt). Click any task to open its
dialog and history; tira's entries say why and which move they cite. Closing the branch
took no clicks beyond moving on to `table`.

Above the views, **Needs attention** lists what is blocked, grouped by the reason it was
blocked with, and what is being worked on, each one click from its dialog. Blocking a task
needs a reason with text, like re-opening one (2026-10-20). A finished active parent isn't
counted: there is nothing to decide, and tira closes it when work moves on. A "?" in the top
bar (and the hash chip, labelled "fingerprint", at the foot of the page) opens a three-paragraph
guide inline. The header is the workspace's name and one line of counts ("3/5 done · 2 left");
a count that is zero stays out (Apple's guidelines: only what's needed at a glance).

The page has three views:

| View | Shows |
|---|---|
| **Board** (default for a tree) | One view in two styles, switched in its own bar (CSS only; `tira serve` remembers the choice per browser). **Kanban** (the default): Jira-style status columns, every ticket a card naming its parent; ◆ marks the next task. Live, a card drags to another column, as in Todoist: To do → In progress starts it at once, every other move opens its decision (In progress → Done asks for the proof of work), and a move the rules don't allow dims its column and leaves the card where it was. An untouched grouping parent (to do, with subtasks) stays on the Graph; started, blocked or closed, a parent is a card too, with "1/3 subtasks" closed (so a task blocked on a new ticket stays on the board, in Blocked). **Graph**: the whole tree, top-down, a parent centred above its children; each node is coloured by state, a line turns green once its child is closed, a parent says what's left ("2 left"), and its state once none is, and a dotted line joins a task to the one it was found while working on. A dashed ring means tira closes it when you move on; a bolt means tira closed it. Big trees stay narrow: in a tree of more than 40 tasks the lowest branches hang as indented columns (212 tasks: about 4,800 px across, not 20,000). Live, the graph is a canvas you move like Figma or Excalidraw (drag or scroll to pan, pinch or ⌘/Ctrl + scroll to zoom, Fit, ◆ Next, full screen) and fold: the button under a parent hides its branch ("+N", red when a blocked task is inside); Collapse done folds every finished branch. Folds and the view survive the reload after every action The header counts tasks closed of all tasks, and how many are left |
| **Lanes** (default for the factory; shown only when the stream has something for it) | Each brief's regions side by side, sessions, drops and ideas, handoff pairs, what's waiting (D2, below) |
| **History** | The whole log, newest first, including rejected commands, anomalies, legacy tags, other entities and the full hash: the audit trail |

Words live in the task dialogs, not on the canvas: a click on any task (a card, a node, a
row) opens a dialog over the page, never a side panel or a new page. It closes with ×, a click
on the dimmed page behind it, or Esc (live). The page follows the system's light or dark
setting, or the System / Light / Dark switch at the top right (CSS only; `tira serve`
remembers the choice per browser). The look is Jira's: white or near-black surfaces, Jira
blue as the one accent and muted status colours (green done, blue in progress, red blocked,
amber waiting). It is self-contained (no JS, fonts or scripts from the network; tabs and dialogs
are CSS), so the bytes still depend only on the fold. The only motion is the dialog
fading in, and it turns off for reduced motion. Print is always light.

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
- A change to a transition table ships as a new rules era (versioned rules, above): older
  history replays under the rules it was written under. The tree's caps and gates live in
  code, not tables, and aren't versioned yet: changing those later would still turn older
  history into anomalies. Treat them as part of the log's contract.
- Entities are created by an explicit `create` command at their tables' initial states;
  an `eventId` names one command (same id + same content = duplicate, same id + different
  content = error); malformed commands throw rather than being logged; `eventId` is globally
  unique, so re-using one in another stream throws; `subscribe()` is at-least-once with an
  `onError` hook.

## Code — Track B1: the factory tables (signed off 2026-10-17) + D2 lanes

Five tables in `charts/`, hand-authored as signed off (A1–A15; A8 and A13 still open):

| Entity | Identity | Regions (initial first) | Born as |
|---|---|---|---|
| brief | `brief_id@version` | **gate** ungated · gated · denied — **claim** waiting · unclaimed · claimed-silent · claimed-active — **outcome** open · dropped-unverified · done-verified · blocked | `brief.created` (v1), `brief.revised` (v2+) |
| session | stable id | lifecycle: live · ended | `session.named` |
| drop | `brief_id@version` (one per version) | lifecycle: filed · verified · rejected | `drop.filed` |

Every guard reads only the payload, the actor, its own entity and its **own** region's
captured data: **0 cross-region guards**. A test also checks the guards' source never
touches the view or names another region's state. `npm run scan` runs the region scan on
each composition (node + idea; the factory's five), and `npm run check` includes it. The
brief composition is declared in `charts/compositions.json`: its grain, its correlation
convention, and Devansh's 10 allowed configurations. The tests read the 10 from there,
reach every one, and check random commands never leave them.

| Core change | What it does |
|---|---|
| C1 birth names | Per type and version: `brief.created` / `brief.revised`, `session.named`, `drop.filed` (`node.born` already) |
| C2 birth guards | The orchestrator creates briefs (`blocked_by`: distinct ids, never itself); a session names itself; drops are filed by sessions, not roles |
| C3 captured data | A table pair can `capture` payload fields into its own region (claimant, block_reason, a session's name); guards read only their own region's |
| C4 handoffs | `src/fold/handoffs.ts` + `src/write/dispatcher.ts`, below |
| C5 versions | v2+ needs the version before it and supersedes it; a superseded version takes no more events, and no drop is filed or verified on it (drops follow their brief's versions) |
| C6 history-aware predicates | **Not built**: it serves liveness, and the SLA and vantages (A13) are still open |

**Dependencies and the frontier.** `blocked_by` is a second graph (b0 mapping G7). Every
brief birth and revision is checked against it, and one that would close a loop is
rejected (`cycle`), with the loop spelled out: `blocked_by would loop: a → c → b → a`.
Forward references are fine until they close a loop, and a revision replaces its old
version's edges. The **frontier** (G9) is what sessions can claim now: current briefs
that are gated, unclaimed and open, with every `blocked_by` verified, in birth order.

"Open" is one condition more than the factory vocabulary's rule (gated, unclaimed, every
dependency verified), so blocked work is never offered. It is flagged for the PM. The
dispatcher lifts a dependency block (H6) before it makes the brief claimable (H1), so the
two rules agree on every log the write path produces.

- `tira state` prints it as "claimable now".
- The fold reports it per stream (`frontier`), plus each brief's `waitingOn`.
- The Lanes view marks frontier briefs **claimable now**, and briefs still waiting on dependencies with what they need.

**Handoffs (the only coupling).** After each command, the dispatcher writes every
receiver that is due, as the reserved actor `dispatcher`. Each carries `correlationId` =
the first event of the pair and `causationId` = the event that made it due.

| Rule | When | Writes |
|---|---|---|
| H1 | a brief is dispatched and every `blocked_by` brief has a verified drop | `brief.claimable` |
| H2 | the claimant files the drop for an open brief | `brief.evidence` (if silent), then `brief.drop-written` |
| H3 | the orchestrator verifies the drop | `brief.verified-done {done_test_result}`, which the outcome table takes only with a PASS (rules era 3) |
| H4 | the orchestrator rejects the drop | `brief.blocked {block_reason: defective}` |
| H5 | a session ends | `brief.released` for open briefs it held |
| H6 | a dependency-blocked brief's dependencies are all verified | `brief.unblocked` |
| V1 | an idea is declared with a summary (`tira idea`) | `idea.draft-file {summary, why}`: its file, drafted from what it said |
| V2 | an idea's file is approved, and the file has a summary | `idea.propose-node {parent_id?, candidates, basis}`: where tira would put it, or no parent and the candidates when a person must pick |
| F1 | an idea is approved into a node (materialized) | `node.born {idea_id}` (same id) |
| relay | the orchestrator sends `BLOCKED` on a gated brief | `brief.blocked {block_reason, requested_by}`, or a logged `handoff-refused` |

The rules are pure over the folded state, and each turns false once its receiver lands.
Each receiver is re-checked as "still due" at the moment it is written, inside the
stream's write queue, so two commands finishing at once can't write it twice. A crash
between the two halves of a pair just leaves it due: the next command finishes it, and
so does a retry of the same command with the same `--event-id`, or `Dispatcher.catchUp`.
Replay re-checks every dispatcher write against the rules (with its correlation id) and
flags anything else as an anomaly. `tira state` and the page list handoffs still waiting,
and why: dependencies, a stray drop for the orchestrator, a verified drop its brief
can't take, or an idea whose node id is taken. The list is pull-only: whoever writes
factory events checks it (a requirement on the writer, per the PM's 2026-10-18 reply).
Waiting is a legitimate state, not an error.

### Demo D2 script (manual test M2): regions composed, handoffs paired

```bash
export TIRA_SCHEMA=demo_d2 TIRA_STREAM=factory-main
t() { node scripts/tira.ts "$@"; }
t create session s1 --actor s1 && t create session s2 --actor s2
t create brief api --version 1 --actor orchestrator slice_ref=slice/api
t create brief ui --version 1 --actor orchestrator --payload '{"blocked_by":["api"]}'
t send brief api DISPATCHED --version 1 --actor orchestrator      # + dispatcher brief.claimable (H1)
t send brief ui DISPATCHED --version 1 --actor orchestrator       # waits: api isn't verified yet
t send brief api CLAIMED --version 1 --actor s1 session=s1        # claimed-silent
t send session s1 ENDED --actor vm declared_by=mac-evidence       # REJECTED: a VM can't end a session
t create drop api --version 1 --actor s1                          # + evidence, + drop-written (H2)
t send drop api VERIFIED --version 1 --actor s1 done_test_result=PASS            # REJECTED: the filer
t send drop api VERIFIED --version 1 --actor orchestrator done_test_result=PASS  # + verified-done (H3), + ui claimable (H1)
t state && t render --out d2.html && t dump --hash
# the idea -> node handoff (F1), in a tree stream: the same id on both sides
export TIRA_STREAM=tasktree-ideas
t create node dashboard --actor isha
t create idea metrics_card --actor isha
for e in DRAFT_FILE APPROVE_FILE PROPOSE_NODE; do t send idea metrics_card $e --actor isha; done
t send idea metrics_card APPROVE_NODE --actor devansh parent_id=dashboard   # + dispatcher node.born on node:metrics_card (F1)
t tree && t render --out d2-ideas.html
```

M2 passes when:

- `npm run scan` exits 0 (both compositions);
- the page opens on **Lanes**, with each brief's gate, claim and outcome matching `t state`;
- every handoff pair shows the same correlation id on both sides (`data-correlation` on the page, `correlationId` in `t log --json`), including idea `metrics_card` → node `metrics_card` on the `tasktree-ideas` page;
- anything still waiting is listed with its reason.

**Calls made while building B1.** The PM confirmed calls 1–7 on 2026-10-18, each checked
against the signed tables, and ruled on the 8th (the two holes, closed below).

- **H2's failure branch.** The draft had the dispatcher append `drop.rejected` for a drop
  its claimant didn't file. The signed-off drop table lets only the orchestrator reject. I
  kept the table: such a drop waits in the pending list for the orchestrator.
- **`dispatcher` is a reserved actor**, like `tira`. Orchestrator, mac and user stay plain
  actor ids (A15).
- **Block requests.** The dispatcher relays the orchestrator's `BLOCKED`:
  - `defective` comes only from H4;
  - `verdict` and `retries-exhausted` need a claim;
  - `dependency` needs an unverified `blocked_by`.

  Refusals are logged under the orchestrator as `handoff-refused`.
- **A dependency counts as verified** when any version of it has a verified drop. A
  superseded version can't take a drop at all (drops follow their brief's versions), so
  only a drop on a version that was current at the time counts.
- **F1 naming.** F1 births the node with the idea's id. A parent can come from the
  approval's `parent_id`; if that parent doesn't exist yet, the birth waits.
- **F1 trigger.** The idea table reaches `materialized` through its `APPROVE_NODE` event
  (stored `idea.approve-node`), so that is the trigger. The ruling's
  `idea.materialized {idea_id}` names the state it reaches.
- **The two holes, closed (ruling 2026-10-18; tables to be re-signed):**
  - A brief is claimed, and a drop filed, only by a **named session**. A never-named
    session could hold a brief forever, because nothing could end it to release the brief.
    This is an identity check declared on the type (`mustExist`), like drops following
    their brief's versions, so table guards still read no other entity. A claim for an
    unnamed session is refused as `unknown-ref`, and replay flags one that bypassed the
    write path.
  - `RENAMED` is guarded: only the session itself, the orchestrator, or Mac evidence
    (`renamedByAllowed`). It stays a logged no-op that records the name, so the rule
    engine now allows a guard on a no-op (never on a denied pair).
  - A regression test pins the order: a drop filed while its session ends mid-handoff
    goes through (H2 runs before H5), and the brief isn't released.

## Factory event writing (B2, ruling 2026-10-19): tira's side

The factory's gate scripts write the tira event as part of every state transition, in the
order guard → emit → apply, fail-closed (`emit-or-halt`). The factory side (the `tira send`
calls, the outage journal, and the check that no script drops its emission) is the PM's.
This is what tira provides:

**The fx: key rule** (`src/write/fxkey.ts`). A transition's event id is:

```
fx: + lowercase hex sha256( UTF-8 bytes of canonicalJson({ stream, entity, event, actor, payload }) )
```

| Field | Rule |
|---|---|
| `stream` | The stream the event is sent to |
| `entity` | `{ type, id }`, plus `version` exactly when the type is versioned (brief, drop). tira refuses a versioned type without one and an unversioned type with one |
| `event` | The table event (`DISPATCHED`). For a birth, the type's birth name: `CREATED` for brief v1, **`REVISED` for v2 and later**, `FILED`, `NAMED`, `RECORDED`, `INVOKED` |
| `actor` | The trigger, or `null` |
| `payload` | The payload as sent, or `{}`. With `tira send`, `key=value` pairs are strings and `--payload` keeps JSON types, so `n=1` and `--payload '{"n":1}'` are different payloads with different keys |

`canonicalJson` is `JSON.stringify` with no spaces after keys are sorted at every level by
**UTF-16 code units**, so:

- strings are not ASCII-escaped (`café` stays `café`);
- numbers are written the way JavaScript writes them: `1`, `0.1`, `1e+21`. A float that
  holds a whole number is written `1`, never `1.0`;
- keys sort by code unit, not code point: `😀` (U+1F600, units D83D DE00) sorts before `ﬁ`
  (U+FB01). Python's `sort_keys=True` sorts by code point and gets this wrong; sort by
  `k.encode("utf-16-be")` instead.

The same transition always gives the same key, so a crash-retry returns `duplicate` and
never writes a second row. tira **recomputes the key of every fx: id it is sent** and refuses,
before anything is stored, an id that isn't its own transition's key (the error gives the
right key). An fx: id that isn't `fx:` + 64 lowercase hex is refused the same way.
`tira key <type> <id> [EVENT] [key=value ...]` prints the key, with the same flags as `send`
and the same checks send can make without a log. It never opens the store. The page marks
fx: rows **auto** in the history.

Test vectors (`test/factory.test.ts` checks every line):

<!-- fx-vectors -->
```jsonl
{"key":"fx:c0b1bc5ca1d107f2884f25c764d23a073d6357eff51e8b7d4d319381e10fb420","transition":{"stream":"factory","entity":{"type":"brief","id":"b","version":1},"event":"DISPATCHED","actor":"orchestrator","payload":{}}}
{"key":"fx:404c3f7f6ec88759b69783852248f6d0b6a1c666525b67345dc17a43ec64f181","transition":{"stream":"factory","entity":{"type":"session","id":"s1"},"event":"NAMED","actor":null,"payload":{}}}
{"key":"fx:cb9f7a132754bf7a0d077c6bc8e5e503595cdcb11404d80b1dcd96c55e9c87a9","transition":{"stream":"factory","entity":{"type":"brief","id":"b","version":2},"event":"REVISED","actor":"orchestrator","payload":{"supersedes":1,"blocked_by":["a"]}}}
{"key":"fx:b6ddc9204e17def3b9022fb7a62dc9e8346c1ca0581b29d4d01e743d3d5799a7","transition":{"stream":"factory","entity":{"type":"brief","id":"b","version":1},"event":"CLAIMED","actor":"s1","payload":{"session":"s1","n":1,"x":0.1,"big":1e+21}}}
{"key":"fx:54977adf80a5bee8740d47c90f0f62508fd9d0ca4e430457e526104ce8b60913","transition":{"stream":"factory","entity":{"type":"brief","id":"b","version":1},"event":"DENIED","actor":"orchestrator","payload":{"ﬁ":"café","😀":"b","Z":"z","a":"a"}}}
```
<!-- /fx-vectors -->

**Refusals and overrides** (`charts/refusal.json`, `charts/override.json`):

| Event | Rule |
|---|---|
| `refusal.recorded` | A transition refused while tira was unreachable, reconciled from the factory's journal on recovery. The refusal's **id** is the refused transition's fx: key. It names the transition (type, id, version, event), the reason and when it was journaled, and is recorded under that transition's actor (its trigger). Every factory guard checks the actor, so a transition with no actor could never have been legal and has no refusal |
| `override.invoked` | Per incident, by an operator (the user or the orchestrator), with a reason. It lasts at most **4 hours** (`expires_at` − `invoked_at`) |
| `override.expired` | Recorded by an operator or Mac, with `expired_at`, no earlier than `invoked_at`. A repeat is a no-op for the same people and refused for anyone else |

**Reconciling an outage.** The refusal row's own event id is the key of the refusal's own
transition (`tira key refusal <K> --actor <trigger> --payload '<the refusal payload>'`),
never `K`. `K` is the id the refused transition needs when it is sent again once tira is
back; reusing it for the refusal is refused at once. Reconciling twice is a duplicate.

**Times** (`src/time.ts`) are strict ISO-8601 date-times with a zone: `Z` or `±hh:mm`, as in
`2026-10-19T09:30:00Z` or `2026-10-19T15:00:00.250+05:30`. A time with no zone, an impossible
date (`2026-02-30`) or `T24:00` is refused. tira parses them itself, so a guard gives the same
answer in every time zone and replay can't drift.

**Flags.** An override still active past `expires_at` is `overdue` (`tira state --now …`).
One whose `expired_at` is after `expires_at` is `late`: the log records its own violation.
`late` trusts the factory's `expired_at`, since an expiry journaled during an outage is
recorded after the fact. Both show in `tira state` and `tira dump`, not on the page yet.

Both are declared in `charts/compositions.json` and scanned with the factory composition.
The watchdog (the divergence report) is the next step, not this one.

**Calls made here, for the PM:**

- A refusal is recorded under the refused transition's own actor (its trigger). There is
  no separate "factory writer" actor, and no refusal for a transition with no actor.
- Overrides are invoked by the user or the orchestrator; expiry is recorded by an operator
  or Mac.
- tira checks an fx: id's **hash**, not just its shape. The key covers only what tira is
  sent, so tira can recompute it, and a wrong key fails at the factory's first send.
- Times need a zone. The factory must send `Z` or an offset.

## The page, live: `tira serve` (the D1 UI brief, 2026-10-19)

`tira serve [--actor NAME] [--port N]` serves the page on **127.0.0.1 only** (default port
4747). Without `--actor`, people sign in with GitHub first ([the way in](#workspaces-linked-to-git-and-jira)). Every request folds the log, as `tira render` does, and adds what only a live page can
have:

| Piece | What it does |
|---|---|
| **Actions on needs-attention rows** | Unblock a blocked task; complete or block the one in progress |
| **Actions in a task's dialog** | By its state: start, complete, block, unblock, cancel, reopen, and **add subtask** (a new task under it, marked as found while working on it with `kind=discovered`) |
| **⌘K search** | Find any task in a few letters (name, prefix, initials, a word inside it; a space matches `_`) and open its dialog. Type a verb first to act: `start`, `unblock`, `complete`, `block`; `unblock ` lists every blocked task. After ≤ 3 letters a task is among the visible matches (the first 8): first on the demo, not always first on a 100-task tree of look-alike names |
| **Decision dialog** | Every human input opens a decision over the page, never a new page, in two views. **tira recommends** (read-only): Decision (the work in a nutshell: the task, why and since when it is blocked, its subtasks, its proof, the move, what tira closes first), Recommendation (from the facts: "api is done now, so the wait looks over", "next in order is fetch_metrics", "Don't run it: tira will refuse"), Tradeoffs, Best practice, Kind and the rule, then tira's check and **what to do** instead of a refusal. **Your action — edit before sending**: the action as a tira command, filled in (`tira send node colors UNBLOCK`; empty quotes where a value is yours: `evidenceRef=""`, `reason=""`), editable, plus an optional `note="…"` the history keeps; the same text runs in a terminal. To block, name what it waits on: the command becomes two lines, a new ticket created under the task (found while working on it) and the block naming it as `blocker=` (or one line for an open task picked as the blocker); the two are linked everywhere ("Blocked by" / "Blocks" in their dialogs, "waiting on" and then "ready to unblock" in needs attention, a red line on the Graph, a "blocks" chip in Kanban). Reasons used before (to re-open) are chips. To complete, the proof of work has its own field, filling in `evidenceRef` as you type; a merged pull request linked to the task is a chip. The command is read strictly: a value left empty, another task or verb than the one opened, a stray key or flag, something tira would refuse, or a moved log comes back into the dialog with your text kept, and nothing is written (`tira-docs/components/confirm-page.md`) |
| **Ideas** | An idea an agent pushed waits in the board's **Ideas** column and, on the Graph, as a dashed **ghost card** under the task tira proposed for it (on the top row until then). Its dialog offers its stage's two approvals through the same decision dialog: approve or reject the **file**, then approve (parent editable, tira's proposal filled in) or reject the **placement**. Below: [Ideas to tickets](#ideas-to-tickets-d5-the-vapor-catch-tira-idea) |
| **Result** | After an action the page says what happened (a refusal of a post that skipped the dialog is in the log too). It shows once |
| **The guide** | Opens by itself on the first visit (once per browser), then only from the link or the chip |

Safety:
- Any `Host` other than 127.0.0.1 or localhost is refused (DNS rebinding).
- A write needs this tira's random token (made once and kept in the private store, so a page opened before a restart still works), and refuses a foreign or `null` `Origin` (cross-site forms).
- The actor is the person signed in with GitHub. Started with `--actor NAME`, it is NAME until GitHub sign-in is set up; `tira`, `dispatcher` or `sync` (any spelling) is refused at start. No one who can act: every page leads to the sign-in page, and a write is refused.
- Sign-in: the session cookie is HttpOnly and SameSite=Lax; a Jira sign-in must come back to the person who started it, within ten minutes; a form can send you back only to tira's own steps.
- Only the page's verbs (start, unblock, complete, block, cancel, reopen, add subtask) on tree tasks, and an idea's approvals (approve or reject the file, approve or reject the placement) on ideas, are accepted, as fields or as a command in the CLI's syntax with only the keys the verb uses (plus `note`); a subtask name is trimmed, 1–80 characters, no control characters.
- A strict Content-Security-Policy allows only the server's own scripts (app.mjs and the modules it loads: rank, theme, graph, layout; signin.mjs on the sign-in page).

The checkpoint page from `tira render` stays as it was, with no script and the same bytes for the same log.

Component docs live in `tira-docs/components/` (attention section, palette, confirm page,
board, ideas, workspace bar, the way in, Integrations page, task dialog, hash chip, lanes, onboarding). `test/docs.test.ts` checks every DOM hook they
name exists in the build.

Calls made here, for the PM:

- **Every action passes the decision dialog**, START included. The brief's "permission-only
  blocks stay one click" has no case among the task verbs: each can trigger tira's closes or
  needs a field.
- **"Stale" is left out of needs attention** until the time limit is ruled.
- **Blocking needs a reason with text** (Isha's call; re-signed 2026-10-20): `BLOCK` is
  guarded from unstarted and in progress, and BLOCK's and REOPEN's reason must have text, not
  only spaces (`hasReasonText`); the page's block form asks the same. A repeat block on a
  blocked task stays a no-op. **Older logs don't change:** this is rules era 2, and a log
  written before it replays under the legacy era, so its bare blocks fold as they did,
  tagged "legacy" on the page. The idea table's reject reasons still use the legacy check
  (`hasReason`: any non-empty string), since the ruling named BLOCK and REOPEN.
- **Referrer-Policy is `same-origin`**, not `no-referrer`: under `no-referrer` browsers send
  `Origin: null` on form posts, and the page's own writes were refused (found by submitting
  a real form).

## Ideas to tickets (D5, the vapor catch): `tira idea`

Good ideas surface in chat and die there. Here an agent pushes one in a sentence, and it
becomes a task after two approvals, with tira doing the steps in between ("S5 · The Vapor
Catch" in `demo/demo-deck-v6.html`; the rules table is `charts/idea-lifecycle.json`,
unchanged).

```
tira idea "<summary>" --why "<why>" [--under TASK] [--id ID] --actor NAME [--json]
```

1. **Push.** The agent runs `tira idea`. tira declares the idea (its id comes from the
   summary, minus filler and its parent's name: "pagination would be good in table" is
   `pagination`; it must be free as an idea and as a task, since the task keeps it) and, as
   the dispatcher, **drafts its file** from the two lines (V1). The command prints where tira
   would put it and what happens next, so the agent can tell the person.
2. **Approve the file** (a person, on the page). Anyone may approve, the declarer too.
3. **tira proposes the placement** (V2), on the tree as it is at that moment. The parent
   comes from two sources together: the task named with `--under`, and the tasks the summary
   names (by id, `metrics_card` reads as "metrics card", plurals count, a task drops out when
   one under it is named too; the why counts only when the summary names nothing). A
   candidate must be able to take the new task (it exists, isn't done or cancelled, the caps
   allow it). When the two agree, or only one gives a usable task, that task is proposed.
   **When they disagree, or neither gives one, the proposal names no parent** and lists the
   candidates: the person picks when approving.
4. **Approve the placement** (a person). The command opens with tira's parent filled in,
   editable (`parent_id="table"`), or empty with the candidates as buttons. The parent is
   checked before anything is written: it must exist and take the task, and the idea's id
   must not already be a task.
5. **The task is born** under that parent, with the idea's id, to do (F1, as before).

A reject (of the file or the placement) needs a reason (the table's `hasReason`) and drops
the idea. **Stage skips are refused live in the dialog**, in plain words, with nothing
written: approving the placement while the file is pending says "the file isn't approved
yet, and the placement comes after the file", and what to do instead. The rules still
decide (`tira send` of the same command is rejected and logged, exit 2).

`tira ideas [--json]` lists the stream's ideas with their stage, parent and summary, so an
agent can check on what it pushed.

### Demo D5 script (manual test M5): idea → task, end to end

```
export TIRA_DB=d5.db TIRA_STREAM=tasktree-dash
t() { node scripts/tira.ts "$@"; }
t create node dashboard --actor isha && t create node table --parent dashboard --actor isha && t create node filters --parent dashboard --actor isha
t idea "pagination would be good in table" --why "long tables scroll forever" --actor claude   # + dispatcher idea.draft-file (V1); parent: table
t send idea pagination APPROVE_NODE parent_id=table --actor isha   # REJECTED denied: a stage skip, in the log, exit 2
t send idea pagination APPROVE_FILE --actor isha                   # + dispatcher idea.propose-node (V2): under table
t send idea pagination APPROVE_NODE parent_id=table --actor isha   # + dispatcher node.born (F1)
t tree && t ideas
t serve --actor isha --port 4747   # or do the approvals on the page: Ideas column, ghost card, the dialogs
```

M5 passes when the skip is in the log as `command.rejected`, the chain
`idea.created → idea.draft-file → idea.approve-file → idea.propose-node → idea.approve-node →
node.born` is unbroken with matching correlation ids (Lanes shows the three pairs), and
`pagination` is a to-do task under `table`. `rm d5.db` to start over.

Calls made here, for the PM:

- **tira writes the draft and the proposal as the dispatcher** (V1, V2), so replay checks
  each one like any handoff. Both happen only for an idea declared with a summary: an idea
  created bare (`tira create idea 7`, as the engine scenario S5 does) is still driven by hand.
- **The proposal is made when the file is approved,** not when the idea is pushed: the tree
  may have changed in between. Until then the ghost card sits on the Graph's top row.
- **Ideas waiting for an approval are not in "Needs attention"** yet; they are in the Ideas
  column. Aging and the overdue-idea alarm wait for the approval deadline to be ruled.
- **A task born from an idea shows as hollow in the sweep** (no `definition` or
  `done_criteria`): the idea's file is a summary and a why, not those two fields.

## Agents through MCP: `/mcp` and `tira mcp`

Claude Code, Cursor, VS Code, Claude Desktop or any MCP client can work a project's tasks directly, each agent with its own token, which names the project and the agent. Nothing connects by default. In **Project settings → Connect agents**, three steps: choose your app, name your agent (its token is made then), and do the one thing step 3 shows in that app (Cursor's and VS Code's **Add to** button, which asks first; Claude Code's command; Claude Desktop's config entry), then **Test connection**. Claude's own Connectors reach a connector over the internet, so they add tira at its public address (Hosting tira on Render, below); on this computer they can't. Only the token's fingerprint is kept, and **Revoke** there stops the agent at its next call.

Claude Code, Cursor and VS Code reach `tira serve` itself, at `http://127.0.0.1:<port>/mcp`, with the token in an `Authorization: Bearer` header: it answers on 127.0.0.1 only, while `tira serve` runs. Claude Desktop can only start a program, so it starts `tira mcp`, an MCP server on stdio with the token in `TIRA_AGENT_TOKEN`, which reads the database as every tira command does (tira's own `.env`; the section says whether it would reach this board). Claude Code's, for example:

```bash
claude mcp remove tira-factory-ui -s user 2>/dev/null; claude mcp add --scope user --transport http tira-factory-ui http://127.0.0.1:4772/mcp --header 'Authorization: Bearer <token>'
```

| Tool | What it does |
|---|---|
| `next_task` | The task in progress, the next one in tira's order, how many are blocked, what's assigned to the agent and feedback it hasn't answered |
| `list_tasks` | The board's tasks in order: id, state, where each sits; open ones unless a state is asked for |
| `get_task` | One task: its ticket (title, description, steps, estimate, assignee), state, place, subtasks, why it's blocked, its commits, comments, proof and history |
| `start_task` | Moves a task to In progress (one at a time: tira says which to finish first) |
| `complete_task` | Done, with a commit or pull request of the project's GitHub repo as proof (checked on GitHub) |
| `block_task` | Blocked, with a reason, waiting on an open task or on a new ticket made under it |
| `add_subtask` | A new task under one, found while working on it when that one is under way |
| `file_idea` | An idea for later: tira drafts it and proposes where it goes; a person approves |
| `add_comment` | A reply on a task's comments, shown on its ticket |
| `fill_ticket` | Writes a ticket's title, description, steps and estimate as the agent; what it leaves out stays. Who it's assigned to stays a person's to say |

Every write goes through the same dispatcher and rules as a person's, under the agent's name, and a refusal comes back with what to do. An agent's name must read as an agent's (`claude-…`, `codex-…`, `…-agent`, `…-bot`), never a person's, so the board marks its moves with the agent spark. There is no tool to cancel, reopen, unblock, delete or change settings: those stay with people. At tira's public address (below), Claude's own Connectors add it too: claude.ai, Claude Desktop and mobile sign in with OAuth, and the person picks the project and approves.

## Hosting tira on Render

One shared tira at an https address, so everyone (and Claude's Connectors) reaches the same board. `render.yaml` is the service: Node 22, `npm ci`, `tira serve`, one always-on instance (Starter: Claude gives a connector 10 seconds to answer, and a Free service sleeps), Render's own check at `/healthz`.

Setting `TIRA_PUBLIC_URL` turns on public mode (`src/serve/public.ts`). tira then:
- listens on every address at `$PORT`, and answers only that address;
- builds GitHub's and Jira's way back from it;
- marks its cookies Secure, and keeps browsers to https;
- shows nothing to anyone signed out.

It won't start until it's safe. It needs:
- `TIRA_DATABASE_URL` (Postgres, `?sslmode=require`);
- `TIRA_SECRET_KEY` (Render makes it);
- `TIRA_ADMIN` (the admin's GitHub login);
- `TIRA_GITHUB_CLIENT_ID` and `TIRA_GITHUB_CLIENT_SECRET` (a GitHub OAuth app whose callback is `<address>/signin/github/callback`).

There is no first-run setup for whoever arrives first, and no `--actor`.

Claude's Connectors (`src/mcp/oauth.ts`): tira is its own small OAuth server.
- **Discovery:** `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. A call to `/mcp` without a token gets a 401 pointing at them.
- **Registration:** open, as Claude registers itself. Only Claude's callback or this computer's are taken, and the client id is the registration, signed.
- **Approval** at `/oauth/authorize`: sign in with GitHub, pick the project and the agent's name, Allow.
- **Exchange** at `/oauth/token`: the code with its PKCE verifier (S256) gets the agent's own token, the same kind Connect agents makes. It's listed there and revoked there.

In Claude: Settings → Connectors → Add custom connector, with `<address>/mcp`.

## Workspaces linked to git and Jira

A workspace is one project: one task tree (a stream), linked to one GitHub repo and one Jira
project. tira leads and Jira mirrors; GitHub and Jira changes come in when someone syncs.

**On the page: the way in.** Start `tira serve` without `--actor` and open
`http://localhost:4747`. No commands to type:

1. **Landing.** What tira does, and **Continue with GitHub** (the look of debugAssist's sign-in
   page, in tira's colours). The first time on a machine it asks for tira's GitHub app first: a
   GitHub OAuth app (Enable Device Flow ticked; no secret needed), whose Client ID you paste in.
2. **Sign in with GitHub.** tira shows a short code (with Copy and Open GitHub); approve it on
   github.com and the page goes on by itself. From then on your changes are recorded as your
   GitHub login.
3. **Connect your project.** Pick the repo from your GitHub repos (needed). Jira is optional:
   **Connect Jira** (Atlassian's sign-in, at `localhost`; the first time, paste tira's Atlassian
   app's Client ID and Secret: an OAuth 2.0 app with callback
   `http://localhost:4747/integrations/jira/callback` and Jira scopes
   `read:jira-work write:jira-work read:jira-user`), then pick the project, or "No Jira project".
4. **Open the board**: Kanban, with Sync in the workspace bar.

**Who gets in.** The first person to sign in becomes this tira's admin. After that only the
admin and the people they add (by GitHub username, under People on Integrations) can sign in.
Anyone else is told who to ask: the admin's name and email, which the admin types in there
(kept in the private store, not in the code). Removing someone signs them out at once; their
GitHub and Jira links stay until they unlink them themselves (Account settings).

Until someone signs in, every page leads to the landing and nothing can be changed. Later
changes (another repo, Jira, Sync) are in **Project settings** in the sidebar (your accounts and
who gets in, in **Account settings**), where each choice
shows its `tira link` command under **Show the command**. `tira serve --actor NAME` still runs
without sign-in, as NAME, until GitHub sign-in is set up.

Tokens, app keys and the secret live in the private store, never in the history or on a page:
on Postgres, the accounts tables, each token sealed with `$TIRA_SECRET_KEY` ("Running on
Postgres"); with no database, a private file on this machine (`$TIRA_HOME/credentials.json`,
default `~/.config/tira`, readable only by its owner). Sessions are kept as hashes, so neither can
sign anyone in, and last 30 days.

**In a terminal** (and for agents), the same links without a browser:

```
tira link --repo OWNER/NAME --jira-site https://YOUR-SITE.atlassian.net --jira KEY --actor NAME
tira connect-jira --email YOU          # asks for a Jira API token without showing it, checks it, keeps it privately
tira sync [--json]                     # pull requests through the GitHub CLI (gh auth login)
```

- **Linking**: each change is a new version of the workspace's link, in the history, by the
  person who made it; an empty value clears that link.
- **A sync** (`src/sync/sync.ts`):
  1. links each recently updated pull request that names a task ("tira: <task>" in its title,
     body or a commit; a branch segment equal to the task's id; or the task's Jira key), and
     follows it to merged or closed; a merged one is offered as the proof when the task is
     completed;
  2. brings in the issues people made in Jira itself: each becomes a task, keeping Jira's
     structure (an epic above its issues, an issue above its subtasks), written as the person
     who made it in Jira, linked to its issue (now labelled "tira"), and brought to where it is
     in Jira: in progress started; done completed, with the issue's own link as its proof.
     Where tira can't follow (it keeps one task in progress at a time; a parent whose issues are
     all done is closed when work moves on), the report says so and Jira is left as it is;
  3. makes a Jira issue (labelled "tira") for every task that has none;
  4. brings back each move a person made in Jira as a command on the task, written as
     "jira:<their name>": In Progress starts, unblocks or re-opens it; Done completes it, with
     the merged pull request as its proof if there is one. tira's rules may refuse it (Done
     with no proof is refused): the refusal is in the history and in the report;
  5. moves an issue when its task moved in tira since the last sync, or when tira refused a
     person's move on it (to do: To Do; in progress or blocked: In Progress; done or
     cancelled: Done; "blocked" and "cancelled" as labels). Both sides are recorded (where the
     issue is in Jira, where its task is in tira), so neither is moved until one of them
     changes.
- **The board**: a workspace bar under the header (the links; live, Sync and Integrations),
  each task's Jira key on its card, and its Jira issue and pull requests in its dialog
  (`tira-docs/components/workspace-bar.md`, `tira-docs/components/integrations-page.md`).

Three record types hold it, beside the tasks (`src/tables/links.ts`, `charts/workspace.json`,
`charts/jira-issue.json`, `charts/pr.json`): the workspace's link, each task's Jira issue (with
the status category tira last set, so the next sync can tell a person's move from its own), and
each pull request linked to a task. Only the sync writes the last two, under its reserved name
`sync`.

Calls made here, for the PM:

- **The task table is untouched**; the three new tables need Devansh's sign-off.
- **A person's move is told from tira's own by the status category tira last set**, not by
  who made it: a Jira token acts as its owner, so tira's moves and the owner's look alike.
- **Ideas aren't mirrored** until they become tasks.
- **Jira's own issues come in** (Isha's call, 2026-10-22): keeping Jira's structure, done ones
  with their Jira link as proof. tira's one-task-in-progress rule still holds: on a board with
  several issues In Progress, the first comes in started and the rest as To Do, with Jira left
  as it is (the report says which).
- **Statuses are matched by category** (To Do, In Progress, Done), so any Jira workflow works;
  a workflow with no transition to the category needed is reported, not forced.
- **GitHub sign-in names people on the page only.** The CLI's `--actor` and the reserved
  `sync` stay names, not signed identities.
- **Jira sign-in needs `localhost`**, not 127.0.0.1: Atlassian sends people back to the one
  address its app names. The page at 127.0.0.1 says so.
- **Not yet**: webhooks (changes arrive on Sync), and switching workspaces on the page.

## Divergence watchdog (B3, PR-A): the factory's file state against tira's log

`tira divergence --factory FILE [--tira-log FILE] [--stream NAME] [--json]` gives one verdict
per fx: event id in either side: `OK`, `MISSING` (the factory committed it, tira has no
event), `PHANTOM` (tira has an fx: event the factory has no record of), `WRONG-ENTITY` (same
id, another entity or another kind), `DUPLICATE` (an id twice on one side) or `ORPHAN` (its
entity is born in neither file). Precedence: DUPLICATE > WRONG-ENTITY > ORPHAN >
MISSING / PHANTOM > OK. The differ (`src/divergence/divergence.ts`) is pure and its header
holds the per-id state table that defines it; `test/divergence.test.ts` walks every cell.

- **A set join on event ids.** Input order is never read and timestamps are never compared.
  tira's own dispatcher events (non-fx ids) are not divergences and are ignored. The
  watchdog never mints, repairs or re-keys an id: it only reports.
- **A rejected command is not an applied event.** `command.rejected` never gives birth: on
  an entity born in neither file it is ORPHAN, otherwise the factory's transition is MISSING.
- **Inputs.** tira's side is the store's `--stream`; `--tira-log` reads a log file instead
  (one stored event per line, as in `fixtures/b3/tira-log.jsonl`) and makes it a fixture run.
- **Coordinates and population.** Every report carries the factory snapshot (a fixture
  run: the git commit holding those exact bytes, or `unpinned` + their sha256 for a copy git
  doesn't hold; a live run: the sha256 the command computed over the bytes it read), the tira stream and `atSeq`, and how many
  factory records, tira fx: events and ids it read. Nothing is stored or cached.
- **Live runs are hashed by the run.** The command computes sha256 over the exact factory
  bytes it read and records it as the snapshot, in the report and the run-log row, so every
  live 0 can be re-run against the same bytes. It refuses (exit 1) in exactly two cases: the
  input cannot be read, so cannot be hashed; or a `FILE.sha256` sidecar sits beside it
  (`<hex>` or `sha256sum`'s `<hex>  name`) and disagrees with the computed hash (an
  integrity mismatch; a sidecar present but unreadable counts as one). No sidecar is not a
  refusal, and a matching one is accepted silently.
  Every live run appends one row to `docs/divergence-run-log.jsonl` (`$TIRA_DIVERGENCE_LOG`
  overrides the path): `{ts, factorySnapshot, stream, atSeq, population, counts,
  severityPolicy}`. Fixture runs log nothing.
- **Severity policy v1: warn-only.** Divergences exit 0. Exit 1 is a usage or input error
  only: an unreadable, empty or malformed input names the offending line and never prints a
  blank or zero report.
- `--json` prints the whole report; its `verdicts` map is the scorer's input:

```sh
npm run -s tira -- divergence --factory fixtures/b3/factory-state.jsonl --tira-log fixtures/b3/tira-log.jsonl --json > b3-run.json
node scripts/b3-score.ts fixtures/b3/manifest.json b3-run.json   # 47/47, bar met
```

**The panel (PR-B).** `renderHtml(..., { divergence })` in `src/render/html.ts` shows a
divergence section: the report the command emits, passed in by the caller that just
computed it (`{ report }`), or why it could not be (`{ unevaluable: reason }`). The renderer
never diffs, stores or caches — html.ts imports no differ. Three explicit states: divergences
(per-verdict counts plus the non-OK rows with their detail), clean (an explicit
"0 divergences"), and UNEVALUABLE (unreadable input, or a report missing its coordinates or
population, or one whose counts do not add up) — never a blank, never a bare 0. Coordinates
and population print with the counts. On the fixture pair the panel's counts and rows equal
the `--json` report (test/render.test.ts). One read + render at 2,795 tira events measured
17.8 ms against the spec's 1 s/read bar.

**Wired (render and serve).** `tira render --factory FILE` and `tira serve --factory FILE`
(default `$TIRA_FACTORY`) compute the report in the same process, at render time, with the
command's own adapters, live sha256 pin and differ, on the events the page shows (`render --at
N` judges up to N; `serve` recomputes on every page load). No factory file, or one that cannot
be read, renders the section UNEVALUABLE with the reason. No page reads the run log back, and
rendering appends nothing to it (test/cli.test.ts holds a poisoned-log regression).

## Scenario suite (build order C2): the plan's tests as event scripts

`scenarios/*.json` holds one event script per scenario in build-plan §5 (S1–S9, T1–T8,
R2, R3), plus both factory incidents (I1, I2) and the dependency graph (G7). They share
a dashboard seed.

A script lists its steps, each with its expected outcome (`appended`, `noop`,
`rejected:<code>`) and, where it matters, the handoffs it should cause. It then lists
the folded result, which can include:

- states, the cursor, the active task;
- drain and tira's closes;
- the trail of events per task;
- provenance and handoff pairs;
- pending handoffs and the frontier;
- what the health sweep finds;
- snapshots at labelled steps (replay to N).

`after` chains scripts on one log; for example, S3 runs after S1, S2 and S7.

`npm run scenarios` (and `npm test`, so CI) runs each one through the real dispatcher on
a fresh store. It also checks that each log folds to the same bytes twice, and from a
shuffled copy, that no prefix of it shows an anomaly, and that the health sweep finds
nothing broken in it (at the end and at every snapshot). Self-tests feed the runner a
script with a wrong expectation of every kind, and check each one is reported. They also
check the runner refuses malformed scripts: a duplicate label, a script that runs after
itself, or a one-word state for a brief with three regions.

Waiting on unbuilt phases (shown as TODO, with the reason):

| Script | Waits on |
|---|---|
| S8, T6 | the suggester (Phase 2) and Devansh's ranking rule |
| S9, T5 | aging and its SLA (Phase 3, A13) |
| S5's age check | aging; S5's idea → node part runs now |

## Health sweeps (Phase 3): on-demand safety checks

`tira sweep [--at N] [--json]` folds the log, then re-checks the result from its raw
fields (parent pointers, child lists, depths, states). It doesn't use the tree helpers the
fold and the gates use, so a bug there shows up here instead of agreeing with itself. It
flags; it never fixes (`src/sweep/sweep.ts`).

| Check | Finds | Kind |
|---|---|---|
| The log follows the rules | Events replay refused: they skipped the write path, or the code changed | Broken |
| Every task's parent exists | A parent that doesn't exist or is another type; a task with no place in the tree | Broken |
| No loops | Parents that come back round; briefs whose `blocked_by` loop (current versions only) | Broken |
| Parents and children agree | A parent listing a child twice, a child that doesn't exist, or one that names another parent; a child its parent doesn't list | Broken |
| The counts add up | Tasks the roots don't reach, or reach twice; more than one task in progress; a parent over the 20-child cap | Broken |
| Depths match | A recorded depth that isn't where the task sits; deeper than the cap of 8 | Broken |
| No closed parent has open work | A done or cancelled task with an open child | Broken |
| Every task says what it is and when it's done | A task born without a `definition` or `done_criteria` (blank counts as none). A task born from an idea takes what the idea's birth said | To look at |
| Finished work that grew new work | A child added under a task that was done and then re-opened (scope creep: allowed, with a reason) | To look at |

The write path and replay refuse anything that would break the first seven, so on a log
written through tira they only fire on tampering or a bug. Tests feed each check broken
state directly to prove it fires. "To look at" findings never fail the sweep: it exits 0
with them, and 3 when something is broken. Every scenario checks that its log sweeps with
nothing broken. S4, T7 and `scenarios/health-sweep.json` check the two "to look at" kinds.

One fold does all of it: `--at N` replays to N the way `tira state --at N` does, and the
history check rides along on that fold. A log of about 2,800 events sweeps in under 50 ms.
The walks are iterative and visit each task once, so even state the fold could never
produce (shared child lists, a 10,000-deep chain) can't hang or crash a sweep.

Calls made here, for the PM:

- **Field names:** a task's definition and done criteria are `definition` and
  `done_criteria` in its birth payload. Nothing sets them later yet, and no current
  scenario sets them, so today's seed tree is all hollow. A task born from an idea is
  read through `idea_id` to the idea's birth.
- **"Counts that don't add up":** the roots reach every task exactly once, at most one task
  is in progress, and no parent is over the children cap.
- **"Depths that drifted":** a recorded depth that doesn't match the parent chain, or one
  over the cap.
- **Regrown** means "done, re-opened, then grew a child", including a done leaf that's
  re-opened and split (S4). A drained parent that is still open taking another child is
  ordinary planning (the un-drain window, ruling 2026-10-18), so it isn't flagged. A
  finding stays in the history after the branch is done again.
- **Not on the page yet.** The sweep is on demand, from the command line.

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
- Event store: Postgres behind the storage interface (`packing.md` §3), hosted, the only live store (decided 2026-10-22 with Devansh, `packing.md` D12; it replaces the 2026-10-16 SQLite row and D11's "SQLite on one machine"). SQLite stays for tests and `tira import`.
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
