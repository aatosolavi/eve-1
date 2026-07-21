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
import { parseLoopDeliveryMessage } from "#internal/loops/delivery-message.js";
import { readLoopTemporalDevServer } from "#internal/loops/config.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createTemporalLoopActivities } from "./activities.js";
import {
  TEMPORAL_SESSION_WORKFLOW,
  temporalLoopDeliverySignal,
  type TemporalLoopWorkflow,
  type TemporalLoopWorkflowInput,
} from "./contracts.js";
import { TemporalLoopService } from "./service.js";

const CLEANUP_TERMINATION_REASON = "eve local Temporal loop runtime cleanup";

export interface TemporalLoopRuntimeConfig {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}

export interface TemporalLoopHistoryFacts {
  readonly childWorkflowsStarted: number;
  readonly rekeyScheduledAfterChildCompletion: boolean;
  readonly scheduledActivityTypes: readonly string[];
}

interface TemporalLoopWorker {
  readonly options: { readonly taskQueue: string };
  run(): Promise<void>;
  shutdown(): void;
}

/** Local Temporal implementation of eve's Runtime contract for the loop workload. */
export class TemporalLoopRuntime implements Runtime {
  readonly #compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly #environment: TestWorkflowEnvironment;
  readonly #handles = new Map<string, WorkflowHandleWithStartDetails<TemporalLoopWorkflow>>();
  readonly #nodeId: string | undefined;
  readonly #service: TemporalLoopService;
  readonly #worker: TemporalLoopWorker;
  readonly #workerRun: Promise<void>;
  #closed = false;
  #workerFailure: { readonly error: unknown } | null = null;

  constructor(input: {
    readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
    readonly environment: TestWorkflowEnvironment;
    readonly nodeId?: string;
    readonly service: TemporalLoopService;
    readonly worker: TemporalLoopWorker;
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
    const sessionId = `eve-loop-${randomUUID()}`;
    const continuationToken = input.continuationToken || sessionId;
    this.#service.begin({
      continuationToken,
      sessionId,
      workflowId: sessionId,
    });
    let startedHandle: WorkflowHandleWithStartDetails<TemporalLoopWorkflow> | undefined;

    try {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: this.#compiledArtifactsSource,
        nodeId: this.#nodeId,
      });
      const context = buildRunContext({
        bundle,
        run: { ...input, continuationToken },
      });
      context.set(SessionIdKey, sessionId);
      const serializedContext = serializeContext(context);
      const workflowInput: TemporalLoopWorkflowInput = {
        continuationToken,
        initialMessage,
        requestId: input.requestId,
        serializedContext,
        sessionId,
      };
      const handle = await this.#environment.client.workflow.start<TemporalLoopWorkflow>(
        TEMPORAL_SESSION_WORKFLOW,
        {
          args: [workflowInput],
          taskQueue: this.#worker.options.taskQueue,
          workflowId: sessionId,
        },
      );
      startedHandle = handle;
      this.#service.attachRun({ runId: handle.firstExecutionRunId, sessionId });
      this.#handles.set(sessionId, handle);
      this.#observeResult(sessionId, handle);

      return {
        continuationToken,
        events: this.#service.stream(sessionId),
        sessionId,
      };
    } catch (error) {
      this.#service.fail(sessionId, error);
      if (startedHandle !== undefined) {
        await startedHandle
          .terminate("eve local Temporal loop runtime startup failed")
          .catch(() => {});
        await startedHandle.result().catch(() => {});
        this.#handles.delete(sessionId);
      }
      throw error;
    }
  }

  async deliver(input: DeliverInput): Promise<{ sessionId: string }> {
    this.#assertOpen();
    const address = this.#service.resolve(input.continuationToken);
    if (address === null) throw new RuntimeNoActiveSessionError(input.continuationToken);
    const message = parseLoopDeliveryMessage(input, "Temporal");

    try {
      const handle = this.#environment.client.workflow.getHandle<TemporalLoopWorkflow>(
        address.workflowId,
        address.runId,
      );
      await handle.signal(temporalLoopDeliverySignal, {
        auth: input.auth,
        message,
        requestId: input.requestId,
      });
      return { sessionId: address.sessionId };
    } catch (error) {
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

  async inspectHistory(sessionId: string): Promise<TemporalLoopHistoryFacts> {
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
      throw new AggregateError(cleanupErrors, "Local Temporal loop runtime cleanup failed.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Local Temporal loop runtime is closed.");
    if (this.#workerFailure !== null) {
      throw new Error("Local Temporal loop runtime Worker stopped.", {
        cause: this.#workerFailure.error,
      });
    }
  }

  #observeResult(
    sessionId: string,
    handle: WorkflowHandleWithStartDetails<TemporalLoopWorkflow>,
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

/** Starts a real local Temporal server and Worker for loop runs. */
export async function createTemporalLoopRuntime(
  config: TemporalLoopRuntimeConfig,
): Promise<TemporalLoopRuntime> {
  const [{ TestWorkflowEnvironment }, { Worker }] = await Promise.all([
    loadTemporalTesting(),
    loadTemporalWorker(),
  ]);
  const devServer = readLoopTemporalDevServer();
  const environment = await TestWorkflowEnvironment.createLocal(
    devServer.dbFilename === undefined && devServer.uiPort === undefined
      ? undefined
      : { server: devServer },
  );
  if (devServer.uiPort !== undefined) {
    console.log(`[loops] Temporal Web UI at http://127.0.0.1:${devServer.uiPort}`);
  }
  try {
    const service = new TemporalLoopService();
    const taskQueue = `eve-loop-${randomUUID()}`;
    const worker = await Worker.create({
      activities: createTemporalLoopActivities({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
        service,
      }),
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath: resolveWorkflowsPath(),
    });
    return new TemporalLoopRuntime({
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
    throw new Error('Temporal loop runtime only supports mode "conversation".');
  }
  if (typeof input.input.message !== "string") {
    throw new Error("Temporal loop runtime only supports plain-text messages.");
  }
  if (input.input.message.trim().length === 0) {
    throw new Error("Temporal loop runtime requires a non-empty message.");
  }
  if (input.input.context !== undefined || input.input.outputSchema !== undefined) {
    throw new Error("Temporal loop runtime does not support context or output schemas.");
  }
  if (
    input.callback !== undefined ||
    input.parent !== undefined ||
    input.subagentDepth !== undefined
  ) {
    throw new Error("Temporal loop runtime does not support callbacks or delegated sessions.");
  }
  return input.input.message;
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
    join(packageRoot, "src/internal/loops/temporal/workflows.ts"),
    join(packageRoot, "dist/src/internal/loops/temporal/workflows.js"),
  ];
  for (const candidate of packageCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Cannot find the Temporal loop runtime workflow entrypoint.");
}

function collectRejected(
  results: readonly PromiseSettledResult<unknown>[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}
