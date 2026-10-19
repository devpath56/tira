# Tira roadmap

*2026-10-18. Living document — updated when a decision lands or a slice ships.*

---

## Tira is the work ledger for teams of coding agents

"Done" is a verdict, not a claim. Every state change in an agent team's work
is an event in an append-only log; current state is derived by replaying it —
never asserted, never stale by design. Three questions, one source of truth:
what happened, what's the current state, what's the next step. The buyer is
the orchestrator (tech lead / founding engineer running agent fleets), not
the agent builder — every rival sells to the builder; tira sells to the
governor. Of the 10 orchestrator/agent JTBDs, incumbents fully serve exactly
one (Build); tira fills the other nine and deliberately refuses Build.

---

## Where the build stands

- **Engine core landed:** tree, drain, cursor; 110 tests, 62/62 planted bugs;
  `tira render` D1 page. Factory tables in progress; liveness SLA open.
- **Event vocabulary locked:** brief/session/drop events with the 3-dimension
  brief state (gate × claim × outcome); claimed-active requires observable
  evidence; liveness is a derived predicate (FRESH/STALE/UNKNOWN), never
  inferred death; verifier ≠ claimer.
- **What isn't built:** the record has no producers yet beyond the factory
  itself; no gates run on live transitions; no adapters exist.

## The two customers

