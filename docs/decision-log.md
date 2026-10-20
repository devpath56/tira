# Engineering decision log

How tira is built: the architecture, data, concurrency, runtime, frontend and
verification choices. One row each. Product and policy rulings (what the system should
do: drain semantics, who may expire an override, what counts as done) live in
`build-plan.md` §7, not here.

Add new rows at the top of their section; never edit a decided row. If a call changes, add
a new row that says what it replaces.

| Column | Meaning |
|---|---|
| **Decision** | The engineering question, phrased as a choice |
| **JTBD** | The job it serves, numbered as in `build-plan.md` §4: 1 Track a branching build depth-first · 2 Prove a task is done · 3 Get interrupted and resume exactly · 4 Capture discovered work mid-flight · 5 Change my mind honestly · 6 Kill unnecessary work cleanly · 7 Keep ideas from dying in chat · 8 Approve, don't drive · 9 Know what a finish unlocked · 10 Get told what's next, with reasons · 11 Verify the system isn't lying |
| **Recommendation** | What we do, and its status: **Decided** (date), **In review** (PR) or **Open** (waiting on whom) |
| **NSM / CM tradeoff** | The engineering metric it moves, the one it risks, and whether that holds |
| **What it buys** | The outcome in one line |

## Runtime and toolchain

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Build step or not | 11 — Verify the system isn't lying | **Decided 2026-10-17.** TypeScript runs directly on Node ≥ 22.18 (type stripping, ESM). No compiler output, no bundler; `tsc` only typechecks | NSM: zero artifacts between the source and what runs. CM: older Node fails outright (a v14 shell can't run it). Holds: `engines` pins it and CI runs 22 | What you read is what runs |
| Which dependencies | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Zero runtime dependencies: `node:sqlite`, `node:crypto`, `node:test`. Dev only: `typescript`, `xstate` (differential checks), `@types/node`; CI installs with `--ignore-scripts` | NSM: no third-party code on the trust path. CM: hand-written utilities (canonical JSON, time parsing). Holds: each is small and tested | No supply-chain surface in a public repo |

## Storage

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Event store | 11 — Verify the system isn't lying | **Decided 2026-10-16.** SQLite (`node:sqlite`, WAL on disk) behind a four-method interface: `append`, `readStream`, `readAll`, `subscribe`. KurrentDB is the named upgrade | NSM: zero lost or duplicated events. CM: single host. Holds while there is one worker | No infrastructure now; a one-module swap later |
| How "append-only" is enforced | 11 — Verify the system isn't lying | **Decided 2026-10-17.** In the database: triggers abort every `UPDATE` and `DELETE` on `events` | NSM: history immutable even to buggy code. CM: no in-place fixes; corrections must be new events. Accepted | Immutability that doesn't depend on discipline |
| Ordering | 1 — Track a branching build depth-first | **Decided 2026-10-17.** A global, gapless `seq` (the replay cursor) plus a per-stream revision (for optimistic concurrency) | NSM: a total order for replay-to-N. CM: contention on one sequence. Holds with one writer | Time travel to any event |
| Idempotency | 11 — Verify the system isn't lying | **Decided 2026-10-17.** The caller may supply `eventId`, unique across the store. Same stream: returns the original seq. Another stream: throws. Duplicates within one batch collapse | NSM: zero double rows from retries. CM: a cross-stream id clash throws instead of passing quietly. Intended | Crash-safe retries |

## Write path and concurrency

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Where rules are enforced | 2 — Prove a task is done | **Decided 2026-10-17.** One guarded write path for every caller (CLI, factory, tests): shape check → evaluate → append inside `BEGIN IMMEDIATE`. The store never validates domain rules | NSM: one gate, no bypass. CM: a bottleneck. Holds at one worker | Rules can't be skipped by a new entry point |
| Concurrent writes | 11 — Verify the system isn't lying | **Decided 2026-10-17.** In process: one promise queue per stream. Across processes: append with `expectedRevision`; on a lost race, re-read, re-evaluate and retry with jittered backoff (≤ 10 attempts) | NSM: no lost updates and no decision on stale state. CM: retry storms. Holds: bounded attempts, jitter | Correct under two CLIs at once |
| What gets evaluated | 11 — Verify the system isn't lying | **Decided 2026-10-17.** The command is `structuredClone`d at submit, and the snapshot is what's evaluated | NSM: the decision matches what was sent. CM: a copy per write. Negligible | A caller mutating its object later can't change the outcome |
| Refused and malformed commands | 2 — Prove a task is done | **Decided 2026-10-17.** A refusal is appended as `command.rejected`, carrying the intent and the reason. A malformed command throws and is never logged | NSM: every denial auditable. CM: log growth. Holds: rejections are shown apart | Denials are evidence; garbage is not |
| Handoff writer | 11 — Verify the system isn't lying | **Decided 2026-10-18.** An in-process dispatcher runs after each write. It computes due receivers from the fold, writes them as a reserved actor with correlation and causation ids, re-checks "still due" inside the stream queue, and catches up after a duplicate (a crash between the halves of a pair) | NSM: each receiver written exactly once. CM: a fold per check. Holds at MVP scale | Cross-dial effects without cross-dial rules |
| Pages that can act | 1 — Track a branching build depth-first | **Decided 2026-10-19.** `tira serve`, bound to 127.0.0.1 only. Every change goes through the same dispatcher and write path | NSM: a checkpoint runnable from the page alone. CM: a new safety surface. Holds iff the write path stays the single gate | The tracking page becomes operable, not just viewable |

