// Node lifecycle — XState chart for the deterministic tracking MVP.
// One machine per node. Single writer (the worker) sends events; the system
// appends events and derives state — it never sets node state directly.
// Reviewed by the state-modelling seat 2026-10-16 (hand-walk; chart_check run owed).
//
// States: unstarted → in_progress → done | blocked → in_progress; any live state → cancelled.
// Guarded: COMPLETE needs evidenceRef; REOPEN and BLOCK need a reason.
// done and cancelled are final. There is deliberately NO unstarted → done path (s04).

export const nodeLifecycle = {
  id: "node-lifecycle",
  initial: "unstarted",
  states: {
    unstarted: {
      on: {
        START: "in_progress",
        // BLOCK needs a reason, like REOPEN (Isha's call 2026-10-20): whoever picks the
        // work up finds why it stopped in the record, not in chat.
        BLOCK: {
          target: "blocked",
          guard: ({ event }) =>
            typeof event.reason === "string" && event.reason.length > 0,
        },
        CANCEL: "cancelled",
        // ADD_CHILD here is a no-op on lifecycle (child list is derived from events).
        ADD_CHILD: {},
        // COMPLETE / UNBLOCK / REOPEN: no transition (invalid by design).
      },
    },
    in_progress: {
      on: {
        START: {}, // idempotent no-op. Ruled 2026-10-16 (operator-delegated):
        // duplicates stay no-ops; the event log keeps the evidence, the state doesn't lie.
        BLOCK: {
          target: "blocked",
          guard: ({ event }) =>
            typeof event.reason === "string" && event.reason.length > 0,
        },
        COMPLETE: {
          target: "done",
          guard: ({ event }) =>
            typeof event.evidenceRef === "string" && event.evidenceRef.length > 0,
        },
        CANCEL: "cancelled",
        ADD_CHILD: {},
      },
    },
    blocked: {
      on: {
        UNBLOCK: "in_progress",
        BLOCK: {}, // idempotent: already blocked, no-op.
        CANCEL: "cancelled",
        ADD_CHILD: {},
      },
    },
    done: {
      // NOTE: deliberately NOT type: "final". XState completes the actor on
      // entering a final state, which would make the ruled REOPEN transition
      // unreachable (found 2026-10-16 by the hardening pass — the S6 honest-undo
      // path was unexecutable). Terminality is expressed by the transition
      // table, not by finality.
      on: {
        REOPEN: {
          target: "in_progress",
          guard: ({ event }) =>
            typeof event.reason === "string" && event.reason.length > 0,
        },
        COMPLETE: {}, // idempotent: already done, no-op.
        // START / BLOCK / UNBLOCK / CANCEL / ADD_CHILD: no transition.
        // ADD_CHILD on done is DENIED here — re-open first (proposal §7.2).
      },
    },
    cancelled: {
      // Not type: "final" either — same reason. The idempotent CANCEL no-op
      // below must be a real no-op on a live actor, not a dead one.
      // Cancelled is terminal by transition table (no valid outgoing moves).
      on: {
        CANCEL: {}, // idempotent no-op.
        // Everything else: no transition. Cancelled is terminal.
        // Ruled 2026-10-16 (operator-delegated): done → cancelled stays forbidden.
        // Reopen (with reason) → in_progress → cancel preserves the audit trail.
      },
    },
  },
};
