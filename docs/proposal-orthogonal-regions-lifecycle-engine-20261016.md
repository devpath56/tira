# Proposal: orthogonal regions for the decoupled lifecycle engine
---
blocked_by: []
---

**Promise:** The lifecycle engine stays representable and verifiable as entity types scale. Per-entity machines compose as orthogonal regions — new entity types add regions (linear), never multiply the state space. No flat product machine above the enumeration budget.

**NSM:** Number of explicitly enumerated product states in the engine. **Target: 0** — every joint configuration is computed by fold, never named. Instrument: a mechanical scan over the region-composition config and engine code counting literals that name a joint configuration of ≥2 regions; runs at pack time. UNEVALUABLE if no composition config exists yet (m08: instrument state ≠ world state).

**Counter-metric:** Cross-region guard reads (transitions whose guard reads >1 region). **Target: 0** in the engine core. Any nonzero is coupling leaking back in — a design smell, not a feature. Instrument: the RAT-A2 scan — guard expressions referencing another region's state, over chart JSONs + region configs (+ derived-predicate bodies per the adversarial case below); runs wherever the NSM scan runs.

**Tradeoff:** Regions reduce *description length* (Π → Σ), not the *state space* — the Πⁿ joint configurations still exist, and joint queries still cost (per-region indexes + join, built by the host). The engine also gives up "the whole system state" as one object; joint semantics are opt-in per host. Joint invariants are slower to specify, but honest about their cost.

## What (and what not)

