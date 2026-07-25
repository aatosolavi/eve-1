import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput } from "#channel/types.js";
import { ChannelRequestIdKey, SessionIdKey } from "#core/context/keys.js";
import { DURABLE_SESSION_VERSION, type DurableSessionState } from "#core/durable-session-store.js";
import { isRuntimeNoActiveSessionError } from "#core/runtime-errors.js";
import type { EveEntryInput } from "#execution/entry-services.js";
import type { TurnStepResult } from "#internal/loops/types.js";
import {
  createSessionWaitingEvent,
  createTurnStartedEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
  type HandleMessageStreamEvent,
} from "#core/protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { createInlineLoopRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  createSessionOperation: vi.fn(),
  runStepEntrypoint: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#execution/create-session-step.js", () => ({
  createSessionStep: mocks.createSessionOperation,
}));

vi.mock("#core/entrypoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#core/entrypoint.js")>()),
  runStepEntrypoint: mocks.runStepEntrypoint,
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const ADAPTER: ChannelAdapter = { kind: "http" };

afterEach(() => {
  mocks.createSessionOperation.mockReset();
  mocks.runStepEntrypoint.mockReset();
  mocks.getCompiledRuntimeAgentBundle.mockReset();
});

describe("createInlineLoopRuntime", () => {
  it("returns a handle before session creation and keeps the sample id in context", async () => {
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
      compiledArtifactsSource: SOURCE,
    });
    const creation = deferred<{ readonly state: DurableSessionState }>();
    mocks.createSessionOperation.mockReturnValue(creation.promise);

    const step = deferred<TurnStepResult>();
    const turnInputs: EveEntryInput[] = [];
    mocks.runStepEntrypoint.mockImplementation(async (_ports: unknown, input: EveEntryInput) => {
      turnInputs.push(input);
      return await step.promise;
    });

    const runtime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });
    const handle = await runtime.run(
      createRunInput({
        continuationToken: "http:nonblocking",
        requestId: "sample-nonblocking",
      }),
    );

    expect(handle.continuationToken).toBe("http:nonblocking");
    expect(handle.sessionId).not.toBe("");
    await waitForCallCount(mocks.createSessionOperation, 1);
    expect(turnInputs).toHaveLength(0);
    expect(mocks.createSessionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationToken: "http:nonblocking",
        sessionId: handle.sessionId,
      }),
    );

    const state = createSessionState({
      continuationToken: "http:nonblocking",
      sessionId: handle.sessionId,
    });
    creation.resolve({ state });
    await waitForCallCount(mocks.runStepEntrypoint, 1);
    expect(turnInputs[0]?.serializedContext).toMatchObject({
      [ChannelRequestIdKey.name]: "sample-nonblocking",
      [SessionIdKey.name]: handle.sessionId,
    });
    step.resolve(createParkResult(state, turnInputs[0]?.serializedContext ?? {}));
  });

  it("runs continuations, replays events, and rekeys delivery across runtime instances", async () => {
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
      compiledArtifactsSource: SOURCE,
    });
    mocks.createSessionOperation.mockImplementation(
      async (input: { readonly continuationToken: string; readonly sessionId: string }) => ({
        state: createSessionState({
          continuationToken: input.continuationToken,
          sessionId: input.sessionId,
        }),
      }),
    );

    const turnInputs: EveEntryInput[] = [];
    mocks.runStepEntrypoint.mockImplementation(
      async (ports: EntryStreamPorts, input: EveEntryInput) => {
        turnInputs.push(input);
        const callIndex = turnInputs.length - 1;
        const initialState = input.durableSnapshot;

        if (callIndex === 0) {
          await publish(ports, createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }));
          return {
            action: "continue",
            state: {
              durable: {
                ...initialState,
                emissionState: {
                  sequence: 0,
                  sessionStarted: true,
                  stepIndex: 1,
                  turnId: "turn_0",
                },
              },
              serializedContext: input.serializedContext,
            },
          } satisfies TurnStepResult;
        }

        const rekeyedState: DurableSessionState = {
          ...createSessionState({
            continuationToken: "http:rekeyed",
            sessionId: initialState.sessionId,
          }),
          emissionState: {
            sequence: callIndex,
            sessionStarted: true,
            stepIndex: 0,
            turnId: "",
          },
        };
        await publish(ports, createSessionWaitingEvent("http:rekeyed"));
        return createParkResult(rekeyedState, input.serializedContext);
      },
    );

    const firstRuntime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });
    const handle = await firstRuntime.run(
      createRunInput({
        continuationToken: "http:initial",
        requestId: "sample-rekey",
      }),
    );
    const firstReader = handle.events.getReader();
    await expect(firstReader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "turn.started" },
    });
    await expect(firstReader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "session.waiting" },
    });
    await firstReader.cancel();

    const replayReader = (
      await firstRuntime.getEventStream(handle.sessionId, { startIndex: 1 })
    ).getReader();
    await expect(replayReader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "session.waiting" },
    });
    await replayReader.cancel();

    const secondRuntime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });
    await waitForDelivery(secondRuntime, {
      continuationToken: "http:rekeyed",
      requestId: "sample-follow-up",
    });
    await expect(
      secondRuntime.deliver({
        auth: null,
        continuationToken: "http:initial",
        payload: { message: "stale" },
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);

    await waitForCallCount(mocks.runStepEntrypoint, 3);
    expect(turnInputs[0]?.turnInput).toEqual({
      kind: "deliver",
      payloads: [{ context: undefined, message: "hello-loop", outputSchema: undefined }],
      requestId: "sample-rekey",
    });
    expect(turnInputs[1]?.turnInput).toBeUndefined();
    expect(turnInputs[2]?.turnInput).toEqual({
      auth: null,
      kind: "deliver",
      payloads: [{ message: "next" }],
      requestId: "sample-follow-up",
    });
  });

  it("fails the stream and releases the continuation token when initialization fails", async () => {
    const failure = new Error("compiled bundle unavailable");
    mocks.getCompiledRuntimeAgentBundle.mockRejectedValue(failure);
    const runtime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });
    const runInput = createRunInput({ continuationToken: "http:init-failure" });

    const handle = await runtime.run(runInput);

    await expect(handle.events.getReader().read()).rejects.toBe(failure);
    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: "http:init-failure",
        payload: { message: "next" },
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);
    await expect(runtime.run(runInput)).resolves.toMatchObject({
      continuationToken: "http:init-failure",
    });
  });

  it.each([
    {
      expected: "authorization approvals",
      name: "authorization approval waits",
      result: (state: DurableSessionState, context: Record<string, unknown>) =>
        createParkResult(state, context, {
          authorizationNames: ["github"],
          hasPendingAuthorization: true,
        }),
    },
    {
      expected: "human input waits",
      name: "human input waits",
      result: (state: DurableSessionState, context: Record<string, unknown>) =>
        createParkResult(state, context, { hasPendingInputBatch: true }),
    },
    {
      expected: "subagent or runtime-action waits",
      name: "subagent and runtime-action waits",
      result: (state: DurableSessionState, context: Record<string, unknown>) =>
        createParkResult(state, context, {
          pendingRuntimeActionKeys: ["subagent-call:research:call-1"],
        }),
    },
    {
      expected: "workflow runtime actions",
      name: "workflow-owned runtime actions",
      result: (state: DurableSessionState, context: Record<string, unknown>) =>
        ({
          action: "dispatch-workflow-runtime-actions",
          pendingRuntimeActionKeys: ["remote-agent-call:research:call-1"],
          state: { durable: state, serializedContext: context },
        }) satisfies TurnStepResult,
    },
  ])("fails the event stream for unsupported $name", async ({ expected, result }) => {
    mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
      compiledArtifactsSource: SOURCE,
    });
    mocks.createSessionOperation.mockImplementation(
      async (input: { readonly continuationToken: string; readonly sessionId: string }) => ({
        state: createSessionState({
          continuationToken: input.continuationToken,
          sessionId: input.sessionId,
        }),
      }),
    );
    mocks.runStepEntrypoint.mockImplementation(async (_ports: unknown, input: EveEntryInput) =>
      result(input.durableSnapshot, input.serializedContext),
    );

    const runtime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });
    const handle = await runtime.run(
      createRunInput({ continuationToken: `http:unsupported-${expected}` }),
    );

    await expect(handle.events.getReader().read()).rejects.toThrow(expected);
  });

  it("rejects task and delegated runs at the loop boundary", async () => {
    const runtime = createInlineLoopRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.run({ ...createRunInput({ continuationToken: "http:task" }), mode: "task" }),
    ).rejects.toThrow("only supports conversation mode");
    await expect(
      runtime.run({
        ...createRunInput({ continuationToken: "http:delegated" }),
        parent: {
          callId: "call-1",
          rootSessionId: "root-1",
          sessionId: "parent-1",
          turn: { id: "turn-1", sequence: 0 },
        },
      }),
    ).rejects.toThrow("does not support delegated subagent runs");
    expect(mocks.createSessionOperation).not.toHaveBeenCalled();
  });
});

