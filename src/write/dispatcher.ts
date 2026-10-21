// The dispatcher: the single append process (N2) in front of the write path. It
// submits a command, then writes every handoff receiver that is due (handoffs.ts),
// one at a time, re-reading the stream after each: a receiver can make the next one
// due (H2 writes evidence, then drop-written). Receivers are written as the reserved
// actor "dispatcher", with correlationId = the first event of the pair and
// causationId = the event that made it due. A receiver the rules would refuse is not
// written; it stays in the fold's pending report until something changes.
//
// It also relays one request: the orchestrator asking to block a brief. brief.blocked
// is a dispatcher-only event (blockReasonValid), so the dispatcher writes it, with
// requested_by, when the B1 §4 conditions hold, and otherwise logs the orchestrator's
// command as rejected (handoff-refused) with the reason.
import type { EventStore, StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { evaluate } from "../fold/evaluate.ts";
import { foldDetailed, makeView } from "../fold/fold.ts";
import { blockRefusal, due, intentOf, type Receiver, type Rule } from "../fold/handoffs.ts";
import { DISPATCHER } from "../tables/factory.ts";
import { entityKey, type EntityState } from "../fold/types.ts";
import { storedName } from "../fold/events.ts";
import { WritePath, checkCommand, type Command, type WriteResult } from "./write-path.ts";

export interface HandoffWrite {
  rule: Rule;
  key: string; // the receiver's entity
  event: string; // stored type, e.g. "brief.claimable"
  seq: number;
}

export interface DispatchResult {
  result: WriteResult;
  handoffs: HandoffWrite[];
}

// A bound on handoffs per command, so a rule bug can't loop forever.
const MAX_HANDOFFS = 200;

export class Dispatcher {
  readonly writePath: WritePath;
  private readonly store: EventStore;
  private readonly registry: Registry;

  constructor(store: EventStore, registry: Registry, writePath = new WritePath(store, registry)) {
    this.store = store;
    this.registry = registry;
    this.writePath = writePath;
  }

  async submit(cmd: Command): Promise<DispatchResult> {
    const relay = cmd.kind === "event" && cmd.entity.type === "brief" && cmd.event === "BLOCKED" && cmd.actor !== DISPATCHER;
    if (relay) checkCommand(cmd, this.registry); // the caller's command, as sent (the relay rewrites it)
    const result = relay ? await this.relayBlock(cmd as Extract<Command, { kind: "event" }>) : await this.writePath.submit(cmd);
    // A duplicate is a retry, maybe after a crash between the halves of a pair: catch up too.
    const handoffs = result.status === "appended" || result.status === "duplicate" ? await this.catchUp(cmd.stream) : [];
    return { result, handoffs };
  }

  // Write every receiver that is due in this stream. Safe to call any time: after a
  // crash it finishes the pairs that were left half done.
  async catchUp(stream: string): Promise<HandoffWrite[]> {
    const written: HandoffWrite[] = [];
    for (let n = 0; n < MAX_HANDOFFS; n++) {
      const next = await this.nextDue(stream);
      if (!next) return written;
      const same = (r: Receiver) => entityKey(r.target) === entityKey(next.target) && r.kind === next.kind && r.event === next.event && r.correlationId === next.correlationId;
      const stillDue = (events: StoredEvent[]) => {
        const { result, indexes } = foldDetailed(events, this.registry);
        const entities = new Map<string, EntityState>(result.entities.filter((e) => e.stream === stream).map((e) => [e.key, e]));
        const view = makeView(entities);
        // still called for, and still acceptable: if a race made the rules refuse it, skip it
        // (it stays in the pending list) rather than log a rejection under the dispatcher's name
        return due(view, indexes.get(stream) ?? new Map(), this.registry).some(same) && evaluate(this.registry, entities, view, intentOf(next, DISPATCHER)).ok;
      };
      const r = await this.writePath.submitAsDispatcher({
        stream,
        kind: next.kind,
        entity: next.target,
        ...(next.kind === "event" ? { event: next.event as string } : {}),
        payload: next.payload,
        correlationId: next.correlationId,
        causationId: next.causationId,
      } as Command, stillDue);
      if (r.status === "skipped") continue; // someone else wrote it first; look again
      if (r.status !== "appended") return written;
      const name = next.kind === "create" ? this.registry.creationName(next.target.type, next.target.version) : (next.event as string);
      written.push({ rule: next.rule, key: entityKey(next.target), event: `${next.target.type}.${storedName(name)}`, seq: r.seq });
    }
    throw new Error(`dispatcher: more than ${MAX_HANDOFFS} handoffs for one command in ${stream}`);
  }

  private async nextDue(stream: string): Promise<Receiver | undefined> {
    const { view, idx, entities } = await this.snapshot(stream);
    return due(view, idx, this.registry).find((r) => evaluate(this.registry, entities, view, intentOf(r, DISPATCHER)).ok);
  }

  private async relayBlock(cmd: Extract<Command, { kind: "event" }>): Promise<WriteResult> {
    const { view } = await this.snapshot(cmd.stream);
    const reason = cmd.payload?.block_reason;
    const why = blockRefusal(view, view.get(cmd.entity), cmd.actor, reason);
    if (why !== undefined) return this.writePath.refuse(cmd, "handoff-refused", why);
    return this.writePath.submitAsDispatcher({
      ...cmd,
      payload: { block_reason: reason, requested_by: cmd.actor as string },
      ...(cmd.eventId ? { causationId: cmd.eventId } : {}),
    });
  }

  private async snapshot(stream: string) {
    const events = await this.store.readStream(stream);
    const { result, indexes } = foldDetailed(events, this.registry);
    const entities = new Map<string, EntityState>(result.entities.filter((e) => e.stream === stream).map((e) => [e.key, e]));
    return { view: makeView(entities), idx: indexes.get(stream) ?? new Map(), entities };
  }
}
