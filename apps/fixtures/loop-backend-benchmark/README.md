# Loop backend benchmark

This fixture runs the same fixed eve conversation through the inline, Workflow
DevKit, and Temporal loop runtimes. Each sample sends one nonce. The agent must
make exactly one `benchmark_echo` tool call with that nonce, then return only
the tool's deterministic verification string.

The explicit `workflow` selection uses a benchmark-owned Workflow DevKit
session and per-turn child implementation. With no benchmark selection, eve
continues to use its production Workflow runtime.

The default `deterministic` model kind uses a source-backed local model. It
makes the required tool call directly from the nonce and returns the exact tool
output on the second model step. This removes provider and provider-network
variance from the runtime comparison. It does not remove eve model-loop work or
the benchmark's own telemetry cost.

Set `EVE_LOOP_BENCHMARK_MODEL_KIND=live` to use `openai/gpt-5.4`. The `live`
lane measures the provider-inclusive end-to-end path. Any other value fails
while the agent module loads, including during `eve build`.

A successful sample requires one `session.started`, the exact
`message.received`, and two `step.completed` events with the exact shapes
`tool-calls` at step index 0 and `stop` at step index 1. It also requires one
step-zero `actions.requested` call to `benchmark_echo`, the exact final
verification text in the reduced client message, and one `session.waiting`
event. Those boundaries must occur in canonical order. The public production
event stream does not always expose an independent local tool-result event. The
exact final text is the observable proof of the tool output.

Local and Sandbox runs define matched complete blocks. Every block sends the
same nonce once to each runtime. They batch physical execution by runtime so
inactive implementations do not consume the measured host's CPU or memory.
Hosted runs measure one selected runtime. Their block indices identify repeated
samples within that invocation, not paired samples across separate hosted runs.
The defaults are 3 warmup blocks and 30 measured blocks.

## Local matrix

From the repository root, run:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:local > loop-benchmark.local.jsonl
```

That command uses the default deterministic model. To run the live lane:

```sh
EVE_LOOP_BENCHMARK_MODEL_KIND=live \
  pnpm --filter loop-backend-benchmark run --silent benchmark:local \
  > loop-benchmark.local-live.jsonl
```

The command builds the fixture once, then starts one child process at a time
with:

```sh
eve start --host 127.0.0.1 --port 0
```

The fixture build deletes only its ignored `.eve` compile directory before
compiling. This prevents a build created with one model kind from being reused
after `EVE_LOOP_BENCHMARK_MODEL_KIND` changes. The build and every runtime
process inherit the same model-kind environment.

The first block's seeded runtime order determines the batch order. For each
runtime, the runner starts one process, runs all of that runtime's warmups and
then all of its measured samples, and stops the process before starting the next
runtime. Process startup and shutdown are outside the timed sample. A process
receives its `EVE_LOOP_BENCHMARK_RUNTIME` value and stays warm for its entire
batch.

Each process writes raw server telemetry to its own temporary JSONL file and
receives its own `WORKFLOW_LOCAL_DATA_DIR`. The durable engines share the one
immutable build output but no mutable workflow state. The runner reads the
record file after every client sample and deletes the owned temporary directory
when that runtime stops. On `SIGINT` or `SIGTERM`, it stops the one active
process. Graceful shutdown signals only eve so it can drain owned workers and
services in order; the timeout fallback force-kills the detached process group.
Child-process logs are captured for startup errors but otherwise stay quiet. Set
`EVE_LOOP_BENCHMARK_VERBOSE=1` to stream them to stderr while debugging.

The first JSONL record identifies the `local-runtime-batches` topology,
`maxConcurrentRuntimeServers: 1`, the batch order, the process-reuse policy,
Node.js version, operating system, and CPU architecture. Sample `sampleIndex`
values record physical batch order. `orderInBlock` retains the canonical seeded
block metadata used to match runtimes; it is not local wall-clock order.

Runtime-batched paired differences compare matching block inputs, but their two
samples occur in different runtime batches. They therefore do not control for
short-term host drift. Changing the seed can change which runtime batch runs
first.

Override the block counts or seed after `--`:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:local -- --warmups 0 --blocks 5 --seed 42
```

## Vercel Sandbox matrix

The Sandbox command runs all three implementations in one ephemeral Vercel
Sandbox. It clones one exact commit, installs dependencies once, and builds the
fixture and its workspace dependencies once. It then starts one detached eve
process at a time:

