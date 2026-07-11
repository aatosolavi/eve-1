import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DURABLE_SESSION_VERSION,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-state.js";
import type { DurableStepResult, TurnStepOperationInput } from "#execution/turn-step-operation.js";
import {
  createSessionWaitingEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { createWorkflowBenchmarkSessionStep, executeWorkflowBenchmarkTurnStep } from "./steps.js";

const mocks = vi.hoisted(() => ({
  createLoopBenchmarkRecorder: vi.fn(),
  createSessionOperation: vi.fn(),
  engine: vi.fn(),
  executeTurnStepOperation: vi.fn(),
  getStepMetadata: vi.fn(),
  getWorkflowMetadata: vi.fn(),
  mark: vi.fn(),
  observeEvent: vi.fn(),
  recordLoopBenchmarkInterval: vi.fn(
    async (_recorder: unknown, _name: string, run: () => Promise<unknown>) => await run(),
  ),
  scheduleLoopBenchmarkRecorderFlush: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: mocks.getStepMetadata,
  getWorkflowMetadata: mocks.getWorkflowMetadata,
}));
vi.mock("#execution/session-operation.js", () => ({
  createSessionOperation: mocks.createSessionOperation,
}));
vi.mock("#execution/turn-step-operation.js", () => ({
  executeTurnStepOperation: mocks.executeTurnStepOperation,
}));
vi.mock("#internal/loop-benchmark/runtime-telemetry.js", () => ({
  createLoopBenchmarkRecorder: mocks.createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval: mocks.recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush: mocks.scheduleLoopBenchmarkRecorderFlush,
}));

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const SESSION: DurableSession = {
  agent: { system: "benchmark" },
  continuationToken: "benchmark-token",
  history: [],
  sessionId: "benchmark-session",
};
const STATE: DurableSessionState = {
  continuationToken: SESSION.continuationToken,
  emissionState: {
    sequence: 0,
    sessionStarted: false,
    stepIndex: 0,
    turnId: "",
  },
  hasProxyInputRequests: false,
  sessionId: SESSION.sessionId,
  snapshot: { session: SESSION, version: DURABLE_SESSION_VERSION },
  version: DURABLE_SESSION_VERSION,
};
const PARK_RESULT: Extract<DurableStepResult, { readonly action: "park" }> = {
  action: "park",
  hasPendingAuthorization: false,
  hasPendingInputBatch: false,
  serializedContext: { next: true },
  sessionState: STATE,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLoopBenchmarkRecorder.mockReturnValue({
    engine: mocks.engine,
    mark: mocks.mark,
    observeEvent: mocks.observeEvent,
  });
  mocks.getStepMetadata.mockReturnValue({
    attempt: 2,
    stepId: "step-1",
    stepName: "benchmark-step",
  });
  mocks.getWorkflowMetadata.mockReturnValue({ workflowRunId: "workflow-run" });
});

describe("Workflow benchmark operation steps", () => {
  it("binds session creation directly to the shared production operation", async () => {
    mocks.createSessionOperation.mockResolvedValue({ state: STATE });

    await expect(
      createWorkflowBenchmarkSessionStep({
        compiledArtifactsSource: SOURCE,
        continuationToken: "benchmark-token",
        sampleId: "sample-workflow",
        sessionId: "benchmark-session",
      }),
    ).resolves.toEqual({ state: STATE });

    expect(mocks.createSessionOperation).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
      continuationToken: "benchmark-token",
      sessionId: "benchmark-session",
    });
    expect(mocks.recordLoopBenchmarkInterval).toHaveBeenCalledWith(
      expect.any(Object),
      "session.create.operation",
      expect.any(Function),
    );
    expect(mocks.engine).toHaveBeenCalledWith({
      attempt: 2,
      kind: "workflow.step",
      stepId: "step-1",
      workflowRunId: "workflow-run",
    });
  });

  it("binds one turn step directly to the shared operation and root stream", async () => {
    const event = timestampHandleMessageStreamEvent(
      createSessionWaitingEvent(),
      "2026-07-10T00:00:00.000Z",
    );
    const encoded = encodeMessageStreamEvent(event);
    const chunks: Uint8Array[] = [];
    const parentWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    mocks.executeTurnStepOperation.mockImplementation(async (input: TurnStepOperationInput) => {
      await input.createEventSink().write({ encoded, emissionOrdinal: 0, event });
      return PARK_RESULT;
    });

    await expect(
      executeWorkflowBenchmarkTurnStep({
        input: undefined,
        parentWritable,
        sampleId: "sample-workflow",
        serializedContext: {},
        sessionState: STATE,
        stepOrdinal: 0,
        turnOrdinal: 0,
      }),
    ).resolves.toBe(PARK_RESULT);

    expect(chunks).toEqual([encoded]);
    expect(mocks.executeTurnStepOperation).toHaveBeenCalledWith({
      createEventSink: expect.any(Function),
      durableSession: SESSION,
      input: undefined,
      serializedContext: {},
      sessionState: STATE,
    });
    expect(mocks.observeEvent).toHaveBeenCalledWith({
      encodedBytes: encoded.byteLength,
      eventType: "session.waiting",
      metaAt: "2026-07-10T00:00:00.000Z",
      ordinal: 0,
      stage: "publish.ack",
    });
  });

  it("rejects a state without the portable embedded snapshot", async () => {
    const stateWithoutSnapshot: DurableSessionState = {
      ...STATE,
      snapshot: undefined,
    };

    await expect(
      executeWorkflowBenchmarkTurnStep({
        input: undefined,
        parentWritable: new WritableStream<Uint8Array>(),
        serializedContext: {},
        sessionState: stateWithoutSnapshot,
        stepOrdinal: 0,
        turnOrdinal: 0,
      }),
    ).rejects.toThrow("embedded durable session snapshot");
    expect(mocks.executeTurnStepOperation).not.toHaveBeenCalled();
  });
});