function createRunInput(input: {
  readonly continuationToken: string;
  readonly requestId?: string;
}): RunInput {
  return {
    adapter: ADAPTER,
    auth: null,
    capabilities: { requestInput: true },
    continuationToken: input.continuationToken,
    input: { message: "hello-loop" },
    mode: "conversation",
    requestId: input.requestId,
  };
}

function createSessionState(input: {
  readonly continuationToken: string;
  readonly sessionId: string;
}): DurableSessionState {
  return {
    continuationToken: input.continuationToken,
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: input.sessionId,
    snapshot: {
      session: {
        agent: { system: "loop" },
        continuationToken: input.continuationToken,
        history: [],
        sessionId: input.sessionId,
      },
      version: DURABLE_SESSION_VERSION,
    },
    version: DURABLE_SESSION_VERSION,
  };
}

function createParkResult(
  state: DurableSessionState,
  serializedContext: Record<string, unknown>,
  overrides: Partial<Extract<TurnStepResult, { readonly action: "park" }>> = {},
): TurnStepResult {
  return {
    action: "park",
    hasPendingAuthorization: false,
    hasPendingInputBatch: false,
    state: { durable: state, serializedContext },
    ...overrides,
  };
}

interface EntryStreamPorts {
  readonly stream: { open(): WritableStreamDefaultWriter<Uint8Array> };
}

