import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowHandleWithStartDetails } from "@temporalio/client";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import { eventLogId, executionId } from "../ids.js";
import { DeclaredEffectFailure, EffectProtocolError, SqlitePrototypeService } from "../service.js";
import type {
  Delivery,
  EffectCall,
  EffectResult,
  EventLogId,
  EventRecord,
  OperationId,
  PrototypeRun,
  PrototypeRuntime,
  SessionId,
  PrototypeStartInput,
  TerminalOutcome,
} from "../types.js";
import {
  TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL,
  TEMPORAL_SESSION_WORKFLOW,
  temporalDeliverySignal,
} from "./contracts.js";
import type { TemporalActivities, TemporalSessionWorkflow } from "./contracts.js";

const CLEANUP_TERMINATION_REASON = "eve Temporal prototype cleanup";

export interface TemporalHistoryFacts {
  readonly acknowledgementPrecededCompletion: boolean;
  readonly activityTasksScheduled: number;
  readonly childWorkflowsStarted: number;
  readonly signalNames: readonly string[];
}

export interface TemporalPrototypeRun extends PrototypeRun {
  readonly workflowId: string;
}

export class TemporalPrototypeRuntime implements PrototypeRuntime {
  readonly #environment: TestWorkflowEnvironment;
  readonly #runs = new Set<TemporalPrototypeRunState>();
  readonly #service: SqlitePrototypeService;
  readonly #tempRoot: string;
  readonly #worker: Worker;
  readonly #workerRun: Promise<void>;
  #closed = false;
  readonly kind = "temporal";
  readonly taskQueue: string;

  constructor(input: {
    readonly environment: TestWorkflowEnvironment;
    readonly service: SqlitePrototypeService;
    readonly taskQueue: string;
    readonly tempRoot: string;
    readonly worker: Worker;
  }) {
    this.#environment = input.environment;
    this.#service = input.service;
    this.#tempRoot = input.tempRoot;
    this.#worker = input.worker;
    this.taskQueue = input.taskQueue;
    this.#workerRun = this.#worker.run();
    void this.#workerRun.catch(() => {});
  }

  async attemptCount(operationId: OperationId): Promise<number> {
    return this.#service.attemptCount(operationId);
  }

