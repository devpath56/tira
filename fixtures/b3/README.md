# B3 blind fixture, round 1

The blind test of the divergence report (build-plan §7, decided 2026-10-19): Isha plants,
Devansh writes the differ blind, the machine scores.

**M = 8.** Eight divergences are planted between the two files below. The manifest (which
event ids, which kinds) is held outside the repo until your verdicts are locked.

| File | Side | Format |
|---|---|---|
| `factory-state.jsonl` | The factory's file state | The locked format: one record per committed transition |
| `tira-log.jsonl` | tira's log, stream `factory-b3` | tira's own format: one stored event per line, in `seq` order |

Both come from one real factory run through tira's dispatcher, with fx: event ids as the
factory emits them (B2). The divergences were planted between the two afterwards.

## `factory-state.jsonl`

`{transition_kind, entity_type, entity_id, ts, outcome, actor, event_id}`, all strings:

| Field | Meaning |
|---|---|
| `transition_kind` | The table event (`DISPATCHED`, `CLAIMED`, `VERIFIED`, `REJECTED`, `RENAMED`, `ENDED`, `DENIED`), or for a birth the type's birth name (`NAMED`, `CREATED`, `REVISED`, `FILED`) |
| `entity_type` | `brief`, `session` or `drop` |
| `entity_id` | The id, plus `@version` for versioned types (`b1@1`, `s1`) |
| `ts` | When the factory committed it (ISO-8601, `Z`). Not tira's store time |
| `outcome` | What the transition did, as the factory recorded it: `created`, `transition` or `noop` |
| `actor` | The trigger |
| `event_id` | The transition's fx: key: `fx:` + sha256 of the transition (README, "Factory event writing") |

## `tira-log.jsonl`

One stored event per line: the same objects `tira log --json` prints as one array.

| Field | Meaning |
|---|---|
| `eventId` | The id it was written with. Factory transitions carry their fx: key |
| `seq`, `streamRevision`, `stream` | Position in the log (global seq, per-stream revision); `stream` is `factory-b3` |
| `type` | `<entity type>.<event>`, lowercase with dashes: `brief.dispatched`, `session.named`, `drop.filed`, … |
| `data.entity` | `{ id, version? }`; the type is the part of `type` before the dot |
| `data.payload` | The transition's payload |
| `metadata.actor` | Who wrote it; `metadata.correlationId` / `causationId` on handoffs |
| `recordedAt` | tira's store time (not comparable to the factory's `ts`) |

A command tira refused is stored too, as `type: "command.rejected"`, with the refused command
in `data.intent` (`{ kind, entity: { type, id, version? }, event?, payload, actor }`) and the
reason in `data.reason`. It keeps the command's event id.

**By design, not divergences:** events tira's dispatcher writes itself (actor `dispatcher`,
non-fx ids: `brief.claimable`, `brief.evidence`, `brief.drop-written`, `brief.verified-done`,
relayed blocks, …). They are handoff receivers inside tira, so the factory has no record of
them.

## Verdicts and scoring

One verdict per event id that appears in either file: every factory `event_id`, and every
fx: `eventId` in tira's log.

| Verdict | As I read it (say if yours differ before you run) |
|---|---|
| `OK` | In both files, the same transition on the same entity |
| `MISSING` | The factory committed it; tira has no event with that id |
| `PHANTOM` | tira has a factory (fx:) event the factory has no record of |
| `WRONG-ENTITY` | Both have the id, but the entity differs |
| `DUPLICATE` | The same event id appears more than once in one file |
| `ORPHAN` | A transition on an entity that was never born |

Lock your verdicts (post them on the ticket), then the manifest is revealed and scoring is
mechanical: each event id's verdict against the manifest's. The bar: all 8 caught, 0 false
positives on the clean transitions.

`test/fixture-b3.test.ts` checks the files keep this format and that tira's side is a
genuine log (it folds with no anomalies, and every fx: id is its own transition's key). It
says nothing about the plants.
