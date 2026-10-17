# Packing — Dashboard-IMDP tracking MVP

How the MVP is packed: which layers are built, which are bought, which are cloned —
decided against the JTBDs with no incumbency bias (assumes nothing already spec'd).

## 1. JTBD checklist (MVP scope only)

| # | Job |
|---|---|
| 1 | Track a branching build depth-first — always know the cursor |
| 2 | Prove a task is done — evidence-gated completion, denials logged |
| 3 | Get interrupted and resume exactly — block on a dependency, cursor returns by replay |
| 4 | Capture discovered work mid-flight — provenance recorded, order stays deterministic |
| 5 | Change my mind honestly — reopen with reason, bare reopen denied |
| 6 | Kill unnecessary work cleanly — cancel as terminal verdict, parent drains on done-or-cancelled |
| 7 | Keep ideas from dying in chat — vapor → file → node pipeline |
| 8 | Approve, don't drive — system proposes, human approves at gates |
| 9 | Know what a finish unlocked — legality, unblocks, backtrack target per completion |
| 10 | Get told what's next, with reasons — deterministic suggestions + receipts |
| 11 | Verify the system isn't lying — replay to any event N, invariant sweeps |

## 2. Packing table

| Layer | Best served by OSS | Why / Why not |
|---|---|---|
| Event log | **SQLite** (interface below; KurrentDB is the named upgrade) | Append-only table, single file, zero ops, queryable. KurrentDB is the right *category* (event-native) but serves storage, not logic — all 11 JTBDs' logic stays custom either way, and single-writer MVP scale doesn't justify the server. |
| Fold engine | — (build) | Pure function over the transition tables; no OSS knows our domain. |
| Transition tables | — (build); JSON Schema validates shape | The 35-pair node table and 36-pair claim table are the spec. Executable form is an implementation choice (JSON + tiny runner preferred over a framework). |
| Write-time guards | — (build) | Plain conditionals (`COMPLETE` without `evidenceRef` → reject). OPA is factory-consistent but overkill inside the MVP. |
| Suggester + completion contract | — (build) | Deterministic functions over the fold. Nothing to buy. |
| Claim pipeline | **Plane approval flows** — best OSS alternative, **rejected** | Shape matches (pending → approve/reject → destination) but splits state across two stores with the bridge as the bug farm. Single store wins. |
| UI (in MVP) | **Build lean**; OSS component primitives; **clone Plane's patterns** | In MVP for manual edge testing (scripted verifiers cover known cases; humans poke the rest). GitHub Projects can't do replay-to-N or derived-state inspection. Clone Plane's design patterns, not its code — check license first. |
| Test runner | **Vitest / node:test** | Commodity. Buy. |
| Repo hosting | **GitHub** | Decided. |

## 3. Storage interface

The event store is the one swappable layer. Everything above speaks this interface;
SQLite implements it for the MVP, KurrentDB can replace the implementation later
without touching the fold, guards, or UI.

```typescript
interface EventStore {
  // Append events to a stream. Validates expectedRevision when given.
  // Duplicate eventId => idempotent no-op (safe retries).
  // Returns the assigned global sequence numbers.
  append(stream: string, events: NewEvent[], opts?: { expectedRevision?: number })
    : Promise<AppendResult>;

  // Read one stream's events. Used for per-tree replay.
  readStream(stream: string,
             opts?: { fromRevision?: number; limit?: number; direction?: 'forwards' | 'backwards' })
    : Promise<StoredEvent[]>;

  // Read the global log across streams, ordered by seq. Used for replay-to-N.
  readAll(opts?: { fromSeq?: number; limit?: number })
    : Promise<StoredEvent[]>;

  // Live tail: catch-up from a position, then stay subscribed. Used by the UI and sweeps.
  subscribe(source: string | '$all', handler: (e: StoredEvent) => void,
            opts?: { fromSeq?: number })
    : Promise<Subscription>; // Subscription.close()
}

interface NewEvent {
  type: string;       // e.g. "node.started", "claim.declared"
  data: object;       // payload — validated by the write path BEFORE append
  metadata?: { actor?: string; causationId?: string };
}

interface StoredEvent extends NewEvent {
  eventId: string;    // uuid, idempotency key, UNIQUE
  stream: string;
  seq: number;        // global, gapless, monotonic — the replay cursor
  streamRevision: number;
  recordedAt: string; // ISO-8601, set by the store
}
```

### Stream layout

One stream per tree: `tasktree-<id>`. Node events (`node.*`) and claim events
(`claim.*`) share the stream — one ordering, one replay, no cross-stream
reconstruction. The `$all` source exists for future multi-tree operation.

### Rules the interface enforces (both implementations)

1. **Append-only is structural, not conventional.** No update/delete operations exist
   on the interface. The SQLite implementation adds `BEFORE UPDATE` / `BEFORE DELETE`
   triggers that abort; KurrentDB is immutable by construction.
2. **The store never validates domain rules.** Guards (evidence on COMPLETE, reason on
   REOPEN, transition legality) run in the write path *before* `append` is called.
   The store guarantees ordering, durability, and idempotency — nothing more.
3. **Idempotent appends.** Re-appending an `eventId` already stored returns the
   original `seq` without duplicating. Retries are always safe.
4. **`seq` is the only ordering that matters.** Folds, replay-to-N, and subscriptions
   all key off `seq`. Wall-clock `recordedAt` is informational.

### SQLite implementation sketch (MVP)

```sql
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream         TEXT NOT NULL,
  stream_revision INTEGER NOT NULL,
  event_id       TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  data           TEXT NOT NULL,   -- JSON, validated upstream
  metadata       TEXT,            -- JSON
  recorded_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_stream ON events(stream, stream_revision);
CREATE TRIGGER no_update_events BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER no_delete_events BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
```

`expectedRevision` is checked in a transaction (`MAX(stream_revision)` per stream).
`subscribe` is a poll loop over `seq` (MVP scale: fine).

### KurrentDB mapping (upgrade path)

| Interface | KurrentDB |
|---|---|
| `stream` | KurrentDB stream (`tasktree-<id>`) |
| `seq` | Global order via `$all` position (implementation detail) |
| `append` + `expectedRevision` | `appendToStream` with expected revision (native optimistic concurrency) |
| `readStream` / `readAll` | `readStream` / `readAll` (native) |
| `subscribe` | Catch-up subscription (native; replaces the poll loop) |
| Append-only | Immutable by construction |

The fold, guards, suggester, pipeline, and UI do not change in the swap —
they only speak the interface.

## 4. UI scope (in MVP)

Purpose: manual edge-scenario testing. Scripted verifiers cover the known pairs;
the UI lets a human poke the unknown ones. Required affordances:

- Event-log viewer (the raw `seq`-ordered log)
- Replay-to-N stepper (scrub the fold to any event)
- Derived-state inspector (cursor, drain flags, suggestions with receipts)
- Manual event injection (write path still enforces guards — denials surface visibly)
- Denial surfacing (rejected writes shown with their reasons)

The UI reads derived state only and writes through the guarded write path —
never state directly.

## 5. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Plane serves nothing in MVP scope | Deep-dived all 11 JTBDs against Plane's data model: hierarchy/order representable, but cursor, replay, guards, suggestions, and contracts are structurally impossible. Its best fits (approval-flow shape for the claim pipeline, Cancelled group) don't survive the single-store rule. |
| D2 | GitHub-as-mirror dropped | Assumed no custom UI; with the lean UI reading derived state, there's nothing to mirror. GitHub returns to git hosting. |
| D3 | Transition tables over framework | The pair tables are the spec; XState was one executable vehicle. JSON + tiny runner is leaner, dependency-free, equally verifiable. (Existing 47/50 checks transfer as the tables.) |
| D4 | Claim pipeline stays in our store | Plane's approval flow is the legitimate buy-alternative; rejected on single-source-of-truth (split-brain bridge is the bug farm). |
| D5 | SQLite now, KurrentDB later, interface between | KurrentDB is the right category but serves storage, not logic; MVP scale doesn't justify the server. The narrow interface makes the upgrade one module. |
| D6 | UI in MVP | Manual edge testing needs replay stepper + derived-state inspector + event injection; scripted verifiers alone leave Isha testing blind. |
| D7 | Chat approvals (Muse/Claude) | Human surface for JTBD 8; mechanism (gates) stays in the write path. |
| D8 | Docs/showcase → Mintlify Starter (free) | Free-tier gates (no AI assistant, no preview deploys, no analytics, 5 seats) don't constrain a two-person public showcase; MDX-in-git keeps Docusaurus as a clean exit. Scalar renders the API reference from the OpenAPI spec; BookStack holds internal knowledge (runbooks, decision logs) outside the repo. |
| D9 | Phase 1 = vertical slice, factory stream first | The first build is end-to-end (store + fold + gates + factory stream vocabulary), not layered. The factory is customer #1: the substrate thesis meets the hardest real user on day one, and the cutover decision gets measured evidence (dual-run divergence) instead of argument. The dashboard scenarios become the executable test suite. Falsifier: if the brief's 3-dimension state doesn't fit the node lifecycle, Phase 1 discovers the needed generalization. |
