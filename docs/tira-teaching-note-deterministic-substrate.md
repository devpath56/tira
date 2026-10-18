# Tira: the deterministic substrate for the probabilistic agent

*Teaching note + combined learning cases. For Isha. Structure follows the six-step commercial teaching pitch (warmer → reframe → rational drowning → emotional impact → a new way → the solution), ending with a named ask. Plain language throughout — no codenames.*

---

## The teaching note

**Warmer.** You've built the generic core and the tree/drain/cursor track — 110 tests, 62 out of 62 planted bugs caught, the tree render page shipped, the region scan green. That's not a prototype. That's a substrate with proof. Hold that while you read the rest.

**Reframe.** Everyone in this space is building a better probabilistic agent. Almost nobody is building the deterministic record the agent writes to. Here's the thing most agent builders don't hold: the agent is the tornado — fast, generative, probabilistic. What the tornado destroys isn't work, it's *the record of the work*. Every agent session sprays dozens of state transitions across chat logs nobody can replay, decisions nobody can audit, completions nobody can verify. And the faster agents get, the faster the rot. The bottleneck was never agent capability. It's the absence of a single source of truth for work state.

**Rational drowning.** Put numbers on the rot. A factory brief tracked three independent dimensions — gate (can it move?), claim (who holds it?), outcome (what happened?) — and the flat model needed ~3.1M enumerated states to say what 49 factored states say. That's one brief. Multiply by every agent session per day, every decision per session, every "where did we decide that?" that is now unanswerable. Without a deterministic substrate, each agent multiplies the unaccountable surface. The industry is scaling the tornado and wondering why nothing is trustworthy.

**Emotional impact.** You're not building a task tracker. You're building the thing that makes the agent era manageable — the difference between a demo that impresses and a system that can be trusted with real work. The exhaustive-search proof on your tables (exactly his 10 joint configurations, 0 outside) is a guarantee no prompt-engineered agent can give. That's the differentiation, and it's yours.

**A new way.** Two problems, two moves — and we solved both, with proof:

1. *The modeling problem:* state explosion is a modeling smell, not a scale problem. Factor into orthogonal regions; compute the joint by folding; never list it. 49 vs 3.1M.
2. *The governance problem:* the check must live where the violation compounds. The region scanner runs at pack time, exit code as verdict — the quality requirement is the instrument, not the paragraph. All 5 of your tables green in isolation meant nothing until the composition was checked; we checked the composition.

**The solution.** Tira: the deterministic assistant that manages your probabilistic agent. Every piece of work written down once, as it happens, in a record nobody can rewrite. The live picture — tree, cursor, what's next — always computed from that record, never asserted from memory. For the tactical tornado persona, this is the single source of truth for work state: the ground the tornado stands on.

**The ask.** Build the five factory tables and ship the regions demo — the brief's three dials rendered as composed regions on screen, handoff demo with matching correlation ids, the region scan green. That's the next visual proof; everything else queues behind it.

— Devansh

---

## Part 1 — Problem 1: scalable state computation (modeling)

**The problem.** The tira build plan modeled a task as one flat state machine. His question: what happens to the state × event matrix as this scales? The event-touch audit gave the number: a factory brief tracks three independent dimensions — gate (can it move?), claim (who holds it?), outcome (what happened?) — and across 10 such regions the flat product machine needed **~3.1M enumerated states vs 49 factored.** Enumeration wasn't expensive at that point. It was unrepresentable.

**The naive answers.** (1) Enumerate anyway and manage it with tooling — but the count grows multiplicatively; tooling can't outrun a product. (2) Flatten with cross-cutting guards — one big machine with guards peeking across dimensions; the audit found only 3 genuine handoff edges, the rest factored cleanly. The guards were the coupling, not the solution.

**The move.** Ask which dimensions are genuinely simultaneous and what they both touch. Factor into one small lifecycle per entity (region); compute the joint configuration by folding the regions — never list it; couple regions only through paired handoff events with correlation ids. No shared writes, no synchronizer.

**The gate.** Factoring isn't free, so the rule carries a threshold: mandatory above ~3 regions / ~1,000 product states, advisory below. A measurement, not a taste.

**Thesis.** When the state space multiplies, the bug is in the modeling, not the scale. And the discipline: compute the joint, never list it — the moment you enumerate the combinations, you've rebuilt what you factored to avoid.

## Part 2 — Problem 2: the quality requirement as instrument (governance)

**The problem.** Once factored, how do you keep builders from re-flattening it? "Don't flatten state machines" as a paragraph decays the moment a sixth table arrives.

**The move.** State the quality requirement as a machine: the scale-gate rule, zero enumerated product states, zero cross-region guards — enforced by the region scanner at pack time, exit code as verdict. The instrument was built and attack-tested *before* the tables it checks; when Isha's 5 tables arrived, the scan ran clean: exit 0, 0 findings.

**The sharp finding.** Loosening the handoff policy one notch produced 4 forbidden joint states **with all 5 tables still validating green.** The "exactly 10" was a property of the handoff policy, not the tables. No per-table check could ever see it.

**Thesis.** The check must live where the violation compounds — a composition-level invariant needs a composition-level machine. A quality requirement without an executable check is fiction. Write the instrument before the builder builds.

## Boundary: the two problems, side by side

| | Problem 1 — modeling | Problem 2 — governance |
|---|---|---|
| The question | How do we represent joint state without enumerating the product? | How do we keep the factorization honest as builders add tables? |
| The enemy | The product — state count multiplying with every dimension | Rot — gradual re-flattening, coupling creep, paragraph-decay |
| The move | Factor into orthogonal regions; compute the joint by folding, never list it | Build the instrument; place each check where its violation compounds |
| The artifact | Hardened spec, the 5 factory tables | The region scanner, the three region checks, the reachability proof |
| The proof | 49 factored vs ~3.1M flat; exhaustive search: exactly his 10 | Scan exit 0 on her tables; attack tests caught the real idea/claim overlap |
| Failure mode if ignored | Unrepresentable state space | Silent re-coupling — 4 forbidden states, all tables green |
| Key number | 49 vs ~3.1M; gate at ~3 regions / 1,000 states | 0 cross-region guards; the exit code |
| Thesis | State explosion is a modeling smell — compute the joint, never list it | The check must live where the violation compounds |
| Depends on | Nothing — comes first | Problem 1 — you can't enforce what you haven't designed |

## Triage: which problem is this?

| Situation you're in | It's this problem | The move |
|---|---|---|
| State count multiplying with each new dimension | Modeling | Ask which dimensions are genuinely simultaneous; factor |
| Deciding whether to factor at all | Modeling | Measure against the scale gate — threshold, not taste |
| A new table wants a guard reading another region | Governance | Let the scan deny it; the rule is the exit code |
| Joint invariant holds per-table but breaks in composition | Governance | Run the check over the handoff policy, not the tables |
| A quality paragraph nobody runs | Governance | Make it an instrument before the next builder builds |
| Tempted to list the combinations "just for the test matrix" | Modeling | You've rebuilt what you factored to avoid — fold it instead |

*Full versions: `blogs/learning-case-orthogonal-factorization-state-computation-20261018.md` and `blogs/learning-case-orthogonal-regions-nfr-instrument-20261018.md`.*
