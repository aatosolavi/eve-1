import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeHook, start, type Run } from "#internal/workflow/runtime.js";

import { eventLogId, executionId } from "../ids.js";
import { SqlitePrototypeService } from "../service.js";
import type {
  Delivery,
  EventLogId,
  EventRecord,
  OperationId,
  PrototypeRun,
  PrototypeRuntime,
  SessionId,
  PrototypeStartInput,
  TerminalOutcome,
} from "../types.js";
import { workflowProgramInput, workflowSession } from "./workflows.js";

export type { WorkflowEventEnvelope } from "./workflows.js";

export async function createWorkflowPrototypeRuntime(): Promise<WorkflowPrototypeRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "eve-workflow-loop-prototype-"));
  return new WorkflowPrototypeRuntime(directory);
}

export class WorkflowPrototypeRuntime implements PrototypeRuntime {
  readonly kind = "workflow" as const;

  readonly #activeRuns = new Map<string, WorkflowPrototypeRun>();
  readonly #databasePath: string;
  readonly #directory: string;
  readonly #service: SqlitePrototypeService;
  #closed = false;

  constructor(directory: string) {
    this.#databasePath = join(directory, "events.sqlite");
    this.#directory = directory;
    this.#service = new SqlitePrototypeService(this.#databasePath);
  }

  async attemptCount(operation: OperationId): Promise<number> {
    return this.#service.attemptCount(operation);
  }

  async callback(id: SessionId): Promise<TerminalOutcome | null> {
    return this.#service.callback(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const stopped = await Promise.allSettled(
      [...this.#activeRuns.values()].map(async (run) => run.stop()),
    );
    const stopErrors = stopped.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (stopErrors.length > 0) {
      this.#closed = false;
      if (stopErrors.length === 1) throw stopErrors[0];
      throw new AggregateError(stopErrors, "Workflow prototype cancellation failed.");
    }

    this.#activeRuns.clear();
    await this.#service.close();
    await rm(this.#directory, { force: true, recursive: true });
  }

  async events(logId: EventLogId): Promise<readonly EventRecord[]> {
    return await this.#service.read(logId);
  }

  async executionCount(operation: OperationId): Promise<number> {
    return this.#service.executionCount(operation);
  }

  async start(input: PrototypeStartInput): Promise<PrototypeRun> {
    if (this.#closed) throw new Error("Workflow prototype runtime is closed.");

    const rootExecutionId = executionId(`${input.sessionId}:root-execution`);
    const logId = eventLogId(`${input.sessionId}:events`);
    const run = await start(workflowSession, [
      {
        continuationToken: input.continuationToken,
        databasePath: this.#databasePath,
        executionId: rootExecutionId,
        parent: { kind: "root" },
        programInput: workflowProgramInput(input),
        routingIntent: "pinned",
        streamLogId: logId,
      },
    ]);
    const result = run.returnValue;
    const prototypeRun = new WorkflowPrototypeRun({
      eventLogId: logId,
      result,
      run,
      runtime: this,
      sessionId: input.sessionId,
      token: input.continuationToken,
    });
    this.#activeRuns.set(run.runId, prototypeRun);
    void prototypeRun.result.finally(() => this.#activeRuns.delete(run.runId)).catch(() => {});
    return prototypeRun;
  }

  async visibleEffectCount(operation: OperationId): Promise<number> {
    return this.#service.visibleEffectCount(operation);
  }
}

class WorkflowPrototypeRun implements PrototypeRun {
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;

  readonly #eventLogId: EventLogId;
  readonly #run: Run<TerminalOutcome>;
  readonly #runtime: WorkflowPrototypeRuntime;
  readonly #token: string;
  #settled = false;
  #stopped = false;

  constructor(input: {
    readonly eventLogId: EventLogId;
    readonly result: Promise<TerminalOutcome>;
    readonly run: Run<TerminalOutcome>;
    readonly runtime: WorkflowPrototypeRuntime;
    readonly sessionId: SessionId;
    readonly token: string;
  }) {
    this.backendRunId = input.run.runId;
    this.#eventLogId = input.eventLogId;
    this.result = input.result.then(
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
    this.#run = input.run;
    this.#runtime = input.runtime;
    this.sessionId = input.sessionId;
    this.#token = input.token;
  }

  async deliver(delivery: Delivery): Promise<void> {
    if (this.#stopped) throw new Error(`Workflow prototype run "${this.backendRunId}" is stopped.`);
    if (this.#settled) {
      throw new Error(`Workflow prototype run "${this.backendRunId}" is terminal.`);
    }
    await resumeHook(this.#token, delivery);
  }

  async events(): Promise<readonly EventRecord[]> {
    return await this.#runtime.events(this.#eventLogId);
  }

  async stop(): Promise<void> {
    if (this.#stopped || this.#settled) return;
    this.#stopped = true;
    try {
      await this.#run.cancel();
    } catch (error) {
      this.#stopped = false;
      throw error;
    }
    await this.result.catch(() => {});
  }
}