| Runtime         | Port | Raw server record path                   |
| --------------- | ---: | ---------------------------------------- |
| inline          | 8080 | `/tmp/eve-loop-benchmark-inline.jsonl`   |
| Workflow DevKit | 8081 | `/tmp/eve-loop-benchmark-workflow.jsonl` |
| Temporal        | 8082 | `/tmp/eve-loop-benchmark-temporal.jsonl` |

Each process receives its own `WORKFLOW_LOCAL_DATA_DIR` under `/tmp`. The runner
keeps that process warm for the runtime's complete batch, sends it `SIGTERM`,
and waits for it to exit before starting the next runtime. At most one runtime
process is active inside the Sandbox.

The Sandbox uses the Node.js 24 runtime, 4 vCPUs, and a 45-minute timeout. The
runner waits for the active runtime's public `/eve/v1/health` endpoint before
starting its batch, so clone, install, build, process startup, readiness, and
shutdown time are not benchmark samples.

The selected commit must be a full 40-character SHA reachable from the Git
source. The default source is the public
`https://github.com/vercel/eve.git` repository. The deterministic lane does not
need a model credential. Both lanes require `VERCEL_OIDC_TOKEN` for Sandbox
creation and authenticated requests to the public eve routes. The script loads
that token from `.env.local` when the file exists:

```sh
export EVE_LOOP_BENCHMARK_GIT_REVISION="$(git rev-parse HEAD)"
pnpm --filter loop-backend-benchmark run --silent benchmark:sandbox \
  > loop-benchmark.sandbox.jsonl
```

The live lane needs an existing Gateway credential:

```sh
export AI_GATEWAY_API_KEY=your-key
export EVE_LOOP_BENCHMARK_MODEL_KIND=live
export EVE_LOOP_BENCHMARK_GIT_REVISION="$(git rev-parse HEAD)"
pnpm --filter loop-backend-benchmark run --silent benchmark:sandbox \
  > loop-benchmark.sandbox-live.jsonl
```

`--git-revision` is the flag equivalent of
`EVE_LOOP_BENCHMARK_GIT_REVISION`. `--git-url` or
`EVE_LOOP_BENCHMARK_GIT_URL` can select a different HTTPS repository. A
private source additionally requires a username from `--git-username` or
`EVE_LOOP_BENCHMARK_GIT_USERNAME` and a token from
`EVE_LOOP_BENCHMARK_GIT_TOKEN`.

For the live lane, the model credential may be either `AI_GATEWAY_API_KEY` or
`VERCEL_OIDC_TOKEN`; when both exist, the command selects
`AI_GATEWAY_API_KEY`. It forwards the model kind to the workspace build and all
three servers, and forwards the selected live credential under its original
environment name. The deterministic lane forwards no model credential.

`VERCEL_OIDC_TOKEN`, model credentials, and `EVE_LOOP_BENCHMARK_GIT_TOKEN` are
environment-only. The command has no flags for secrets, so they do not enter
the process argument list. The runner uses the OIDC token for both the Sandbox
SDK and the eve client's `Authorization` and trusted-OIDC headers. It does not
place that token in the deterministic build or server environment, nor in
setup, sample, or summary records. The runner decodes the token's `project_id`
and `environment` claims to bind the Sandbox servers to the expected Vercel
project; eve still verifies the token's signature, issuer, audience, and
claims on each request. In the live lane only, the same token may also be
selected and forwarded as the model credential when `AI_GATEWAY_API_KEY` is
absent.

The first output line is a `setup` record. It identifies the model kind,
`vercel-sandbox-runtime-batches` topology, exact Git revision, Sandbox name and
available resource metadata, `maxConcurrentRuntimeServers: 1`, runtime batch
order, and process- and Sandbox-reuse policies. Setup records contain no
credentials or source-authentication fields. The runner stops the single
Sandbox after success, setup failure, matrix failure, `SIGINT`, or `SIGTERM`.

## Hosted runtime

A hosted invocation measures one already-running runtime. By default, the
command targets the Workflow deployment at
`https://loop-backend-benchmark-preview.playground-vercel.tools`:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:hosted \
  > loop-benchmark.workflow.vercel.jsonl
