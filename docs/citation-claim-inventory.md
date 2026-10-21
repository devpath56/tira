# Done-claim inventory: what each claim will cite

Citation-construction packet, slice S1 (`spec-evidence-citations-construction-20261021`, H-032).
This is the falsifier for the spec's riskiest assumption: every done-claim class has a check event
that comes before the claim and can be cited. Only one assumption matters here: a claim class with
nothing to cite would make F1/F2 refuse every claim of that class, or leave it unguarded without
anyone noticing.

Method: every `transition` pair in `charts/*.json` whose target is a finished, verified or
approved state, plus the handoff receivers in `src/fold/handoffs.ts`. The tables were enumerated
with a script over the charts, not read by eye. In S1 the check events exist (`src/tables/checks.ts`)
and resolution runs in shadow (`src/fold/citations.ts`); nothing is refused.

## Done-claim classes that cite a check

| Claim class (stored type) | Table, pair | Check event it cites | Speaks to | Emitted by, today |
|---|---|---|---|---|
| node COMPLETE (`node.complete`) | node-lifecycle, `in_progress + COMPLETE -> done` (guard `hasEvidenceRef`) | `machine-check.reported` | `payload.node` = the node's id | **No live emitter.** No machine check on node work exists in tira today. `machineCheckCommand` (`src/write/checks.ts`) builds the event, and tests write it through the write path as the named component |
| drop VERIFIED (`drop.verified`) | drop, `filed + VERIFIED -> verified` (guard `orchestratorVerifiesPass`) | `done-test.ran` | `payload.brief` + `payload.version` = the drop's brief version | `runDoneTest` (`src/write/checks.ts`), as component `gate`. No done test runs inside tira today: the orchestrator runs it outside and reports only `done_test_result`. This is a new seam, and nothing on the live verify path calls it yet |

## Exceptions: done-claim classes with no check event before them

Each one is named here and was not dropped from the list without a word.

| Claim class | Why there is no check event to cite | What it rests on instead |
|---|---|---|
| tira's own node COMPLETE (`node.complete`, actor `tira`) | A machine close of a drained parent (ruling 2026-10-18). Nothing runs a check: tira closes the parent because every child is terminal | The children's terminal events, and the move it cites in `payload.trigger`. Replay already checks both (`fold.ts`, the pending/settle check). F1/F2 must exempt actor `tira`, or define a cite to the children |
| brief VERIFIED_DONE (`brief.verified-done`) | The dispatcher's H3 relay of `drop.verified` (`handoffs.ts`). It is a receiver, not a claim anyone makes | The drop's VERIFIED, by `correlationId`. It inherits that claim's citation |
| idea APPROVE_FILE / APPROVE_NODE (`idea.approve-file`, `idea.approve-node`) | A person approving a proposal. No machine check exists, or is specced, that could come before a human approval | The approver's actor. If F2 is to cover approvals, it needs a separate rule |

## Transitions into a finished state that are not done claims (listed so their absence is visible)

| Pair | Why it is not a done claim |
|---|---|
| brief-outcome `open + DROP_WRITTEN -> dropped-unverified` | A drop exists but is unverified; the claim is the drop's VERIFIED |
| brief-claim `claimed-silent + EVIDENCE -> claimed-active` | A liveness signal, not completion |
| session `live + ENDED -> ended` | A session ending (`declared_by`), not work done |
| override `active + EXPIRED -> expired` | Time-boxed authority lapsing |
| node / idea `CANCEL`, `REJECT_FILE`, `REJECT_NODE`, drop `REJECTED` | Negative outcomes: nothing is claimed done |
| refusal, label | Born recorded and never move |

## Resolution states (shadow)

`resolveCitation` returns one of `resolving`, `dangling`, `wrong-type`, `wrong-entity`, `post-dated`,
`self-issued`, `stale-blob` or `legacy`, plus its legs (`exists`, `type`, `entity`, `order`,
`issuer`, `blob`). The blob leg is `unverifiable` unless the caller supplies a blob resolver. S4
wires git in as that resolver; S1 tests use a fake one and a real `git hash-object`.
