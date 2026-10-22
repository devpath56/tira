// subscribe() for any store that reads its log by seq (packing.md §3): catch up from fromSeq,
// then stay subscribed by polling. SQLite and Postgres share it, so live delivery means the same
// thing on both.
// At-least-once: the cursor moves past an event only after the handler settles.
// A handler that keeps failing on one event blocks the ones after it (by design:
// order is the contract); onError reports the consecutive-failure count so the
// caller can decide to close. Known follow-up: backoff / dead-letter.
import { ALL, type ReadAllOptions, type StoredEvent, type SubscribeHandler, type SubscribeOptions, type Subscription } from "./types.ts";

export async function pollSubscribe(
  readAll: (opts: ReadAllOptions) => Promise<StoredEvent[]>,
  source: string,
  handler: SubscribeHandler,
  opts: SubscribeOptions,
  pollIntervalMs: number,
): Promise<Subscription> {
  let next = opts.fromSeq ?? 1;
  let closed = false;
  let draining = false;
  let failing: { seq: number | undefined; attempts: number } = { seq: undefined, attempts: 0 };
  const report = (err: unknown, seq: number | undefined) => {
    failing = { seq, attempts: failing.seq === seq ? failing.attempts + 1 : 1 };
    try {
      opts.onError?.(err, failing);
    } catch {
      // an onError that throws must not take the poll loop down
    }
  };
  const drain = async () => {
    if (closed || draining) return;
    draining = true;
    let current: number | undefined;
    try {
      for (const e of await readAll({ fromSeq: next })) {
        if (closed) return;
        current = e.seq;
        if (source === ALL || e.stream === source) await handler(e);
        next = e.seq + 1;
      }
    } catch (err) {
      report(err, current);
    } finally {
      draining = false;
    }
  };
  await drain();
  const timer = setInterval(() => void drain(), pollIntervalMs);
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