1. **The naive factory (customer #1):** a live design-loop factory — agents
   against idealized tools, transcripts as the record. Tira's first producer.
2. **The realistic factory (customer #2):** enterprise environment + agentic
   workflows simulated à la Deccan AI's STARK RL gym — simulated enterprise
   servers whose tools/APIs encode statefulness, permissions, irreversibility,
   latency, and rate limits. Agents tested under production-like conditions,
   not idealized sandboxes. Tira sits *above* the gym: the gym provides the
   environment; tira provides the verified work record on agent runs inside it.

## Interface verdicts

| Thread | Verdict | Shape |
|---|---|---|
| Jira Forge app | **Primary — double down** | Validator (sync pre-transition gate) + glance (one-line state) + panel (dials, evidence, legal moves) + dashboard (governor's inbox). UI Kit for glance/panel; Custom UI for dashboard. 25s validator budget. Principle: native where the user lives, rich where the user goes to think. |
| GitHub PRs | **Build — the missing thread** | Required status check + branch protection: "work record: verified" with a link. Code-side twin of Jira's validator; minimum pixels, maximum authority. |
| Slack | **Thin — the awareness plane** | Verdict lines, notifications, inbox-lite. Never port the dashboard into chat. |
| Email | **Next after the spine** | Morning digest (triage + approvals in one artifact); approval requests as one-click signed links. |
| LangStudio | **Thinnest — wedge only** | Governance pane for LangGraph agent teams (LangGraph owns run-state, tira owns work-state). Ship the pane, nothing more; first cut if no design partner bites. |
| Personal/factory HTML | **Cut as product** | Workbench/demo rig, frozen at demo-good. Never let it accrete features. |

Hierarchy: **Jira controls, Slack narrates, Studio courts.** Tira stays
headless; each job gets the thinnest adapter where that job already happens.

## Build sequence

**Dogfood transition ("don't move your work into Jira and Slack, move the
record"):**

1. Record first — instrument factory sessions to emit tira events.
2. Trust screen — evolve `tira render` into the governor's inbox; run morning
   triage on it for two weeks.
3. First gate where the pain is — the factory's own transitions gated.
4. Adapters in ICP order — Jira Forge → GitHub PR check → Slack → email digest.
5. Design partners plug into the same engine.

**Realistic-factory sequence (fastest feedback, weekly hackathon validation
with power users — each week ends with one falsifiable question, fail adjusts
next week's scope):**

**Sequencing principle: never simulate what you can borrow.** A Jira clone has
to faithfully model transitions, validators, permissions, and workflow quirks —
and every place the clone is wrong is a behavior that won't survive contact
with production. Atlassian already ships the production tool surface as MCP
(the official Rovo MCP server: 72+ tools across Jira, Confluence, Compass, and
Bitbucket, all user-permission-scoped), and HUD's SDK speaks MCP natively — so
the agent uses the identical tools in the gym and in prod. The action-space gap
is zero by construction. This deletes the transfer problem instead of solving
it, which is what unblocks the highest-quality work fastest.

- Week 1: record against a REAL Jira Cloud sandbox (free tier) seeded with
  synthetic tickets — no Jira clone. Agent gets scoped user credentials through
  the Rovo MCP server; the grader uses a separate admin token and scores against
  oracle ticket state the agent can't write to. Reset = delete and reseed via
  API between episodes (or rotate sandboxes per batch). Tira records
  claim→evidence→verdict on real tool calls; replay strip renders the run.
- Week 2: one irreversible gate (merge/deploy behind tira gate), still against
  real surfaces where they exist.
- Week 3: the mirror — GitHub PR check adapter pointed at a real free-tier repo
  first (same principle), never a GitHub clone.
- Week 4: Slack sim + headless governor's inbox; timed triage beats log-reading.
  (Slack keeps a sim until a real-surface path is proven — the principle, not
  the specific tool, is the rule.)
- Then: real adapters, each validated against its real surface first. A
  partnership conversation with an RL-gym provider runs in parallel from week 1
  and never blocks — if it lands, their environments swap in as the backend
  with the record schema unchanged.

**What this gives up (eyes open):** determinism and massive parallelism. Jira
Cloud rate limits become the main friction, and resets are slower than a
Dockerized clone. If thousands of parallel deterministic envs are ever needed,
that's phase two — a Harbor-style containerized clone, not the path to first
real signal. The remaining sim-to-real gap after this is data distribution
(synthetic tickets vs. messy real ones) — a data problem, not a tooling
problem, and a much cheaper one to fix.

**Environment surfaces (customer #2):** real where borrowable, simulated where
not. Jira is NOT simulated — a real Jira Cloud sandbox (free tier) seeded with
synthetic tickets, driven through the Rovo MCP server, is the environment; the
grader holds a separate admin token against oracle state the agent can't write
to. GitHub follows the same principle (real free-tier repos before any clone).
Sims remain only for surfaces with no borrowable production equivalent (Slack
verdict lines, rate limits, delivery latency; email/calendar triggers) — and a
Harbor-style containerized clone stays a phase-two option if massive parallel
deterministic envs are ever needed. Either way the tira record schema is
identical: real or simulated, every tool call is a claim with evidence and
every verifier output is a verdict.

## Design partners

- **Deccan AI** — design partnership conversation in progress: pilot tira's
  verified work record on one STARK simulated environment. "Deccan builds the
  gym; tira keeps the scorecard." Tira reduces the cost of *trusting agent runs*.
- **Wisdom AI** — evaluating fit (Slack-native workflow agents).
- **LangSmith / LangGraph** — Tira++ roadmap angles drafted: for LangSmith,
  the governance layer LangSmith doesn't have (eval-gated promotions,
  cross-thread run ledger); for LangGraph, the portfolio layer above threads.

## Open decisions

- Build-vs-partner on the sim environment (routed around by sequencing, still
  owed as a decision); which workflows get simulated first after the
  dispatch-loop shape; headless vs full adapters timing.
- Video anatomy (3-beat vs 4-beat); which tira workstream gets graphed.

## What kills tira (watch items)

- LangGraph ships a portfolio-level ledger with declared work-order states
  (they own threads + watching runs — the ledger is their missing third pillar).
- LangSmith adds write-path gates ("block deploy on eval fail") and becomes
  governance.
- AMP publishes an open spec *with* a work-order state model, or enterprises
  universally accept Jira as the agent control plane.
- The open questions underneath: who owns agent governance (IT/security vs
  the tech lead)? Do enterprises want work-state portable outside Atlassian?

## The acceptance test

The transition is done the morning the orchestrator catches his own agent
infrastructure in a lie by glancing at the inbox instead of reading the
transcript — the first claimed-silent catch on the factory. For customer #2:
the morning a hackathon builder trusts the tira record over the run logs to
judge whether their agent actually did the work.

## Changelog

- 2026-10-18 (created): holistic synthesis from all tira threads.
- 2026-10-18 (sim-to-real revision): "never simulate what you can borrow" —
  real Jira Cloud sandbox + HUD SDK + Rovo MCP replaces the Jira clone;
  Week 1/Week 3 re-sequenced; Harbor-style containerized clone parked as
  phase two; eyes-open trade (determinism + parallelism) recorded.
