# Event Architecture SSOT

**Status:** Enforcing (built 2026-10-15 from `proposal-event-architecture-ssot-20261015.md` at spec-emitted)
**Source:** Mac-only, syncs to VM via device.invoke (ruled 2026-10-15)

This document names every event in the factory — what emits it, what stream it writes to, who consumes it, and what happens if it's missing. No phantom events.

**Field convention:** snake_case, `*_id` for identifiers, `*_at` for timestamps (ISO 8601). Each event lists fields with types.

---

## 1. Event Catalog

### Safety Consumer Events

| Event | Emitter | Stream | Fields | Trigger |
|-------|---------|--------|--------|---------|
| `gap.proposed` | VM (gap filing) | factory-events.jsonl | gap_id: string, description: string, proposed_by: string, proposed_at: string | A new gap is identified |
| `gap.filed` | Mac (gaps.mjs) | gaps.jsonl | gap_id: string, description: string, owner: string, filed_by: string, filed_at: string | `gap.proposed` accepted, gap created |

**Lifecycle:** gap: proposed → filed → disposed → resolved

### Walker Events (R6)

| Event | Emitter | Stream | Fields | Trigger |
|-------|---------|--------|--------|---------|
| `job.blocked` | Walker | factory-events.jsonl | job_id: string, blocked_by: string[], blocked_at: string | A job's dependencies are not complete |
| `job.unblocked` | Walker | factory-events.jsonl | job_id: string, unblocked_by: string, unblocked_at: string | All blockers complete |
| `job.complete` | Build machine / Operator | factory-events.jsonl | job_id: string, evidence: string, completed_at: string | DONE drop with passing done-test, or operator ruling |
| `sequence.updated` | Walker | factory-events.jsonl | ranked_order: string[], ranker_version: string, override: object\|null, updated_at: string | Frontier changes |
| `sequence.diverged` | Walker | factory-events.jsonl | adherence_pct: number, leverage_pct: number, threshold: string, diverged_at: string | Adherence <50% or leverage <50% over 5 completions |

**Lifecycle:** job: blocked → unblocked → complete; sequence: updated → (diverged → updated)*

### PM Competency Events (AiDASH)

| Event | Emitter | Stream | Fields | Trigger | Status |
|-------|---------|--------|--------|---------|--------|
| `roadmap.decided` | Human (Devansh) | factory-events.jsonl | decision_id: string, evidence_links: string[], decided_at: string | Roadmap decision made | 🟡 Manual |
| `roadmap.published` | Human | factory-events.jsonl | roadmap_id: string, vision_thesis: string, published_at: string | Roadmap published | 🟡 Manual |
| `assessment.written` | Human | factory-events.jsonl | assessment_id: string, thesis: string, falsifier: string, written_at: string | Competitive assessment written | 🟡 Manual |
| `falsifier.due` | System (time) | factory-events.jsonl | assessment_id: string, due_at: string | Falsifier deadline reached | 🔴 Not built |
| `proposal.gated` | Proposal gate | factory-events.jsonl | proposal_id: string, gate_result: string, gated_at: string | Proposal passes gate | 🟢 Live |
| `measure.complete` | Human | factory-events.jsonl | proposal_id: string, promised: number, actual: number, measured_at: string | NSM measured vs promised | 🟡 Manual |
| `spec.published` | Human | factory-events.jsonl | spec_id: string, effort_factored: boolean, published_at: string | Spec published | 🔴 Blocked (spec template) |
| `build.decided` | Human | factory-events.jsonl | decision_id: string, tradeoff: string, decided_at: string | Build tradeoff decided | 🟡 Manual |
| `launch.complete` | Human | factory-events.jsonl | launch_id: string, outcome: string, completed_at: string | Launch completed | 🟡 Manual |
| `stakeholder.move` | Human | factory-events.jsonl | move_id: string, stakeholder: string, move_at: string | Stakeholder move attempted | 🔴 Blocked (provenance) |
| `outcome.observed` | Human | factory-events.jsonl | move_id: string, success: boolean, observed_at: string | Outcome observed (14d) | 🔴 Blocked (provenance) |