async function publish(ports: EntryStreamPorts, event: HandleMessageStreamEvent): Promise<void> {
  const timed = timestampHandleMessageStreamEvent(event, "2026-07-10T12:00:00.000Z");
  const writer = ports.stream.open();
  await writer.write(encodeMessageStreamEvent(timed));
  writer.releaseLock();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value) {
      if (resolve === undefined) throw new Error("Deferred promise was not initialized.");
      resolve(value);
    },
  };
}

async function waitForCallCount(
  mock: { readonly mock: { readonly calls: readonly unknown[][] } },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length >= expected) return;
    await Promise.resolve();
  }
  throw new Error(
    `Expected ${String(expected)} calls, received ${String(mock.mock.calls.length)}.`,
  );
}

async function waitForDelivery(
  runtime: ReturnType<typeof createInlineLoopRuntime>,
  input: { readonly continuationToken: string; readonly requestId: string },
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await runtime.deliver({
        auth: null,
        continuationToken: input.continuationToken,
        payload: { message: "next" },
        requestId: input.requestId,
      });
      return;
    } catch (error) {
      if (!isRuntimeNoActiveSessionError(error)) throw error;
      await Promise.resolve();
    }
  }
  throw new Error(`Continuation token "${input.continuationToken}" was not rekeyed.`);
}
