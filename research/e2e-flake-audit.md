---
issue: TBD
status: proposed
last_updated: "2026-07-14"
---

# e2e flake audit and hardening plan

## Summary

This audit aggregated every "E2E Tests (Local)" and "E2E Tests (Vercel)" run
from June 27 through July 14, 2026 (1,000 runs per workflow), isolated the
high-confidence flake signal — a fixture job that failed and then passed on a
re-run of the same run ID and commit SHA — and traced each flaky eval to its
failing assertion in job logs and `.eve/evals` artifacts. Every suspected
runtime cause was then verified against eve source.

There were 156 same-SHA flaky fixture job-attempts (50 local, 106 Vercel).
Model nondeterminism is not the dominant cause. Five real eve defects are
verified in code, one of which reproduces with a deterministic mock model and
no LLM at all:

1. the client silently reports success when a stream ends before any turn
   boundary;
2. durable-stream event publication is not replay-safe, so Workflow step
   retries duplicate events;
3. a failed structured-output turn passes `expectOk()` and its output schema
   leaks into the next plain turn;
4. `onSession` re-runs under Workflow step replay despite its once-per-session
   contract; and
5. a partially streamed model response with `finishReason: "other"` is
   accepted as a completed turn.

The remainder splits into avoidable fixture-contract brittleness (prompts and
assertions that require a specific model _strategy_ rather than a semantic
outcome), external-service incidents (live web-search billing and timeouts,
deployment health), and an eval framework that cannot yet express "this
assertion failed because of layer X" — failed `equals` gates print no label,
actual, or expected.

## Flake ledger (same-SHA re-run flips, Jun 27 – Jul 14)

Failed job-attempts whose run later passed at the identical SHA, by fixture:

| Fixture                 | Jobs | Dominant failing evals                                    |
| ----------------------- | ---: | --------------------------------------------------------- |
| `agent-tools`           |   72 | web-search family (73 eval failures incl. judge-scored)   |
| `agent-subagents`       |   37 | `dynamic-workflow` (28), `recursive-root-only` (8)        |
| `agent-basic-runtime`   |   12 | `runtime/output-schema-turn` (12)                         |
| `agent-tools-sandbox`   |   11 | `sandbox/redeploy` (7), curl fanout, persistence          |
| `agent-workflow-stress` |    7 | deterministic mock-model turn loss (7)                    |
| `agent-tools-hitl`      |    7 | `hitl/authored-always-unrelated-input` (7)                |
| `agent-skills`          |    5 | `skills/dynamic-skill*` (5)                               |
| others                  |    5 | one-off (`extensions`, channels, openapi, subagents-hitl) |

Eval-level counts attribute cleanly: ~45% web-search (live provider + prompt
design), ~17% duplicated Workflow events, ~7% structured-output lifecycle,
~4% deterministic stress, and a long tail. A one-day `parallel.ai`
"Insufficient credit" billing incident and a 60-second search timeout also
surfaced inside `noFailedActions` gates, and one Vercel job died waiting for
deployment health — external failures currently indistinguishable from eve
regressions in CI signal.

## Verified eve defects

### 1. Silent success without a turn boundary (client)

`ClientSession.#createEventStream` treats clean EOF and reconnect exhaustion
identically: after the budget (default 3, `client/client.ts:40`) it exits the
generator silently (`client/session.ts:206-210`, with no backoff between
attempts). `MessageResponse.result()` then aggregates whatever arrived, and
status derivation defaults to `"completed"` when no boundary event exists
(`client/session-utils.ts:66-74`). `expectOk()` only rejects `"failed"`
(`evals/session.ts:311-314`).

Proof from artifact `29284192812` (deterministic `agent-workflow-stress`,
mock model): 50 sessions × 2 turns produced 99 of 100 turns;
`stress-session-46` shows `session.waiting` after turn 1 and zero events for
turn 2, yet the eval failed only at a later unlabeled `equals` on the message
text. `readTurn()` already guards this case (`evals/session.ts:194-198`);
`send()` does not.

Contract: a response may resolve only after a terminal boundary; EOF or
reconnect exhaustion before one throws a typed `STREAM_ENDED_BEFORE_TURN_BOUNDARY`
error carrying session ID, start index, reconnect count, and last event type.

### 2. Event publication is not replay-safe (runtime)

Step bodies write events to the durable run stream _during_ execution
(`workflow-steps.ts:246-257`, `dispatch-runtime-actions-step.ts:189-204`,
`harness/runtime-actions.ts:245-267`), but the step only becomes durable when
its completion is acknowledged. The Workflow runtime documents re-executing
step bodies after a crashed or unacknowledged delivery; re-execution rewrites
every event already flushed. Events carry only `meta.at` — no logical ID — and
neither `parseNdjsonStream` nor the client deduplicates.