**Status key:** 🟢 Live (emitting) | 🟡 Manual (human emits) | 🔴 Blocked (stream doesn't exist)

### Proposal Lifecycle Events

| Event | Emitter | Stream | Fields | Trigger | Status |
|-------|---------|--------|--------|---------|--------|
| `proposal.section_cut` | Human (operator) | factory-events.jsonl | proposal_id: string, section_name: string, reason: string, deferred_to: string\|null, cut_at: string | Section removed during hardening/review | 🟡 Manual |
| `work.deferred` | Human / Machine | factory-events.jsonl | description: string, deferred_from: string, follow_on_proposal_id: string\|null, deferred_at: string | Work explicitly deferred to follow-on | 🟡 Manual |
| `proposal.hardening_initialized` | Hardening machine | hardening-state.jsonl | proposal_id: string, initialized_at: string | Proposal enters hardening | 🟢 Live |
| `proposal.hardening_transition` | Hardening machine | hardening-state.jsonl | proposal_id: string, from_state: string, to_state: string, transitioned_at: string | Proposal moves between stages | 🟢 Live |
| `proposal.spec_emitted` | Hardening machine | hardening-state.jsonl | proposal_id: string, emitted_at: string | Proposal completes hardening | 🟢 Live |

**Lifecycle:** proposal: hardening_initialized → hardening_transition* → spec_emitted

**Triggers deferred-work-check:**
- `proposal.section_cut` → verify `deferred_to` exists, or auto-create stub
- `work.deferred` → verify `follow_on_proposal_id` exists, or auto-create stub
- `ssot.event_removed` → re-check all proposals for phantom references

---

### Other Persisted Events (Pass 2)

| Event | Emitter | Stream | Fields | Trigger | Status |
|-------|---------|--------|--------|---------|--------|
| `hardening.error` | Hardening machine | hardening-errors.jsonl | proposal_id, error_type, detail, at | Hardening step fails | 🟢 Live |
| `fail.recorded` | fail-log.sh (OPA-guarded) | fail-log.jsonl | incident_id, class, detail, at | Incident logged | 🟢 Live |
| `gap.created` | gaps.mjs / process-watcher | gaps.jsonl | gap_id, description, owner, at | Gap filed | 🟢 Live |
| `gap.resolved` | gaps.mjs / process-watcher | gaps.jsonl | gap_id, at, by | Gap resolved | 🟢 Live |
| `gap.assigned` | gaps.mjs | gaps.jsonl | gap_id, owner, at | Gap assigned | 🟢 Live |

---

## 2. Stream Map

| Stream | Path | Format | Writers | Readers | Retention |
|--------|------|--------|---------|---------|-----------|
| factory-events.jsonl | coordination/sync/factory-events.jsonl | JSONL | build-emit, queue-snapshot, push-land-emitters, walker, safety consumer | liveness querier, PM metrics, chief-of-staff | Append-only, permanent |
| gaps.jsonl | coordination/sync/gaps.jsonl | JSONL | gaps.mjs | process-watcher, chief-of-staff | Append-only, permanent |
| outbox-events.jsonl | coordination/sync/outbox-events.jsonl | JSONL | Mac FSEvents watcher | VM relay | Append-only, permanent |
| inbox-events.jsonl | coordination/sync/inbox-events.jsonl | JSONL | Mac FSEvents watcher | VM relay | Append-only, permanent |
| device.invoke | (direct transfer) | File write | VM (orchestrator) | Mac | N/A (point-to-point) |

**Transport paths:**
- **Relay bus:** factory-events.jsonl + outbox/inbox — for Mac↔VM event streaming
- **Direct transfer:** device.invoke files.write — for VM→Mac file delivery (proposals, tools, docs)

---

## 3. Producer→Consumer Matrix

| Event | Producer | Consumers | Status |
|-------|----------|-----------|--------|
| `gap.proposed` | VM gap filing | Safety consumer | 🟡 Producer not built |
| `gap.filed` | gaps.mjs | Safety consumer, process-watcher | 🟢 Live |
| `job.blocked` | Walker | Chief-of-staff, process-watcher | 🟡 Walker not built |
| `job.unblocked` | Walker | Chief-of-staff, process-watcher | 🟡 Walker not built |
| `job.complete` | Build machine / Operator | Walker | 🟡 Walker not built |
| `sequence.updated` | Walker | Chief-of-staff | 🟡 Walker not built |
| `sequence.diverged` | Walker | Chief-of-staff, operator | 🟡 Walker not built |
| `proposal.gated` | Proposal gate | PM metrics | 🟢 Live |
| `roadmap.decided` | Human | PM metrics | 🟡 Manual |
| (PM manual events...) | Human | PM metrics | 🟡 Manual |
| `proposal.hardening_initialized` | Hardening machine | (none) | 🟡 Orphaned |
| `proposal.hardening_transition` | Hardening machine | (none) | 🟡 Orphaned |
| `proposal.spec_emitted` | Hardening machine | (none) | 🟡 Orphaned |
| `proposal.section_cut` | Human | deferred-work-check | 🔴 Not emitted |
| `work.deferred` | Human / Machine | deferred-work-check | 🔴 Not emitted |

**Orphans:** Hardening events (emitted to hardening-state.jsonl, no external consumers). Logged for provenance but not used for automation.
**Ghosts:** Walker events (consumers defined, producers not built yet). These are *planned*, not phantom — the walker proposal specifies them.

---

## 4. Logging and Rollback

**Logging:** Every SSOT change emits:
- `ssot.event_added`: {event_name, added_by, proposal_ref, at}
- `ssot.event_removed`: {event_name, removed_by, reason, at}
- `ssot.event_amended`: {event_name, field_changed, old_value, new_value, amended_by, at}

**Rollback:** 7-day deprecation grace period. Event marked `deprecated`, consumers migrate, then deleted. Orphan checker flags consumers still referencing after 7 days.

**No silent edits.** Every SSOT change has a log event. The orphan checker validates the trail.

---

## 5. Population Lifecycle Events (merged from proposal-event-driven-population-machine-20261015.md)

Events emitted by the population registry when membership or capabilities change.

| Event | Emitter | Stream | Fields | Trigger |
|-------|---------|--------|--------|---------|
| `population.member.added` | Population machine | population-events.jsonl | member_id: string, name: string, environment: string, added_at: string | New machine/capability registered |
| `population.member.removed` | Population machine | population-events.jsonl | member_id: string, name: string, removed_at: string, reason: string | Machine/capability deregistered |
| `population.member.changed` | Population machine | population-events.jsonl | member_id: string, field_changed: string, old_value: string, new_value: string, changed_at: string | Member metadata updated |
| `population.capability.lost` | Population machine | population-events.jsonl | capability_id: string, name: string, lost_at: string, evidence: string | Capability check fails (was passing) |
| `population.capability.regained` | Population machine | population-events.jsonl | capability_id: string, name: string, regained_at: string, evidence: string | Capability check passes (was failing) |
| `population.triangulation.failed` | Population machine | population-events.jsonl | member_id: string, sources: array, disagreement: string, failed_at: string | 2+ verification sources disagree |

**Consumers:** Watcher (subscribes to member.added/removed for auto-discovery), health dashboard (subscribes to capability.lost/regained for alerts), audit log (all events for provenance).
