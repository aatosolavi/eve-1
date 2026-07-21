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

import { createWorkflowLoopSessionStep, executeWorkflowLoopTurnStep } from "./steps.js";

const mocks = vi.hoisted(() => ({
  createSessionOperation: vi.fn(),
  executeTurnStepOperation: vi.fn(),
  getStepMetadata: vi.fn(),
  getWorkflowMetadata: vi.fn(),
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

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const SESSION: DurableSession = {
  agent: { system: "loop" },
  continuationToken: "loop-token",
  history: [],
  sessionId: "loop-session",
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
  mocks.getStepMetadata.mockReturnValue({
    attempt: 2,
    stepId: "step-1",
    stepName: "loop-step",
  });
  mocks.getWorkflowMetadata.mockReturnValue({ workflowRunId: "workflow-run" });
});

describe("Workflow loop runtime operation steps", () => {
  it("binds session creation directly to the shared production operation", async () => {
    mocks.createSessionOperation.mockResolvedValue({ state: STATE });

    await expect(
      createWorkflowLoopSessionStep({
        compiledArtifactsSource: SOURCE,
        continuationToken: "loop-token",
        sessionId: "loop-session",
      }),
    ).resolves.toEqual({ state: STATE });

    expect(mocks.createSessionOperation).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
      continuationToken: "loop-token",
      sessionId: "loop-session",
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
      executeWorkflowLoopTurnStep({
        input: undefined,
        parentWritable,
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
      writeEveAttributes: expect.any(Function),
    });
  });

  it("rejects a state without the portable embedded snapshot", async () => {
    const stateWithoutSnapshot: DurableSessionState = {
      ...STATE,
      snapshot: undefined,
    };

    await expect(
      executeWorkflowLoopTurnStep({
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
