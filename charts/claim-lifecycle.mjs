// Claim lifecycle — XState chart for the deterministic tracking MVP.
// One machine per vapor claim. Two actors send events: the sweep (system,
// deterministic: DRAFT_FILE, PROPOSE_NODE) and the human (APPROVE_*,
// REJECT_*). The machine enforces the pipeline order — no stage skipping,
// no approval of what wasn't proposed. Claim state is derived by replay;
// it is never set directly.
//
// States: declared → file_pending → filed → node_pending → materialized
//                                              ↘ dropped (via REJECT with reason)
// materialized and dropped are final. Escalation (SLA breach on a pending
// stage) is a derived predicate over the log, like drain — not a state.

const hasReason = ({ event }) =>
  typeof event.reason === "string" && event.reason.length > 0;

export const claimLifecycle = {
  id: "claim-lifecycle",
  initial: "declared",
  states: {
    declared: {
      on: {
        DRAFT_FILE: "file_pending",
        // APPROVE_*/REJECT_*/PROPOSE_NODE: no transition (invalid by design).
        // A claim cannot be approved or noded before the sweep drafts it.
      },
    },
    file_pending: {
      on: {
        DRAFT_FILE: {}, // idempotent: draft already exists, no-op.
        APPROVE_FILE: "filed",
        REJECT_FILE: {
          target: "dropped",
          guard: hasReason,
        },
        // PROPOSE_NODE here is invalid — the no-skip guard: file first.
      },
    },
    filed: {
      on: {
        APPROVE_FILE: {}, // idempotent: already filed, no-op.
        PROPOSE_NODE: "node_pending",
        // DRAFT_FILE here is invalid — the draft stage is behind us.
        // APPROVE_NODE here is invalid — the no-skip guard: propose first.
      },
    },
    node_pending: {
      on: {
        PROPOSE_NODE: {}, // idempotent: proposal already exists, no-op.
        APPROVE_NODE: "materialized",
        REJECT_NODE: {
          target: "dropped",
          guard: hasReason,
        },
      },
    },
    materialized: {
      // NOTE: not type: "final" — XState completes the actor on final states,
      // which would make the idempotent no-ops below vacuous (dead actor).
      // Terminal by transition table. Found 2026-10-16, hardening pass.
      on: {
        APPROVE_NODE: {}, // idempotent: already materialized, no-op.
        // Everything else: no transition. The node now lives under the
        // node lifecycle machine; the claim's story is over.
      },
    },
    dropped: {
      // Not type: "final" — same reason as above.
      on: {
        REJECT_FILE: {}, // idempotent no-ops for the terminal event.
        REJECT_NODE: {},
        // Everything else: no transition. A dropped claim is never
        // resurrected — re-declare (referencing this claim) instead.
      },
    },
  },
};