This exactly matches the largest deterministic cluster: `dynamic-workflow`
failed 28 times with `expected exactly 2 matching subagent.completed event(s),
found 4` — each event duplicated with the same `callId`. `deriveRunFacts`
happens to coalesce tool/subagent _facts_ by callId, so only event-count
assertions and real clients observe the duplication today.

Contract: every logical event has a replay-stable ID; replay cannot expose the
same logical event twice to any stream consumer; attempt metadata is retained
separately for diagnostics.

### 3. Structured-output turn status and schema lifetime (runtime)

An unfulfilled output schema takes the recoverable path
(`harness/tool-loop.ts:2132-2142`): `step.failed` → `turn.failed` →
`session.waiting`. The boundary is `session.waiting`, so the client reports
`"waiting"` and `expectOk()` passes a turn that failed. The schema is cleared
only on success (`tool-loop.ts:2039`); it persists in durable session state
(`execution/session.ts:225-226`) and re-arms `final_output` on the next plain
turn (`tool-loop.ts:828-829`), which is why `runtime/output-schema-turn`
observed `result.completed` on a turn that requested no schema — 12 times.

Contract: turn status reflects turn-local failure even when the session then
waits, and a fresh plain turn clears run-scoped output schema; only a true
continuation (e.g. HITL resume) preserves it.

### 4. `onSession` re-runs under replay (runtime)

The initialized bit is read from durable state but persisted only when the
enclosing turn step commits (`execution/sandbox/ensure.ts:49,149-154` →
snapshot at `workflow-steps.ts:367`). A crash between the callback and step
acknowledgement re-runs `onSession` from stale state. The sandbox persistence
fixture binds a fixed port in `onSession` and fails every subsequent action
when replay re-binds it.

Contract: `onSession` is documented as serialized and retried-after-ambiguous-
failure, receives a stable idempotency key, and eve offers a managed setup
primitive with claim/resume semantics. (Exactly-once arbitrary side effects
across process failure are not promisable and should not be claimed.)

### 5. Partial provider streams complete turns (runtime)

Fully empty model responses are detected and retried once
(`tool-loop.ts:925-931,1713-1741`), but a stream that emitted partial text and
ended with `finishReason: "other"` and no usage metadata is accepted: finish
reason is only consulted as `!== "tool-calls"` (`tool-loop.ts:1764-1767`) and
usage is never validated. Observed as truncated replies mid-sentence after
`load_skill` in `extensions` and `agent-skills` flakes.

Contract: a terminal step with `finishReason: "other"` and absent completion
metadata fails with a typed `MODEL_STREAM_INCOMPLETE` error or receives one
bounded retry, unless the provider adapter proves the finish state terminal.

## Fixture-contract failures (a model is involved, but the fix is ours)

- **Web search (73 eval failures)** — three distinct causes are conflated in
  one eval family: (a) the model answers the NBA Finals prompt from priors or
  refuses on time-reasoning grounds and never calls `web_search` (33 runs show
  `observed tools: []`); (b) the live provider fails (billing, 60 s timeouts);
  (c) judge factuality scores below threshold on otherwise correct summaries.
  Runtime request/result _ordering_ invariants should move to scripted tools;
  live search becomes a canary; prompts must establish the date and mandate
  search when searching is the precondition under test.
- **`recursive-root-only` (8)** — code review refutes a visibility leak:
  advertisement filtering (`advertised-tools.ts:159-168`) and lineage stamping
  (`create-session-step.ts:67-69`) leave no window. The child's
  `RECURSIVE_AGENT_WAS_VISIBLE` reply is unverified model prose relayed by the
  parent. The eval needs the child session's event tree as a fact source (a
  real leak would show an `actions.requested` naming `agent` or a
  `RECURSIVE_AGENT_ROOT_ONLY` block) instead of trusting the model's claim.
- **`sandbox/redeploy` (7)** — six of seven failures are the model passing
  `deploy note` instead of `deploy-note` to `load_skill`. Effective skill
  names are finite at invocation time; `load_skill` should expose them as an
  enum (or normalize), keeping unknown-name suggestions as the error path.