```

Override that default with exactly one of `--inline-url`, `--workflow-url`, or
`--temporal-url`. The equivalent environment variables are
`EVE_LOOP_BENCHMARK_INLINE_URL`, `EVE_LOOP_BENCHMARK_WORKFLOW_URL`, and
`EVE_LOOP_BENCHMARK_TEMPORAL_URL`. Supplying more than one origin is an error.
URLs must be bare HTTPS origins without credentials, a path, query, or
fragment.

The command loads `.env.local` when present and requires `VERCEL_OIDC_TOKEN` for
the fixture's hosted eve channel. It sends the token through the eve
client's Vercel OIDC authentication and never writes it to JSONL.

The selected URL option supplies the runtime identity recorded in the result.
The runner cannot inspect the remote process to verify that identity. Build and
start the deployment with the matching `EVE_LOOP_BENCHMARK_RUNTIME` value. Set
`EVE_LOOP_BENCHMARK_MODEL_KIND` to the same value during the deployment build,
the remote process startup, and the benchmark invocation. The hosted runner
records the model kind but cannot change or verify the deployed model.

For a provider-inclusive Workflow run, build and start the deployment with:

```sh
EVE_LOOP_BENCHMARK_RUNTIME=workflow
EVE_LOOP_BENCHMARK_MODEL_KIND=live
```

The deployment also needs model-provider authentication. Direct Vercel
Functions support the Workflow implementation. Inline and Temporal require a
long-lived host with shared mutable state; use the Sandbox command to compare
all three implementations on Vercel infrastructure.

Hosted measurements use only the client's monotonic clock. They include the
HTTP acknowledgment, streamed protocol boundaries, reducer work, and terminal
`session.waiting` event. The command does not read a remote record file, so all
server telemetry is `unavailable` by design.

Each hosted invocation has a new run ID and runs at a different time. The HTML
report can display separate hosted result files side by side, but it does not
treat cross-file differences as matched-block or paired measurements. Hosted
mode therefore does not accept `--seed`.

## JSONL output

Standard output contains JSONL only. The local and Sandbox commands write a
secret-free `setup` record first. Every command then writes one `sample` record
for every warmup and measured sample, including `valid`, `invalid`, and
`failed` results, and one final `summary` record. Setup, sample, and summary
records all carry `modelKind`, so deterministic and live results cannot be
mistaken for each other. The summary also includes:

- correctness counts for warmup and measured samples
- p50, p90, and p95 for correctness-gated client metrics
- a client-observed protocol layercake from POST acknowledgment through
  `session.waiting`
- paired per-block differences when one run contains both runtimes
- raw server telemetry plus its collection status on every sample
- warmup and measured server-telemetry status counts
- per-runtime percentiles for correctness-gated summed neutral server intervals
- paired server-interval differences from matching client-valid,
  telemetry-complete blocks when both runtimes ran

Percentiles use the nearest-rank definition. A pair named
`workflow-minus-inline` contains the Workflow client measurement minus the
inline client measurement from the same block. A single-runtime hosted run has
no paired differences. The runner never subtracts server wall clocks or the
event `serverAt` correlation field.

Server interval durations are calculated only inside one record whose start
and end use the same monotonic clock domain. Repeated intervals with the same
neutral name are summed within each sample before percentile calculation. A
paired server difference exists only when both runtimes completed telemetry,
both client results are valid, and both sides contain that interval name. Raw
records remain in each sample record for later audit.

The layercake names only the event boundaries the client observed. For example,
`sessionStartedToToolRequestEventReceivedMs` includes everything between
receiving `session.started` and receiving `actions.requested`; it does not claim
that the whole interval was model execution. All layercake durations use the
same local monotonic client clock. The six post-ack phases add to
`sessionWaitingEventReceivedMs - postAckMs`; including `postAckMs`, seven
segments span request start through `session.waiting`. Reducer work remains
separately visible in `reducerTotalMs` and `sessionWaitingReducedMs`.

Provisioning diagnostics, child-process logs, and errors go to standard error.
Redirect standard output as shown above to retain a machine-readable result
file.

## HTML report

Render one local or Vercel JSONL result as a self-contained HTML report:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:report -- \
  loop-benchmark.local.jsonl \
  --output loop-benchmark.local.html
```

Pass multiple result files to compare runs without pooling their samples:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:report -- \
  loop-benchmark.local.jsonl loop-benchmark.vercel.jsonl \
  --output loop-benchmark.html
```

The report shows client-observed end-to-end percentiles, the additive mean
protocol layercake, correctness and telemetry exclusions, and available neutral
server intervals. Local and Sandbox runs also show paired implementation deltas
against inline. It keeps model kinds and execution targets visibly separate.
Omit `--output` to write HTML to standard output.

## Checks

```sh
pnpm --filter loop-backend-benchmark test
pnpm --filter loop-backend-benchmark typecheck
pnpm --filter loop-backend-benchmark benchmark:compile
```
