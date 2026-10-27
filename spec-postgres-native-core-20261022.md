# Spec A — the Postgres-native core (hardened, H-047)

**spec_id:** spec-postgres-native-core-20261022 · **proposal_id:** proposal-postgres-native-core-spec-a-20261022 · **packet_id:** pkt-postgres-native-core-20261022 · **Status:** SIGNED OFF by the operator's word ("go", 2026-10-23, H-036 precedent) — `spec.hardened` **evt-20261023-spec-a-001**. D-P2 `measure.due` armed at **2026-11-22**, owned by the operator. The packing.md amendments are ruled by the signoff ruling and land in the repo with the ratification PR as decision D14 (KurrentDB was already struck by D11/D12; D14 records the upgrade trigger and ratifies fast-check + Stryker in the test layer). Ruling rows for Stage 6 and signoff are preserved verbatim in `your_files/spec-a-stage6-ruling-row-20261022.json` and `your_files/spec-a-signoff-ruling-row-20261023.json` — the guarded writer refused both store writes (OPA unavailable on the VM, fail closed); they file through `rulings-write.sh` when OPA is present. **Repo placement:** this file, beside `build-plan.md` — landed by the Spec A ratification PR; the factory copies under `your_files/` remain the hardening record (H-047). **Deltas folded:** D-M1, D-M2 (Metrics), D-Q1, D-Q2 (Quality bar), D-T1, D-T2 (Test definition), D-P1, D-P2 (Policy — adopted by the operator at Stage 6, 2026-10-22), D-K1 (Packing — this spec contains modules 1–2 only; the D-P1 gate change ships separately, see Standing rule).

**Promise:** tira's substrate stops being an argument and becomes a checkable claim — CI is green at `dc082b6` including the Postgres-gated tests, and Spec A holds that state as a named bar: 9 of 9 definition-of-done legs green *on the Postgres leg*, each with a named oracle and a per-environment verdict.
**NSM:** 100% of completions emit the full per-completion contract (legality, unblock set, backtrack target) purely from replay — measured by a replay audit over every stream in the live Neon store: fold each stream, and for each COMPLETE event verify the contract is derivable from the fold alone. Reported as counts (completions audited / contracts complete / false next-actions); rates are UNPUBLISHABLE until n≥30 completions (D-M1).
**Counter-metric:** 0 false next-actions on the same audit — every suggester pick and its rejected-alternatives list reproduce identically on re-fold, with leg 8's fast-check fold-invariance property as the standing instrument (D-Q2).
**Tradeoff:** owning the store and write-path code (585 lines of store implementations + types, measured; 443 lines of write path — which also carry eras, tree rules, and the dispatcher) against zero framework dependency in the core: no license gate, no pre-1.0 churn, no second log. The plumbing stays ours because the three things no framework serves — tree fold, eras as data, the rejection audit — are tira's differentiators, and they sit on top of the plumbing either way.

## What (and what not)

Spec A, the ratified architecture:

1. **One live store.** Hosted PostgreSQL on Neon (PG 17) is the only live store — events, people/permissions, and the sync outbox in one database, separate schemas/roles per system. The code refuses SQLite files and creates no `./tira.db` (PR #27, `4ce465d`; `src/store/open.ts`). SQLite exists only as in-memory test instances and as the one-time `tira import <file.db>` reader for legacy files — neither is a store.
2. **The narrow EventStore interface.** `append` (with `expectedRevision` and idempotent `eventId`) / `readStream` / `readAll` (replay-to-N) / `subscribe` (LISTEN/NOTIFY on Postgres, not polling). The store never validates domain rules; guards run in the write path before append. `seq` is the only ordering — gapless, in commit order; the events table is append-only with triggers blocking update/delete/truncate.
3. **The canonical JSON transition tables are the spec.** Node lifecycle (35 pairs) and idea lifecycle (36 pairs), mechanically extracted, never hand-edited (CI enforces: extract + `git diff --exit-code`). XState charts are the verified executable reference only — no XState dependency in the build (ruled 2026-10-16). There is no `claim-lifecycle.json`; `brief-claim.json` is a factory-vocabulary table.
4. **The built core on top:** the guarded write path (evidence-on-COMPLETE, reason-on-REOPEN, add-child-to-done denied), the fold (tree, drain, depth-first cursor, one-active gate, completion contract), era-versioned rules as data (eras 1–3; replay pins the era in force at write time; era 1's table is frozen and sha256-pinned), the rejection log (every denial appends `command.rejected`), the deterministic suggester with receipts, and the vapor pipeline (PR #26).
5. **Periphery:** lean custom UI (React/Radix, Plane patterns only — its code is AGPL and never enters), Vitest + fast-check + Stryker as the test layer.

**Definition of done — all nine legs, verdicts per environment (D-T2).** PASS = all nine green on Postgres (CI or live-Neon). A leg's local verdict of UNEVALUABLE-by-design is the correct local outcome, never a pass and never a fail. Vocabulary: PASS / FAIL / UNEVALUABLE / NOT-RUN.

| Leg | Claim | Oracle | Local | CI |
|---|---|---|---|---|
| 1. Store contract | Interface suite green on Postgres; gated tests actually execute (D-Q1: CI prints the executed Postgres-gated count and fails if it is 0) | CI run at the head SHA, gated count > 0 | UNEVALUABLE (no `TIRA_PG_URL`, by design) | PASS required |
| 2. Differential | Fold ≡ canonical tables on every state×event×guard-polarity | `npm run verify` exit 0 (178 checks; 142 differential pairs) | PASS | PASS |
| 3. Evidence gate + rejection audit | Bare COMPLETE / bare REOPEN denied, state unchanged, `command.rejected` appended | S2, S6, T1 in the suite | PASS | PASS |
| 4. Idempotent re-delivery | Same-state repeats are noops, not denials; duplicate `eventId`s change nothing | T3 | PASS | PASS |
| 5. Replay | Replay-to-N exact at every tested N; full replay byte-identical; stale-`expectedRevision` refused | T2, T8, M0 (hash comparison, run twice) | PASS | PASS |
| 6. Tree fold | 5 ADD_CHILD pairs, drain, DFS cursor, completion contract | S1, S3, S4, T7 | PASS | PASS |
| 7. Eras as data | Table change = appended era marker, never an edit; pinned replay has 0 era-caused anomalies, reported as its own line | Legacy pre-#9 fixture replay | PASS | PASS |
| 8. Contract + suggester | NSM + counter-metric above, from replay | S8, T6, M4 + D-Q2 fast-check property + D-M1 replay audit | PASS (suite); audit at measure | PASS |
| 9. Vapor pipeline | Declare → file → materialize, no-skip, breach derived, approval at each gate | S5, S9, T5, M5 | PASS | PASS |

**Not in scope:** rebuilding any part of the built core; adopting Emmett or any event-sourcing framework (Combo B stays left; re-openable only per the expressiveness falsifier); KurrentDB as an upgrade path (Kurrent License v1, source-available — the packing.md amendment striking it is recommended to ride with the signoff ruling); the emission go-live (a separate, already-tracked gate); multi-worker concurrency semantics (deferred until a second writer appears).

**Consumers:** Isha, as builder (the spec her repo is checked against); the operator, as the ruling surface for substrate questions; any future session handed tira work.

## Why with data

- **Measured at `dc082b6` (H-047 Stage 0, first-hand on the pinned clone):** `npm run verify` 178 passed / 0 failed (differential pairs: node 70 + idea 72; original verifiers 54 + 50); `npm test` 413 passing / 0 failing / 44 skipped / 6 todo (463 total — the skips are the Postgres-gated tests, which CI runs against `postgres:17`; the CI run at `dc082b6` concluded success, GitHub API 2026-10-22T22:44Z); a 665-mutant harness; eras 1–3 live; Postgres the only live store. Store lines measured exactly: 585 (postgres 277 + sqlite 204 + types 104); write path exactly 443.
- **The OSS search's headline holds at every license:** the 11 jobs' domain core (fold, evidence guards, cursor/drain, suggester with receipts, vapor pipeline) has no OSS server; every combo converges on building it, differing only in substrate.
- **The alternative was priced by spike:** the Emmett slice took 66 lines against ~1,028 — but left tree fold, eras-as-data, and the rejection audit untouched by construction (single-stream decider; decider-is-code; nothing stored on denial).
- **One database is a correctness property:** one Postgres transaction covers event append + claim write (emit-or-halt as a database guarantee); LISTEN/NOTIFY makes `subscribe` honest; the one-log test already rejected a second journal.

## Ranked assumptions

1. **Ratification ends re-litigation** (riskiest). Measured by A1's `measure.due` (see Falsifiers): the next substrate proposal is answered by leg citation, or this assumption is falsified in the open.
2. **The Postgres-gated coverage gap is closable at CI cost** — **closed by H-047 RAT A2:** CI already runs the gated tests against `postgres:17`, green at `dc082b6`. Leg 1's remaining risk is oracle rot, carried by D-Q1's executed-count assertion.
3. **Era-versioned rules stay data-shaped.** Eras 1–3 shipped as table versions with pinned replay (era commit `ed82c9e`); the first rule the tables + guard registry cannot express as data is the expressiveness falsifier below.
4. **The single-writer model holds** (H-047 RAT A4: the write path + dispatcher are the only store-append path in `src/`; `serve` appends are DOM). Un-parked by a second writer appearing, not by anticipation.

## Falsifiers

- **Re-litigation falsifier:** a substrate-switch proposal reaches the operator without being answered by citing a Spec A leg → the ratification failed as a control. **Measure (D-P2, adopted at Stage 6):** the check is `measure.due` at signoff +30 days, **owned by the operator**; an overdue measure files a blocked-on-you entry. The measure reports: substrate proposals received in the window (count), of those answered by leg citation (count) — counts, not rates.
- **Leg-1 falsifier:** the Postgres-gated tests, run against `postgres:17`, fail on behavior the SQLite leg passes, *or* the executed gated count in CI is 0 on a green run → leg 1 is red regardless of the job's color.
- **Expressiveness falsifier:** a real tira rule arrives that the canonical tables + guard registry cannot express as data → the framework question reopens on that evidence, with Combo B as the standing challenger — and not before.
- **NSM falsifier:** the D-M1 replay audit finds any completion emitting less than the full contract, or any suggester receipt failing to reproduce on re-fold → the Promise is false as stated, regardless of the other eight legs.

## Standing rule

**D-P1 (adopted at Stage 6, 2026-10-22):** a substrate-switch proposal must cite the Spec A leg it supersedes plus a ruling id. Enforcement is a `proposal-gate.py` citation check, **warn-first**, graduating to deny only after ≥20 journaled encounters with 0 false denies (the H-035 ladder). Per D-K1, that gate change is *not* part of this spec: it ships as the separate factory proposal `proposal-proposal-gate-leg-citation-20261022.md`, which cites this spec; this section is the obligation it implements. Until the gate change lands, the rule is Tier D prose and is labeled as such — the falsifier above is what keeps it honest in the interim.

## Open questions

1. **Placement:** resolved — this file lives in the tira repo beside `build-plan.md` (builder is the consumer); the factory copies in `your_files/` are the hardening record. Placed by the ratification PR on the operator's go-word (2026-10-23), superseding the draft's assumption that placement was Isha's land: she reviews as the PR's approver instead.
2. **Packing.md amendments:** strike KurrentDB as the named upgrade; fast-check + Stryker move from candidate to ratified in the test layer. Recommendation: fold both into the signoff ruling.

## Done test

Run from the tira repo root on the Mac, at the head being ratified. PASS = every step's expected outcome holds; any FAIL = the leg named is red and the spec is not done.
1. Canonicality (leg 2 precondition) — `node charts/extract-tables.mjs && git diff --exit-code charts/*.json` exits 0: the JSON tables equal a fresh extraction; no hand edits.
2. Differential (leg 2) — `npm run verify` exits 0 and prints 178 passed, 0 failed.
3. Local suite (legs 3–7, 9) — `npm test` reports fail 0; Postgres-gated tests report skipped (expected locally: UNEVALUABLE-by-design for leg 1, never counted as a pass).
4. Postgres leg (leg 1) — with `TIRA_PG_URL` set to a `postgres:17` database: `npm test` reports fail 0 **and** Postgres-gated skipped = 0 (the executed gated count is > 0; a green run with gated skips is a leg-1 FAIL per D-Q1). CI equivalent: the latest run at the head SHA concluded success with the gated count printed.
5. Replay determinism (leg 5) — `tira dump` twice against the same store; the two outputs' hashes are identical, and `tira replay <N>` at three chosen N values reproduces the states the full dump shows at those points.
6. Era pinning (leg 7) — replay the pre-#9 legacy fixture log: it replays clean with 0 era-caused anomalies, reported as its own line.
7. Import fingerprint (leg 1, legacy path) — `tira import` on the 4750 demo file (34 events): the post-import fold fingerprint equals the recorded fingerprint.
8. Rejection audit (leg 3) — through the CLI: COMPLETE a node with no evidence ref → denied, state unchanged, and the log gains a `command.rejected` record; REOPEN with no reason → same.
9. Suggester receipts (leg 8) — fold the S8 scenario log twice: identical pick and identical rejected-alternatives list both times; the fast-check fold-invariance property (D-Q2) passes in the suite.