**What:**
- Each entity lifecycle stays an independent machine by default (the config-per-entity design of `proposal-lifecycle-engine-20261015.md` stands unchanged).
- **Opt-in region composition:** hosts that need joint queries compose machines as orthogonal regions. The fold computes joint configurations; nothing enumerates them.
- **Composition declarations (qdm q05/q06):** each composition declares its grain (one row = one region), key ownership (the correlation id is minted by the first event's emitter), and its impossible joint configurations — or an explicit "none". A composition with undeclared grain is not reviewable.
- **Derived predicates as a first-class engine feature:** cross-entity facts (drain, breach, age — the established pattern) are folds over the log, never multiplied states. Adversarial case: a predicate body that reads another region's state is a cross-region guard wearing a fold's clothes — the counter-metric's instrument covers predicate bodies (see Counter-metric), or the "factor cleanly" verdict is scoped to transition guards only.
- **Handoff events with correlation ids as the ONLY cross-region coupling primitive.** Paired events (e.g. `claim.materialized {claim_id}` ⇒ `node.born {claim_id, node_id}`), each writing exactly one region; replay order reconstructs the pairing. No atomic multi-write, no shared writes.
- **Dangling-handoff check (required engine query):** every handoff pair must complete; unpaired first-events are listed as pending handoffs — a legitimate configuration (predicted weakness #3), not corruption. The check is the agreement proof (qdm q10) for the pairing.
- **Interaction-density budget:** the engine measures and reports cross-region guard reads. Nonzero fails the engine's own bar.
  Enforcement: the scans run mechanically at pack time (tier A — the machine stops the line), not by memory (tier D). The stop authority on a failed scan is the pack gate; the signer is the operator (p05). Starts in warn mode per the graduation rule below.

**Not:**
- Not a flat product machine above the enumeration budget (rule of thumb: >3 regions or >~1,000 product states — q12: below that, the region ceremony costs more than the priced failure). At small scale the flat machine stays advisory, not denied.
- Not a synchronizer region — unless a handoff ever needs all-or-nothing semantics (none of the three known handoffs does; if one appears, this proposal's claim is falsified and a synchronizer is owed).
- Not a replacement for the generic lifecycle engine — it composes with it: the engine's per-entity machines *become* regions.
- Not free joint queries — per-region indexing is the host's job.

## Why with data

1. **The compression is not marginal, it's existential.** k regions × 6 states × 8 events: k=3 → 12× compression; k=6 → 1,296×; k=10 → ~1M×; k=20 → ~3×10¹³×. Explicit enumeration stops being feasible around k=6–8. For a decoupled engine hosting tens of entity types, the flat machine isn't expensive — it's unrepresentable.
2. **The factorization was tested, not assumed.** The 2026-10-16 event-touch audit over 10 factory lifecycle regions: 49 factored states vs ~3.1M flat; every event family mapped to the region(s) it writes; only 3 handoff edges (F1: claim→node birth, F2: drop.filed ×3 regions, F3: brief.claimed ×2 regions) need paired events; everything else factors cleanly. Evidence: `event-touch-audit-20261016.md` (same folder). The audit also records its own eligibility limits: the event SSOT excludes factory lifecycle events by design and is currently documented-not-proven (every event missing its `ssot.event_added` log) — re-run triggers are defined there.
3. **Factorization finds bugs, not just compression.** The Mac file-state collapse (intuitive 4-state model was *wrong* — states overlapped; 2 orthogonal dimensions surfaced the silent miss as the Eligible × Not-known-to-git combination). Breach/escalation as derived predicate instead of multiplied states — the pattern this proposal generalizes.
4. **Compositional verification.** Reachability and dead-state checks run per region (Σ cost) instead of over the product — but only when interaction is sparse, which is exactly what the counter-metric polices.
5. **Hardening RATs, 2026-10-16 (all primary evidence, calibrator mc-0067–0070 AUTO-DECIDE).** RAT-A1: mechanical event-overlap across the three chart JSONs — node×idea and node×claim zero overlap; idea×claim full overlap is the known F5 duplication, not an atomic multi-write. RAT-A2: 0 cross-region guard reads — all guards read event payload only (`evidenceRef`, `reason`). RAT-A4: `packing.md` stream contract verified — the store guarantees ordering, `seq` is the only ordering, append-only is structural (not conventional). RAT-A5: all four named cross-entity facts (drain, breach, escalation, age) are folds over the log, 4/4. Two gaps found, not falsifications: (a) idea/claim event-namespace collision on the shared stream — packing.md names `node.*` and `idea.*` only, claim stream placement unspecified; (b) no handoff events and no correlation-id field exist in any chart yet.

## Ranked assumptions

1. **The transition structure factorizes** — events partition to one region, guards are region-local. *Falsifier:* the event-touch audit (re-run on its triggers) finds an event needing an atomic multi-region write. None found 2026-10-16.
2. **Interaction stays sparse by construction**, not by luck. *Falsifier:* cross-region guard count >0 in engine core after redesign — then the win is being paid back in guard complexity.
3. **Hosts needing joint semantics opt into region composition** rather than demanding a flat machine. *Falsifier:* a host needs a joint invariant inexpressible as regions + derived predicates + handoff events. *Hardening 2026-10-16:* no cheap test exists — this is a forecast about future hosts. UNRUNNABLE as a RAT; escalated to operator judgment.
4. **Replay order reconstructs handoff pairing** (with correlation ids; single writer per region). *Falsifier:* reordered appends break a pairing — the tracking MVP's "scope void if a second writer appears" is the same tripwire. *Hardening 2026-10-16:* ordering half VERIFIED (`packing.md`: store guarantees ordering, `seq` is the ordering, append-only structural). Correlation-id half UNBUILT — no handoff events exist in any chart; the pairing substrate is proven, the pairing itself is not.
5. **Derived predicates cover the cross-entity facts hosts actually query.** *Falsifier:* a host needs a cross-entity fact that isn't a fold over the log.

## Falsifiers

- **PASS:** the engine hosts 6+ entity types with 0 enumerated product states, 0 cross-region guards in core, and all joint queries served by fold + per-region indexes. Each budget evaluation emits a decision event (policy revision, input composition, answer, decision id — p06); denies carry reason and why.
- **FAIL:** adding an entity type requires touching another entity's machine (coupling leak); or a handoff needs all-or-nothing semantics (synchronizer owed — this proposal's core claim falsified); or interaction density >0 persists after redesign.
- The audit's falsifiers carry over: re-run the event-touch audit when the factory-lifecycle SSOT follow-on lands, when each 🔴/🟡 emitter goes live, and on any orphan-checker failure.

## Open questions

- Where does region-composition config live? (Suggest: alongside lifecycle configs, `coordination/sync/lifecycles/`.)
- Who owns the interaction-density budget — **decided 2026-10-16:** the engine owns the measurement instrument (it runs the scans); the host owns the threshold ruling for its composition. Graduation (p10): warn-mode at pack time first; deny only after the bar proves non-nuisance; the operator signs the promotion.
- Do paired handoff events need a correlation-id field convention in the event SSOT?
- Should the engine ship per-region indexes for joint queries, or is indexing the host's job? (This proposal says host; worth a ruling.)
- Does the idea/claim chart duplication (audit F5) collapse before or after regions land?
- Claim stream placement: **decided 2026-10-16** — `claim.*` namespace on the shared stream, before any composition (RAT-A1; oust-guru: namespacing defines the routing error out of existence). The F5 collapse-or-justify call stays open, but namespacing is not conditional on it.
- Handoff-event schema: who defines the correlation-id field, and does the first paired event get written before its region's transition commits (ordering of the pair itself)?

## Done test

Mac-runnable, agreed by the state-modelling room (Stage 7 gate):
1. `region-scan.py --overlap` over chart JSONs + composition config exits 0 — no event handled by >1 region except declared handoff pairs.
2. `region-scan.py --guards` reports 0 cross-region reads (transition guards + derived-predicate bodies).
3. Replay test: a scripted log with an F1 handoff (`claim.materialized {claim_id: X}` then `node.born {claim_id: X}`) folds to claim=materialized AND node=unstarted with matching X.
4. Dangling test: a log with `claim.materialized` and no `node.born` → the dangling-handoff check lists X as pending (not an error).
5. `proposal-gate.py` PASS on this file.

## Hardening record (2026-10-16)

**Triage:** operator-directed ("spec harden"); gate PASS before hardening. Selection-bias note: proposal authored and hardened in the same session — Stage 5 rooms are the debias control.

**Stage 0 premises** (falsified = STOP; none falsified):

| # | Premise | Primary evidence | Holds? |
|---|---|---|---|
| P1 | Compression ratios 12×/1,296×/~1M×/~3×10¹³× (k=3/6/10/20); factory 3.1M flat vs 49 factored | recomputed by hand | ✅ |
| P2 | Audit file's core claims (10 regions, F1–F3, E1–E3) | file read | ✅ |
| P3 | Lifecycle-engine proposal: config-per-entity, 6 entities | file read | ✅ |
| P4 | Breach/escalation as derived predicate in built charts | chart source read | ✅ |
| P5 | Mac file-state precedent (orthogonal dimensions found the silent miss) | memory (secondary — flagged, not primary) | ⚠️ secondary |
| P6 | Orphan checker flags every event missing `ssot.event_added` log | direct run | ✅ |
| P7 | Idea/claim charts structurally identical | diff of both files | ✅ |

**Stage 1 RATs** (calibrator mc-0067–0070, all AUTO-DECIDE):

| Assumption | Test | Result |
|---|---|---|
| A1 factorizes | event-overlap across 3 chart JSONs | HOLDS (node×idea, node×claim: zero overlap). Sub-finding: idea×claim namespace collision → open question above |
| A2 sparse interaction | guard-read grep | HOLDS — 0 cross-region reads |
| A3 hosts opt in | — | UNRUNNABLE, no cheap test — escalated to operator |
| A4 replay pairing | packing.md stream contract | ordering VERIFIED; correlation ids UNBUILT → open question above |
| A5 derived predicates | enumerate drain/breach/escalation/age | HOLDS 4/4 |

**Stage 2 falsifiers:** the three known falsifier locations are factory-build falsifiers (slice-2 review gates, rulings-write red/green proofs) — none applies to this proposal's domain. Stated explicitly: no domain falsifier exists yet; the proposal's own falsifier section carries the load.