## Rules engine

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| How state machines are expressed | 2 — Prove a task is done | **Decided 2026-10-16.** JSON transition tables: a complete state × event matrix (transition, no-op or denied), loaded and validated at startup. A registry maps entity types to regions to tables. Guards are named pure functions | NSM: every pair explicit, no implicit default. CM: verbose tables. Holds | The tables are the spec, reviewable as data |
| Composite state | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Orthogonal regions, not a product machine. Each event belongs to exactly one region (checked at registration). A guard sees only the payload, the actor, its own entity and its own region's captured data | NSM: 0 cross-region guard reads (scanned in CI). CM: joint meaning has to live somewhere. Holds: a declared handoff list and 10 declared configurations | The state space stays linear |
| Validating history | 11 — Verify the system isn't lying | **Decided 2026-10-17.** One pure `evaluate()` serves both the write path and the fold. The fold re-judges every stored event; a failure becomes an anomaly, not a crash | NSM: replay is validation. CM: a rule change turns old history into anomalies. Accepted: the rules are part of the log's contract | Tampering and bypasses surface on replay |
| Machine-written events | 11 — Verify the system isn't lying | **Decided 2026-10-18.** Replay checks each one: tira's must cite the next human move, and a paired start + complete is judged as one. The dispatcher's must be called for by the handoff rules at that point | NSM: no unverifiable machine write. CM: more replay logic. Holds: planted bugs cover each check | "By tira" and "by dispatcher" are provable, not trusted |
| Versioned entities | 2 — Prove a task is done | **Decided 2026-10-17.** Keyed `type:id@version`. Superseded = version + 1 exists; nothing is mutated | NSM: revisions without rewrites. CM: lookups by version. Negligible | History of every version stays intact |

## Determinism and identity

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Stable serialization | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Canonical JSON: keys sorted by UTF-16 code unit at every level, never `localeCompare`. The fold's output is fingerprinted with sha256 (`tira dump --hash`) | NSM: same log, same bytes on any machine (verified 3× independently). CM: other languages must match code-unit order. Holds: documented with test vectors | A one-line proof two people see the same state |
| Ids for external emitters | 11 — Verify the system isn't lying | **Decided 2026-10-19.** `fx:` + sha256 of the transition's canonical JSON; the write path recomputes it and refuses a mismatch | NSM: transitions with verifiable provenance. CM: false refusals on legitimate rows. Traded for never silently mislabeling provenance; 5 test vectors pin the edges | The key is an integrity check, not a naming convention |
| Time in the fold | 11 — Verify the system isn't lying | **In review (#5).** The fold never reads the clock: `now` is an explicit option, and the store's `recordedAt` is informational. Domain times are strict ISO-8601 with a zone, parsed by hand (no `Date.parse`) | NSM: replay identical in every time zone (tested in 4). CM: emitters must send zones. Accepted | No time-zone or clock drift in replay |
| Randomness | 11 — Verify the system isn't lying | **Decided 2026-10-17.** None in derived state. UUIDs only for event ids a caller didn't give; retry jitter uses `crypto.randomInt`; test walks use a seeded PRNG | NSM: reproducible folds and tests. CM: none | Every run can be replayed exactly |

## Derived state

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Stored flags or computed predicates | 1 — Track a branching build depth-first | **Decided 2026-10-17.** Computed at read time from the fold plus explicit inputs (`now`, `vantage`): drained, awaiting close, frontier, overdue | NSM: no stale flags. CM: compute per read. Holds at MVP scale | Flags can't disagree with history |
| History analyses | 11 — Verify the system isn't lying | **Built; PR approved (sweeps).** A read-only `onApply` hook on the fold, so a whole-history check is one pass, not a fold per prefix | NSM: a sweep in under 100 ms (45 ms on about 2,800 events, down from 62 s). CM: a new extension point in the core. Holds: read-only, with a planted bug | On-demand checks stay instant |
| Independent invariant checks | 11 — Verify the system isn't lying | **Built; PR approved (sweeps).** Sweeps re-derive structure from raw fields without the fold's helpers; walks are iterative, visit each node once, and keep visited sets | NSM: fold bugs caught. CM: some logic duplicated. Accepted: independence is the point | A bug can't agree with itself; no input can hang or overflow it |

