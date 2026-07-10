import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowHandleWithStartDetails } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";

import type {
  DeliverInput,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
} from "#channel/types.js";
import { SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { createSampleId, type RawRecord } from "#internal/loop-benchmark/contract.js";
import { readLoopBenchmarkRecordPath } from "#internal/loop-benchmark/config.js";
import { readLoopBenchmarkJsonlRecords } from "#internal/loop-benchmark/jsonl-records.js";
import type { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createTemporalBenchmarkActivities } from "./activities.js";
import {
  TEMPORAL_BENCHMARK_WORKFLOW,
  temporalBenchmarkDeliverySignal,
  type TemporalBenchmarkWorkflow,
  type TemporalBenchmarkWorkflowInput,
} from "./contracts.js";
import { LocalTemporalBenchmarkService } from "./service.js";

const CLEANUP_TERMINATION_REASON = "eve local Temporal benchmark cleanup";

export interface LocalTemporalBenchmarkRuntimeConfig {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}

export interface TemporalBenchmarkHistoryFacts {
  readonly childWorkflowsStarted: number;
  readonly rekeyScheduledAfterChildCompletion: boolean;
  readonly scheduledActivityTypes: readonly string[];
}

interface TemporalBenchmarkWorker {
  readonly options: { readonly taskQueue: string };
  run(): Promise<void>;
  shutdown(): void;
}

/** Local Temporal implementation of eve's Runtime contract for the fixed benchmark workload. */
export class LocalTemporalBenchmarkRuntime implements Runtime {
  readonly #compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly #environment: TestWorkflowEnvironment;
  readonly #handles = new Map<string, WorkflowHandleWithStartDetails<TemporalBenchmarkWorkflow>>();
  readonly #nodeId: string | undefined;
  readonly #service: LocalTemporalBenchmarkService;
  readonly #worker: TemporalBenchmarkWorker;
  readonly #workerRun: Promise<void>;
  #closed = false;
  #workerFailure: { readonly error: unknown } | null = null;

  constructor(input: {
    readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
    readonly environment: TestWorkflowEnvironment;
    readonly nodeId?: string;
    readonly service: LocalTemporalBenchmarkService;
    readonly worker: TemporalBenchmarkWorker;
  }) {
    this.#compiledArtifactsSource = input.compiledArtifactsSource;
    this.#environment = input.environment;
    this.#nodeId = input.nodeId;
    this.#service = input.service;
    this.#worker = input.worker;
    this.#workerRun = input.worker.run();
    void this.#workerRun.catch((error: unknown) => {
      this.#workerFailure = { error };
      if (this.#closed) return;
      for (const sessionId of this.#handles.keys()) this.#service.fail(sessionId, error);
    });
  }

  async run(input: RunInput): Promise<RunHandle> {
    this.#assertOpen();
    const initialMessage = parseInitialMessage(input);
    const sessionId = `eve-loop-benchmark-${randomUUID()}`;
    const continuationToken = input.continuationToken || sessionId;
    const sampleId = input.requestId === undefined ? undefined : createSampleId(input.requestId);
    this.#service.begin({
      continuationToken,
      sampleId,
      sessionId,
      workflowId: sessionId,
    });
    const recorder = this.#createControllerRecorder(sampleId, `${sessionId}:run`);
    let startedHandle: WorkflowHandleWithStartDetails<TemporalBenchmarkWorkflow> | undefined;

    try {
      const prepare = async () => {
        const bundle = await getCompiledRuntimeAgentBundle({
          compiledArtifactsSource: this.#compiledArtifactsSource,
          nodeId: this.#nodeId,
        });
        const context = buildRunContext({
          bundle,
          run: { ...input, continuationToken },
        });
        context.set(SessionIdKey, sessionId);
        return serializeContext(context);
      };
      const serializedContext =
        recorder === undefined
          ? await prepare()
          : await recordLoopBenchmarkInterval(recorder, "controller.prepare", prepare);
      const workflowInputWithoutSample = {
        continuationToken,
        initialMessage,
        requestId: input.requestId,
        serializedContext,
        sessionId,
      };
      const workflowInput: TemporalBenchmarkWorkflowInput =
        sampleId === undefined
          ? workflowInputWithoutSample
          : { ...workflowInputWithoutSample, sampleId };
      const dispatch = async () =>
        await this.#environment.client.workflow.start<TemporalBenchmarkWorkflow>(
          TEMPORAL_BENCHMARK_WORKFLOW,
          {
            args: [workflowInput],
            taskQueue: this.#worker.options.taskQueue,
            workflowId: sessionId,
          },
        );
      const handle =
        recorder === undefined
          ? await dispatch()
          : await recordLoopBenchmarkInterval(recorder, "engine.dispatch", dispatch);
      startedHandle = handle;
      this.#service.attachRun({ runId: handle.firstExecutionRunId, sessionId });
      recorder?.engine({
        kind: "temporal.workflow",
        runId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
      });
      this.#handles.set(sessionId, handle);
      this.#observeResult(sessionId, handle);
      scheduleLoopBenchmarkRecorderFlush(recorder);

      return {
        continuationToken,
        events: this.#service.stream(sessionId),
        sessionId,
      };
    } catch (error) {
      this.#service.fail(sessionId, error);
      if (startedHandle !== undefined) {
        await startedHandle
          .terminate("eve local Temporal benchmark startup failed")
          .catch(() => {});
        await startedHandle.result().catch(() => {});
        this.#handles.delete(sessionId);
      }
      scheduleLoopBenchmarkRecorderFlush(recorder);
      throw error;
    }
  }

  async deliver(input: DeliverInput): Promise<{ sessionId: string }> {
    this.#assertOpen();
    const address = this.#service.resolve(input.continuationToken);
    if (address === null) throw new RuntimeNoActiveSessionError(input.continuationToken);
    const message = parseDeliveryMessage(input);
    const recorder = this.#createControllerRecorder(
      this.#service.sampleId(address.sessionId),
      `${address.sessionId}:deliver`,
    );

    try {
      const signal = async () => {
        const handle = this.#environment.client.workflow.getHandle<TemporalBenchmarkWorkflow>(
          address.workflowId,
          address.runId,
        );
        await handle.signal(temporalBenchmarkDeliverySignal, {
          auth: input.auth,
          message,
          requestId: input.requestId,
        });
      };
      if (recorder === undefined) {
        await signal();
      } else {
        await recordLoopBenchmarkInterval(recorder, "engine.signal", signal);
      }
      scheduleLoopBenchmarkRecorderFlush(recorder);
      return { sessionId: address.sessionId };
    } catch (error) {
      scheduleLoopBenchmarkRecorderFlush(recorder);
      if (this.#service.resolve(input.continuationToken) === null) {
        throw new RuntimeNoActiveSessionError(input.continuationToken);
      }
      throw error;
    }
  }

  async getEventStream(
    sessionId: string,
    options?: GetEventStreamOptions,
  ): Promise<ReadableStream<import("#protocol/message.js").HandleMessageStreamEvent>> {
    return this.#service.stream(sessionId, options?.startIndex);
  }

  async inspectHistory(sessionId: string): Promise<TemporalBenchmarkHistoryFacts> {
    const history = await this.#environment.client.workflow.getHandle(sessionId).fetchHistory();
    const events = history.events ?? [];
    const childCompletionIndex = events.findIndex(
      (event) =>
        event.childWorkflowExecutionCompletedEventAttributes !== null &&
        event.childWorkflowExecutionCompletedEventAttributes !== undefined,
    );
    const rekeyScheduleIndex = events.findIndex(
      (event) => event.activityTaskScheduledEventAttributes?.activityType?.name === "rekeySession",
    );
    return {
      childWorkflowsStarted: events.filter(
        (event) =>
          event.childWorkflowExecutionStartedEventAttributes !== null &&
          event.childWorkflowExecutionStartedEventAttributes !== undefined,
      ).length,
      rekeyScheduledAfterChildCompletion:
        childCompletionIndex >= 0 && rekeyScheduleIndex > childCompletionIndex,
      scheduledActivityTypes: events.flatMap((event) => {
        const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
        return name === null || name === undefined ? [] : [name];
      }),
    };
  }

  async records(sampleId: string): Promise<readonly RawRecord[]> {
    const path = readLoopBenchmarkRecordPath();
    if (path === undefined) return [];
    const expected = createSampleId(sampleId);
    return (await readLoopBenchmarkJsonlRecords(path)).filter(
      (record) => record.sampleId === expected,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const cleanupErrors: unknown[] = [];

    collectRejected(
      await Promise.allSettled(
        [...this.#handles.entries()].map(async ([sessionId, handle]) => {
          try {
            await handle.terminate(CLEANUP_TERMINATION_REASON);
            await handle.result().catch(() => {});
          } finally {
            this.#service.settle(sessionId);
          }
        }),
      ),
      cleanupErrors,
    );
    this.#worker.shutdown();
    collectRejected(await Promise.allSettled([this.#workerRun]), cleanupErrors);
    collectRejected(await Promise.allSettled([this.#environment.teardown()]), cleanupErrors);

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Local Temporal benchmark cleanup failed.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Local Temporal benchmark runtime is closed.");
    if (this.#workerFailure !== null) {
      throw new Error("Local Temporal benchmark Worker stopped.", {
        cause: this.#workerFailure.error,
      });
    }
  }

  #createControllerRecorder(
    sampleId: string | undefined,
    attempt: string,
  ): LoopBenchmarkRecorder | undefined {
    return createLoopBenchmarkRecorder({
      actor: "controller",
      attempt,
      hostRole: "controller",
      runtime: "temporal",
      sampleId,
    });
  }

  #observeResult(
    sessionId: string,
    handle: WorkflowHandleWithStartDetails<TemporalBenchmarkWorkflow>,
  ): void {
    void handle.result().then(
      () => {
        this.#handles.delete(sessionId);
        this.#service.settle(sessionId);
      },
      (error: unknown) => {
        this.#handles.delete(sessionId);
        if (!this.#closed) this.#service.fail(sessionId, error);
      },
    );
  }
}

/** Starts a real local Temporal server and Worker for benchmark runs. */
export async function createLocalTemporalBenchmarkRuntime(
  config: LocalTemporalBenchmarkRuntimeConfig,
): Promise<LocalTemporalBenchmarkRuntime> {
  const [{ TestWorkflowEnvironment }, { Worker }] = await Promise.all([
    loadTemporalTesting(),
    loadTemporalWorker(),
  ]);
  const environment = await TestWorkflowEnvironment.createLocal();
  try {
    const service = new LocalTemporalBenchmarkService();
    const taskQueue = `eve-loop-benchmark-${randomUUID()}`;
    const worker = await Worker.create({
      activities: createTemporalBenchmarkActivities({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
        service,
      }),
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath: resolveWorkflowsPath(),
    });
    return new LocalTemporalBenchmarkRuntime({
      compiledArtifactsSource: config.compiledArtifactsSource,
      environment,
      nodeId: config.nodeId,
      service,
      worker,
    });
  } catch (error) {
    await environment.teardown();
    throw error;
  }
}

function loadTemporalTesting(): Promise<typeof import("@temporalio/testing")> {
  const specifier = "@temporalio/testing";
  return import(specifier);
}

function loadTemporalWorker(): Promise<typeof import("@temporalio/worker")> {
  const specifier = "@temporalio/worker";
  return import(specifier);
}

function parseInitialMessage(input: RunInput): string {
  if (input.mode !== "conversation") {
    throw new Error('Temporal benchmark only supports mode "conversation".');
  }
  if (typeof input.input.message !== "string") {
    throw new Error("Temporal benchmark only supports plain-text messages.");
  }
  if (input.input.message.trim().length === 0) {
    throw new Error("Temporal benchmark requires a non-empty message.");
  }
  if (input.input.context !== undefined || input.input.outputSchema !== undefined) {
    throw new Error("Temporal benchmark does not support context or output schemas.");
  }
  if (
    input.callback !== undefined ||
    input.parent !== undefined ||
    input.subagentDepth !== undefined
  ) {
    throw new Error("Temporal benchmark does not support callbacks or delegated sessions.");
  }
  return input.input.message;
}

function parseDeliveryMessage(input: DeliverInput): string {
  const keys = Object.keys(input.payload).filter((key) => key !== "message");
  if (keys.length > 0 || typeof input.payload.message !== "string") {
    throw new Error("Temporal benchmark only supports plain-text follow-up deliveries.");
  }
  if (input.payload.message.trim().length === 0) {
    throw new Error("Temporal benchmark requires a non-empty follow-up message.");
  }
  return input.payload.message;
}

function resolveWorkflowsPath(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const adjacentCandidates = [join(directory, "workflows.ts"), join(directory, "workflows.js")];
  for (const candidate of adjacentCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("eve/package.json"));
  const packageCandidates = [
    join(packageRoot, "src/internal/loop-benchmark/temporal/workflows.ts"),
    join(packageRoot, "dist/src/internal/loop-benchmark/temporal/workflows.js"),
  ];
  for (const candidate of packageCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Cannot find the Temporal benchmark workflow entrypoint.");
}

function collectRejected(
  results: readonly PromiseSettledResult<unknown>[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}
