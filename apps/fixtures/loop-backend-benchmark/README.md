# Loop backend benchmark

This fixture runs the same fixed eve conversation through the inline, Workflow
DevKit, and Temporal loop runtimes. Each sample sends one nonce. The agent must
make exactly one `benchmark_echo` tool call with that nonce, then return only
the tool's deterministic verification string.

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

The runner uses randomized complete blocks. Every block runs all three runtimes
serially in a seeded random order and sends the same nonce to each runtime. The
defaults are 3 warmup blocks and 30 measured blocks.

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

The command builds the fixture once, then starts three child processes with:

```sh
eve start --host 127.0.0.1 --port 0
```

The fixture build deletes only its ignored `.eve` compile directory before
compiling. This prevents a build created with one model kind from being reused
after `EVE_LOOP_BENCHMARK_MODEL_KIND` changes. The build and all three servers
inherit the same model-kind environment.

Each process receives a different `EVE_LOOP_BENCHMARK_RUNTIME` value. The
runner reads the `server listening at <url>` line and stops all three processes
when the matrix finishes, fails, or receives `SIGINT` or `SIGTERM`.
Each process also writes raw server telemetry to its own temporary JSONL file
and receives a separate `WORKFLOW_LOCAL_DATA_DIR`. The three durable engines
share the one immutable build output but no mutable workflow state. The runner
reads the record files after every client sample and deletes the owned temporary
directories during server cleanup.
Its first JSONL record identifies the `local-processes` topology, runtime URLs,
Node.js version, operating system, and CPU architecture.

Override the block counts or seed after `--`:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:local -- --warmups 0 --blocks 5 --seed 42
```

## Vercel Sandbox matrix

The Sandbox command runs all three implementations in one ephemeral Vercel
Sandbox. It clones one exact commit, installs dependencies once, builds the
fixture and its workspace dependencies once, and starts three detached
`eve start` processes:

| Runtime         | Port | Raw server record path                   |
| --------------- | ---: | ---------------------------------------- |
| inline          | 8080 | `/tmp/eve-loop-benchmark-inline.jsonl`   |
| Workflow DevKit | 8081 | `/tmp/eve-loop-benchmark-workflow.jsonl` |
| Temporal        | 8082 | `/tmp/eve-loop-benchmark-temporal.jsonl` |

Each Sandbox process also receives its own `WORKFLOW_LOCAL_DATA_DIR` under
`/tmp`.

The Sandbox uses the Node.js 24 runtime, 4 vCPUs, and a 45-minute timeout. The
runner waits for every public `/eve/v1/health` endpoint before starting the
matrix, so clone, install, build, process startup, and readiness time are not
benchmark samples. The matrix itself remains serial.

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
`vercel-sandbox` topology, exact Git revision, Sandbox name and available
resource metadata, and the three public origins. Setup records contain no
credentials or source-authentication fields. The runner stops the single
Sandbox after success, setup failure, matrix failure, `SIGINT`, or `SIGTERM`.

## Hosted matrix

Pass three external HTTPS origins explicitly:

```sh
pnpm --filter loop-backend-benchmark run --silent benchmark:hosted -- \
  --inline-url https://inline.example.com \
  --workflow-url https://workflow.example.com \
  --temporal-url https://temporal.example.com
```

The equivalent environment variables are:

```sh
EVE_LOOP_BENCHMARK_INLINE_URL=https://inline.example.com \
EVE_LOOP_BENCHMARK_WORKFLOW_URL=https://workflow.example.com \
EVE_LOOP_BENCHMARK_TEMPORAL_URL=https://temporal.example.com \
pnpm --filter loop-backend-benchmark run --silent benchmark:hosted
```

Hosted URLs must be HTTPS origins. Flags take precedence over environment
variables, so the two forms can be mixed.
Set `EVE_LOOP_BENCHMARK_MODEL_KIND` to the model kind used when the remote
servers were built and started. The hosted runner records that value but cannot
verify the remote configuration.
Inline and Temporal require a long-lived topology with shared mutable state.
Direct Vercel Functions are rejected for those runtimes and are not supported
targets for this command.
Generic hosted origins do not expose a record-file reader, so their sample
records report server telemetry as `unavailable`. Use the Sandbox command when
the benchmark must include both client and server layers on Vercel.

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
- paired per-block differences for each runtime pair
- raw server telemetry plus its collection status on every sample
- warmup and measured server-telemetry status counts
- per-runtime percentiles for correctness-gated summed neutral server intervals
- paired server-interval differences from matching client-valid,
  telemetry-complete blocks

Percentiles use the nearest-rank definition. A pair named
`workflow-minus-inline` contains the Workflow client measurement minus the
inline client measurement from the same block. The runner never subtracts
server wall clocks or the event `serverAt` correlation field.

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
same local monotonic client clock. The six phases add to
`sessionWaitingEventReceivedMs`; reducer work remains separately visible in
`reducerTotalMs` and `sessionWaitingReducedMs`.

Provisioning diagnostics, child-process logs, and errors go to standard error.
Redirect standard output as shown above to retain a machine-readable result
file.

## Checks

```sh
pnpm --filter loop-backend-benchmark test
pnpm --filter loop-backend-benchmark typecheck
pnpm --filter loop-backend-benchmark benchmark:compile
```