## Frontend

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Rendering model | 11 — Verify the system isn't lying | **Decided 2026-10-17.** `renderHtml(fold)` is a pure function returning one self-contained HTML string: inline CSS, no client JS, no network assets | NSM: deterministic page bytes, so the hand check against `tira dump` works. CM: no interactivity. Addressed by `tira serve` | The page itself is checkable evidence |
| Interactivity without JavaScript | 1 — Track a branching build depth-first | **Decided 2026-10-18.** Tabs are CSS radio buttons; drawers use `:target`. Theme via CSS custom properties and `prefers-color-scheme`; motion is CSS-only and off for reduced motion and print | NSM: zero JS on the checkpoint page. CM: limited interactions. Holds for read-only views | Accessible, printable, deterministic |
| View model and test hooks | 1 — Track a branching build depth-first | **Decided 2026-10-17.** A view model (`tree-view.ts`) is shared by `tira tree` and the page; every node carries `data-*` attributes once | NSM: page node count = fold node count (hand check). CM: none | CLI and page can't disagree; tests read structure, not pixels |
| Interactive layer | 1 — Track a branching build depth-first | **Open (design next).** Progressive enhancement over the same static HTML under `tira serve`, with a latency budget under 100 ms for the palette and actions | NSM: any task found in ≤ 3 keystrokes. CM: the static page's determinism. Holds: the checkpoint page stays JS-free | Operable without losing the checkable page |

## Integration with the factory

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Building the divergence report before real data exists | 11 — Verify the system isn't lying | **Decided 2026-10-19.** Build to the locked JSONL format with a synthetic fixture; no real sample exists yet | NSM: time to a working divergence report. CM: fixture-reality mismatch. Locking the format now makes a future mismatch visible early | Work starts now, not blocked on factory wiring |
| Outage records | 11 — Verify the system isn't lying | **In review (#5).** A refusal's entity is named by the refused transition's key, and its own row uses its own key | NSM: reconcile twice, record once; the refused transition still lands later. CM: two keys to explain. Holds: README walkthrough | Outages leave a record without blocking recovery |

## Verification infrastructure

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| Scenario tests | 11 — Verify the system isn't lying | **Decided 2026-10-17.** A JSON DSL of event scripts, run through the real dispatcher on a fresh in-memory store. Every script also gets: fold twice, fold shuffled input, no anomaly at any prefix, nothing broken in the sweep | NSM: every plan scenario executable. CM: scripts drifting from intent. Holds: the runner self-tests every kind of expectation | The plan's tests are the suite |
| Mutation testing | 11 — Verify the system isn't lying | **Decided 2026-10-17.** A custom harness: find/replace mutants in a scratch copy; each pattern must match exactly once; the suite must fail; 5-minute timeout; runs in CI | NSM: 100% of planted bugs caught (250 on the sweeps branch). CM: planter = checker bias. Addressed by the blind round | Evidence the suite catches real breaks |
| Proving the tables match their source | 2 — Prove a task is done | **Decided 2026-10-16.** The JSON tables are extracted mechanically from the XState charts; 176 pair-by-pair differential checks; CI re-extracts and fails on any diff | NSM: zero drift between spec and runtime. CM: xstate as a dev dependency. Accepted | The runtime tables are provably the spec |
| Property tests | 11 — Verify the system isn't lying | **Decided 2026-10-18.** Random command walks with a seeded PRNG (mulberry32) never leave the 10 declared brief configurations | NSM: reachable states = declared states. CM: random coverage gaps. Holds: an explicit test also reaches all 10 | Composition bugs surface without hand-written cases |
| Independent fault planting | 11 — Verify the system isn't lying | **Decided 2026-10-19.** A blind round: 10 faults on a branch, scored by someone else; a fault is caught only if the suite fails twice | NSM: 10/10 caught. CM: flaky passes counting as catches. Holds: the fail-twice rule | Detector quality measured by someone other than the builder |

## CI and code quality

| Decision | JTBD | Recommendation | NSM / CM tradeoff | What it buys |
|---|---|---|---|---|
| What CI runs | 11 — Verify the system isn't lying | **Decided 2026-10-17.** Node 22; `npm ci --ignore-scripts`; spec drift check (re-extract tables, `git diff --exit-code`); `npm run check` (verifiers, typecheck, tests, region scans); all planted bugs on every push | NSM: main is always green on the full suite. CM: CI time (about 12 min). Accepted | Every merge is fully verified |
| Static analysis gate | 11 — Verify the system isn't lying | **Decided 2026-10-19.** SonarCloud automatic analysis. Generated slide decks are excluded from duplication only (`.sonarcloud.properties`), never from bug or security analysis; fixes follow each rule's documented compliant pattern | NSM: green gate on main. CM: exclusion scope creep. Holds: it names generated files only, duplication only, with the reason written down | A meaningful gate without deleting the demo |
| Tools an agent may call | 11 — Verify the system isn't lying | **In review (#6).** Command-line tools that take paths resolve them and refuse anything outside the working directory | NSM: security rating A. CM: refusing a legitimate outside path. Accepted: the tools run from the repo root | Safe to hand to an AI agent |