- **`hitl/authored-always-unrelated-input` (7)** — the guarded regression
  (#533/#588 behavior) passes; the queued "unrelated" note then legitimately
  triggers a new `ask_question` park. The eval should assert the approved
  action is not re-gated, without also demanding the model never request
  input. Separately, `succeeded()` reports _all_ historical `input.requested`
  events as "unanswered" (`derive-run-facts.ts:147-152`) — a misleading
  diagnostic to fix.
- **`skills/dynamic-skill*` (6)** — the skill body instructs the model to
  ignore prior context and emit a marker; frontier models increasingly flag
  this as prompt injection and narrate instead of complying. Assert that the
  skill was loaded and its token surfaced, not verbatim-only compliance.
- **Parallel-fanout ordering (`fanout-authored`, `bash-curl-fanout`, 5)** —
  the evals require the model to issue all ten calls in one parallel batch;
  batching 5+5 is valid model behavior. The eve-owned invariant (parallel
  execution of a parallel batch) belongs in a scripted-model contract test.

## Eval framework gaps

- `t.require(x, equals(y))` renders as `✗ equals` — no label, actual, or
  expected — in console and artifact JSON (`expect/index.ts:68-74`,
  `context.ts:96-108`, `reporters/console.ts:71-75`). The stress flake took
  artifact archaeology to diagnose; it should have been one line.
- No default eval timeout exists (`execute-task.ts:51`), and neither workflow
  sets `timeout-minutes`; a hung turn runs to GitHub's 6-hour cap.
- Failures carry no ownership taxonomy; a billing incident, a duplicated
  event, and a model refusal all present as red matrix jobs, so the observed
  recovery behavior is blanket job re-runs — which is how these five product
  defects stayed hidden.
- Only `--strict` distinguishes judge-scored misses from hard gates; there is
  no per-eval attempts/threshold mechanism for legitimately stochastic
  behavior checks.

## Proposed eval semantics

Each eval declares one reliability class, which sets its CI interpretation:

| Class      | Proves                                          | Model          | CI policy                                            |
| ---------- | ----------------------------------------------- | -------------- | ---------------------------------------------------- |
| `contract` | eve state, event, tool, resume semantics        | scripted/mock  | single attempt, always blocking                      |
| `behavior` | a frontier model can drive the authored surface | live           | N fresh attempts, pass threshold; mixed = `unstable` |
| `external` | provider/search/deployment availability         | live + service | reported as canary, non-blocking                     |

```ts
defineEval({
  reliability: { class: "behavior", attempts: 3, requiredPasses: 2 },
  async test(t) {
    const turn = (await t.send("...")).expectOk(); // requires a terminal boundary
    await t.require(turn.message, equals(expected), "final marker");
  },
});
```

Observable semantics, independent of exact names:

- attempts always use fresh sessions; no attempt is silently retried into a
  pass — mixed outcomes surface as `unstable` in console, JSON, and JUnit;
- `expectOk()` requires a terminal boundary and fails on turn-local failure;
- value assertions accept a label and always record actual/expected;
- derived facts expose _unresolved_ input requests and the child-session
  event tree, so HITL and subagent evals assert facts instead of prose;
- every failure is typed by owner: `assertion`, `eve-runtime`,
  `stream-incomplete`, `model-behavior`, `tool-provider`, `deployment`, or
  `fixture-setup`.

The scripted model for contract tests must be able to inspect advertised
tools, emit tool calls and partial content, park on input, close without a
boundary, and inject provider errors — enough to reproduce every defect above
deterministically.

## Next steps

1. **Stop false green (eve client/runtime).** Typed missing-boundary error in
   `MessageResponse.result()` with reconnect diagnostics; turn status derived
   from turn-local failure; `MODEL_STREAM_INCOMPLETE` integrity check; clear
   run-scoped output schema on fresh plain turns. Each lands with a
   deterministic regression test (unit/scenario tier) before any fixture edit.
2. **Replay-safe events (eve runtime).** Stable logical event IDs, idempotent
   append or read-side dedupe, attempt metadata preserved separately. Extend
   `agent-workflow-stress` to assert exact event cardinality under induced
   step retry.
3. **Lifecycle contracts.** Serialized, retry-aware `onSession` with an
   idempotency key and documented semantics; make the sandbox fixture's setup
   idempotent and unpin its fixed port; constrain `load_skill` to effective
   skill names.
4. **Eval API hardening.** Labeled value assertions with actual/expected in
   artifacts; default timeout plus workflow `timeout-minutes`; reliability
   classes with attempts/threshold and the `unstable` verdict in JUnit/JSON;
   failure-ownership taxonomy; unresolved-request and child-session facts.
5. **Re-tier the suite.** Move ordering/cardinality/HITL state-machine and
   recursive-visibility invariants to scripted contract evals; keep focused
   live-model behavior evals asserting semantic outcomes; split web-search and
   deployment availability into canaries with their own alerting.
6. **Measure.** Build a same-SHA flake ledger from JUnit artifacts per
   fixture/model so re-run flips are tracked instead of erased; alert on
   canary availability and on `unstable` behavior evals.

## Success criteria

- Deterministic contract evals show zero mixed outcomes over 500 repeated
  runs on both local and Vercel Workflow backends.
- No client result without a terminal boundary; no duplicated logical event
  observable after induced step replay.
- Every failed assertion names its contract and records actual vs expected;
  every e2e failure is attributable to one owning layer without log
  archaeology.
- Provider/billing incidents surface once, at the canary layer, not as dozens
  of unrelated red fixtures.

## Non-goals

- Accepting "models are nondeterministic" as a terminal root cause.
- Greening CI via blanket re-runs, quarantine lists, or weakened assertions.
- Promising exactly-once arbitrary external side effects across process
  failure.
- Replacing fixture-owned e2e coverage with unit/integration tests.
