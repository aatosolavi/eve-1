---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-10"
status: proposed
---

# Loop backend prototype results

This is a dated evidence record for the decision in
[`loop-interface.md`](./loop-interface.md), not a second normative design.

## Scope

The experiment runs one pair of eve-owned programs through three actual
adapters:

| Surface  | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Mechanism test                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared   | [`runSession`](../packages/eve/src/internal/testing/loop-prototype/session-program.ts), [`runTurn`](../packages/eve/src/internal/testing/loop-prototype/turn-program.ts), [`LoopBackend`](../packages/eve/src/internal/testing/loop-prototype/types.ts), [`program-effects.ts`](../packages/eve/src/internal/testing/loop-prototype/program-effects.ts), [`effect-definitions.ts`](../packages/eve/src/internal/testing/loop-prototype/effect-definitions.ts), and [`checkpoint-protocol.ts`](../packages/eve/src/internal/testing/loop-prototype/checkpoint-protocol.ts) | [`conformance.ts`](../packages/eve/src/internal/testing/loop-prototype/conformance.ts) and [`checkpoint-protocol.test.ts`](../packages/eve/src/internal/testing/loop-prototype/checkpoint-protocol.test.ts) |
| Inline   | [`inline/runtime.ts`](../packages/eve/src/internal/testing/loop-prototype/inline/runtime.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [`inline/runtime.test.ts`](../packages/eve/src/internal/testing/loop-prototype/inline/runtime.test.ts)                                                                                                      |
| Workflow | [`workflow/workflows.ts`](../packages/eve/src/internal/testing/loop-prototype/workflow/workflows.ts) and [`workflow/runtime.ts`](../packages/eve/src/internal/testing/loop-prototype/workflow/runtime.ts)                                                                                                                                                                                                                                                                                                                                                                 | [`workflow/runtime.integration.test.ts`](../packages/eve/src/internal/testing/loop-prototype/workflow/runtime.integration.test.ts)                                                                          |
| Temporal | [`temporal/workflows.ts`](../packages/eve/src/internal/testing/loop-prototype/temporal/workflows.ts), [`temporal/backend.ts`](../packages/eve/src/internal/testing/loop-prototype/temporal/backend.ts), and [`temporal/runtime.ts`](../packages/eve/src/internal/testing/loop-prototype/temporal/runtime.ts)                                                                                                                                                                                                                                                              | [`temporal/runtime.scenario.test.ts`](../packages/eve/src/internal/testing/loop-prototype/temporal/runtime.scenario.test.ts)                                                                                |

The Temporal prototype uses exact TypeScript SDK 1.20.1 development
dependencies. Version 1.20.2 was current during the experiment but was still
inside the repository's 48-hour dependency-age gate. See the
[official 1.20.1 release](https://github.com/temporalio/sdk-typescript/releases/tag/v1.20.1).

## What the common suite proves

The conformance helper defines nine tests, executed unchanged by every
adapter:

1. a task result drives the public result, callback, and ordered terminal event;
2. a local tool executes outside model generation with its own operation ID;
3. a tool failure after generation preserves prior events and advances their
   sequence before terminal failure;
4. approval waits preserve unrelated input for the next turn;
5. spawn handles expose child identity before completion, results retain request
   order, turn streams retain the parent log, and delegated sessions get new
   logs;
6. post-commit response loss reuses the operation ID derived by the shared
   effect definition and does not re-execute the effect under a durable retry;
7. an exhausted generation effect becomes one typed eve-level failed outcome;
8. a thrown effect-infrastructure failure rejects the engine run without a
   callback;
9. a conversation replies, parks, and resumes.

Transcript unit tests separately prove that an unresolved exchange stays
outside `BalancedHistory`. The adapter-specific totals are separate from the
nine shared tests:

| Adapter  | Shared | Adapter mechanics | Total |
| -------- | -----: | ----------------: | ----: |
| Inline   |      9 |                 3 |    12 |
| Workflow |      9 |                 1 |    10 |
| Temporal |      9 |                 1 |    10 |

Core unit tests separately cover the adapter-composed checkpoint protocol,
transcript construction, semantic ID encoding, stream-owned sequence
assignment, idempotent event append, effect result caching and validation, and
versioned JSON envelope rejection. The protocol tests prove exact checkpoint
redelivery, parent-owned identity protection, terminal byte equality, and
rejection after lease return. Program tests prove that checkpoint and effect
protocol failures reject execution instead of becoming domain failures. Those
tests are not counted as adapter conformance.

## Observed engine evidence

### Inline

The adapter calls the programs directly, waits on in-process queues, performs
no automatic retry, and stores checkpoints and events only in memory. Its three
boundary tests prove explicit hard-stop behavior, rejection of delivery to a
terminal task, and loss of a parked conversation when the runtime is closed.
The unchanged shared retry test separately proves that inline executes the
ambiguous-completion operation only once and rejects the run because no retry
can recover its committed result.

This is deliberate non-durability, not best-effort durability.

### Workflow DevKit

The integration test runs through the repository's real
`@workflow/world-local` harness. Effects and event append execute as `"use
step"` functions; public and private waits use Hooks; turns and subagents are
separate workflow runs. Handle internals relay and acknowledge checkpoints; the
actual child run result is authoritative. The adapter joins each eager child
start before publishing `child.started`, which keeps replay from duplicating an
unawaited start. The test observes child IDs before results,
inspects child completion, and checks fault-free equality between native stream
envelopes and the authoritative SQLite event records.

That last check does not make the SQLite append and writable write atomic.
Crash behavior between those writes remains unproved. Root cleanup also does
not yet prove cancellation of detached Workflow child runs.

### Temporal

The scenario test uses
[`TestWorkflowEnvironment.createLocal()`](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment)
and a real Worker. The observed environment reported Temporal CLI 1.7.3 and
Server 1.31.2. History inspection confirms Activity scheduling, Child Workflow
starts, delivery and checkpoint-update Signals, and the acknowledgement Signal
before the turn child completes.

Temporal has no equivalent of Workflow's public durable byte stream in this
design. The prototype therefore appends events through Activities to an
eve-owned SQLite store. Production would need an operational event-store and
Worker-hosting decision.

## Review iterations

The first green suites were not accepted as proof. Failing-before tests exposed
and repaired these defects:

1. checkpoint and protocol errors were mislabeled as exhausted effects;
2. a child terminal checkpoint could bypass parent persistence and
   acknowledgement;
3. delimiter-based semantic IDs could alias;
4. assistant request IDs could diverge from the actual request list;
5. a terminal task accepted later delivery;
6. the retry test counted one idempotency row while executing the scripted
   effect twice;
7. the repository invariant gate rejected four assertions that erased type
   information through `unknown`;
8. a tool failure after `model.generated` reused the caller's stale pre-model
   event sequence, so the failure path collided with its own prior event;
9. a Workflow Hook could report a terminal child checkpoint before the child
   run itself completed;
10. Workflow cleanup discarded root cancellation failures, Temporal accepted a
    later acknowledgement in place of the exact revision, and Temporal retained
    settled root runs;
11. child checkpoint validation checked revision but not the immutable session
    identity;
12. persisted effect results and the `BalancedHistory` constructor trusted
    unvalidated data;
13. shape-valid cached outputs were not correlated with their effect calls;
14. a child could roll back its event cursor or mutate state after returning its
    lease;
15. adapter storage failures became ordinary agent failures, and declared
    failure codes were discarded;
16. a Workflow child failure before its terminal notice stranded the parent;
17. Workflow Hook redelivery treated an exact checkpoint replay as a new state
    transition;
18. `LoopBackend.finish()` could substitute a different public result after the
    original outcome had already driven callback and event publication.

The sixth correction now records attempts separately from executions, commits
the exact result by operation ID, injects failure after that commit, and proves
that a retry reads the committed result. Program, checkpoint, and effect-ledger
protocol errors reject program execution. Backend-reported declared exhaustion
becomes a typed eve-level turn failure. Initialization now belongs to adapter
startup, delivery is no longer a ledger effect, and `finish(outcome)` owns
callback recording plus terminal publication.
The seventh introduced one real `BalancedHistory` constructor and runtime
parsing for SQLite event rows instead of suppressing type errors at those
boundaries. The eighth carries the latest immutable state snapshot with each
declared effect failure; a later failure now appends after all prior successful
events.
The ninth makes the Workflow Hook a wake-up only and the actual child run result
authoritative. The tenth surfaces cancellation failure, consumes exact Temporal
acknowledgements, and removes settled roots. The remaining corrections validate
checkpoint identity, correlate cached results with their calls,
preserve declared failure codes, reject infrastructure at the engine boundary,
make exact checkpoint redelivery idempotent, and make `runSession` the only
owner of the returned terminal value.

Finalization now records the callback before appending `session.terminal`, so
finalization exhaustion cannot leave a terminal event without a callback. The
callback, event, engine result, and Workflow stream are still separate commits;
the canonical plan names their atomic publication as a production gate.

The approval scenario was also strengthened: unrelated input arrives while an
approval is pending, the original request is approved, and the buffered input
then starts a second approval/reply cycle. The child scenario configures
opposite delays and verifies request-order results plus independent subagent
event logs; it does not independently observe engine-completion order.

## Reproduction

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts \
  src/internal/testing/loop-prototype/checkpoint-protocol.test.ts \
  src/internal/testing/loop-prototype/programs.test.ts \
  src/internal/testing/loop-prototype/transcript.test.ts \
  src/internal/testing/loop-prototype/service.test.ts \
  src/internal/testing/loop-prototype/wire.test.ts \
  src/internal/testing/loop-prototype/inline/runtime.test.ts

pnpm --filter eve exec vitest run --config vitest.integration.config.ts \
  src/internal/testing/loop-prototype/workflow/runtime.integration.test.ts

pnpm --filter eve exec vitest run --config vitest.scenario.config.ts \
  src/internal/testing/loop-prototype/temporal/runtime.scenario.test.ts
```

The final focused runs were:

```text
focused unit:    39/39, 0.34s total
Workflow local:  10/10, 43.05s total, 39.20s tests
Temporal local:  10/10, 25.27s total, 15.21s tests
```

These are harness startup and bundling receipts, not request-latency
benchmarks. Temporal produced a 1.65 MiB Workflow bundle in the observed run.

The refactor validation passed `pnpm fmt`, `pnpm lint`, all 22 workspace
typecheck tasks, the 39 focused unit tests, the 10 Workflow integration tests,
and the 10 Temporal scenario tests.

The five direct Temporal dependencies add 1,180 lines to `pnpm-lock.yaml` in
this branch. They are development-only in the prototype, but the transitive
graph is a real adoption cost.

## What is not proved

- continuation-token claim, rekey, retired-hook drain, and provisional delivery
  release races;
- atomic terminal publication, exactly-once live streaming, or crash-safe
  mirroring between event sinks;
- payload-codec adoption at every adapter boundary;
- production pinned/latest deployment routing;
- published-build packaging and host/backend selection;
- graceful session cancellation and descendant cleanup;
- idempotent Workflow child start after ambiguous step completion;
- exactly-once private Workflow control delivery;
- mixed approval batches;
- kill-and-restart recovery during a parked wait or ambiguous effect completion;
- idempotency behavior of actual model providers and authored tools.

These are named production gates in the canonical plan. No prototype result is
used as evidence for them.