  async callback(sessionId: SessionId): Promise<TerminalOutcome | null> {
    return this.#service.callback(sessionId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const cleanupErrors: unknown[] = [];
    collectRejected(
      await Promise.allSettled([...this.#runs].map(async (run) => await run.stop())),
      cleanupErrors,
    );
    this.#worker.shutdown();
    collectRejected(await Promise.allSettled([this.#workerRun]), cleanupErrors);
    collectRejected(
      await Promise.allSettled([this.#environment.teardown(), this.#service.close()]),
      cleanupErrors,
    );
    collectRejected(
      await Promise.allSettled([rm(this.#tempRoot, { force: true, recursive: true })]),
      cleanupErrors,
    );

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Temporal prototype cleanup failed.");
    }
  }

  async events(logId: EventLogId): Promise<readonly EventRecord[]> {
    return await this.#service.read(logId);
  }

  async executionCount(operationId: OperationId): Promise<number> {
    return this.#service.executionCount(operationId);
  }

  async inspectHistory(workflowId: string): Promise<TemporalHistoryFacts> {
    const history = await this.#environment.client.workflow.getHandle(workflowId).fetchHistory();
    const events = history.events ?? [];
    const signalNames = events.flatMap((event) => {
      const name = event.workflowExecutionSignaledEventAttributes?.signalName;
      return name === null || name === undefined ? [] : [name];
    });
    const acknowledgementIndex = events.findIndex(
      (event) =>
        event.workflowExecutionSignaledEventAttributes?.signalName ===
        TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL,
    );
    const completionIndex = events.findIndex(
      (event) =>
        event.workflowExecutionCompletedEventAttributes !== null &&
        event.workflowExecutionCompletedEventAttributes !== undefined,
    );

    return {
      acknowledgementPrecededCompletion:
        acknowledgementIndex !== -1 && completionIndex > acknowledgementIndex,
      activityTasksScheduled: events.filter(
        (event) =>
          event.activityTaskScheduledEventAttributes !== null &&
          event.activityTaskScheduledEventAttributes !== undefined,
      ).length,
      childWorkflowsStarted: events.filter(
        (event) =>
          event.childWorkflowExecutionStartedEventAttributes !== null &&
          event.childWorkflowExecutionStartedEventAttributes !== undefined,
      ).length,
      signalNames,
    };
  }

  async start(input: PrototypeStartInput): Promise<TemporalPrototypeRun> {
    if (this.#closed) throw new Error("Temporal prototype runtime is closed.");

    const workflowExecutionId = executionId(`${input.sessionId}:execution`);
    const workflowId = workflowExecutionId;
    const logId = eventLogId(`${input.sessionId}:events`);
    const handle = await this.#environment.client.workflow.start<TemporalSessionWorkflow>(
      TEMPORAL_SESSION_WORKFLOW,
      {
        args: [
          {
            executionId: workflowExecutionId,
            input: sessionProgramInput(input),
            kind: "session",
            routingIntent: "pinned",
            streamLogId: logId,
            taskQueue: this.taskQueue,
          },
        ],
        memo: { eveRoutingIntent: "pinned" },
        taskQueue: this.taskQueue,
        workflowId,
      },
    );
    const run = new TemporalPrototypeRunState(handle, logId, input.sessionId, this.#service);
    this.#runs.add(run);
    void run.result.finally(() => this.#runs.delete(run)).catch(() => {});
    return run;
  }

  async visibleEffectCount(operationId: OperationId): Promise<number> {
    return this.#service.visibleEffectCount(operationId);
  }
}

class TemporalPrototypeRunState implements TemporalPrototypeRun {
  readonly #eventLogId: EventLogId;
  readonly #handle: WorkflowHandleWithStartDetails<TemporalSessionWorkflow>;
  readonly #service: SqlitePrototypeService;
  #settled = false;
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;
  readonly workflowId: string;

  constructor(
    handle: WorkflowHandleWithStartDetails<TemporalSessionWorkflow>,
    eventLogId: EventLogId,
    sessionId: SessionId,
    service: SqlitePrototypeService,
  ) {
    this.#eventLogId = eventLogId;
    this.#handle = handle;
    this.#service = service;
    this.backendRunId = handle.firstExecutionRunId;
    this.sessionId = sessionId;
    this.workflowId = handle.workflowId;
    this.result = handle.result().then(
      (outcome) => {
        this.#settled = true;
        return outcome;
      },
      (error: unknown) => {
        this.#settled = true;
        throw error;
      },
    );
    void this.result.catch(() => {});
  }

  async deliver(delivery: Delivery): Promise<void> {
    if (this.#settled) throw new Error(`Temporal run "${this.backendRunId}" is terminal.`);
    await this.#handle.signal(temporalDeliverySignal, delivery);
  }

  async events(): Promise<readonly EventRecord[]> {
    return await this.#service.read(this.#eventLogId);
  }

  async stop(): Promise<void> {
    if (this.#settled) return;
    await this.#handle.terminate(CLEANUP_TERMINATION_REASON);
    await this.result.catch(() => {});
  }
}

export async function createTemporalPrototypeRuntime(): Promise<TemporalPrototypeRuntime> {
  const tempRoot = await mkdtemp(join(tmpdir(), "eve-loop-temporal-"));
  const service = new SqlitePrototypeService(join(tempRoot, "events.sqlite"));

  try {
    const environment = await TestWorkflowEnvironment.createLocal();
    try {
      const taskQueue = `eve-loop-temporal-${randomUUID()}`;
      const worker = await Worker.create({
        activities: createActivities(service),
        connection: environment.nativeConnection,
        namespace: environment.namespace,
        taskQueue,
        workflowsPath: resolveWorkflowsPath(),
      });
      return new TemporalPrototypeRuntime({ environment, service, taskQueue, tempRoot, worker });
    } catch (error) {
      await environment.teardown();
      throw error;
    }
  } catch (error) {
    await service.close();
    await rm(tempRoot, { force: true, recursive: true });
    throw error;
  }
}

function createActivities(service: SqlitePrototypeService): TemporalActivities {
  return {
    async appendEvent(logId, event): Promise<void> {
      await service.append(logId, event);
    },
    async effect(call: EffectCall): Promise<EffectResult> {
      try {
        return { kind: "succeeded", output: await service.effect(call) };
      } catch (error) {
        if (error instanceof EffectProtocolError) {
          throw ApplicationFailure.nonRetryable(error.message, "EVE_EFFECT_PROTOCOL");
        }
        if (error instanceof DeclaredEffectFailure) {
          if (
            call.retry.idempotency === "none" ||
            Context.current().info.attempt >= call.retry.maxAttempts
          ) {
            return { error: effectFailure(error), kind: "exhausted" };
          }
        }
        throw error;
      }
    },
    async finish(sessionId, outcome): Promise<void> {
      service.finish(sessionId, outcome);
    },
  };
}

function sessionProgramInput(input: PrototypeStartInput) {
  return {
    initialDelivery: input.initialDelivery,
    mode: input.mode,
    scenario: input.scenario,
    sessionId: input.sessionId,
  };
}

function effectFailure(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: "EFFECT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function resolveWorkflowsPath(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourcePath = join(directory, "workflows.ts");
  return existsSync(sourcePath) ? sourcePath : join(directory, "workflows.js");
}

function collectRejected(
  results: readonly PromiseSettledResult<unknown>[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}
