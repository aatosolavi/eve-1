import type {
  DeliverHookPayload,
  DeliverInput,
  GetEventStreamOptions,
  HookPayload,
  RunHandle,
  RunInput,
  Runtime,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import type { DurableSession, DurableSessionState } from "#execution/durable-session-state.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { createSessionOperation } from "#execution/session-operation.js";
import {
  executeTurnStepOperation,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";
import { InMemoryBenchmarkEventLog } from "#internal/loop-benchmark/event-log.js";
import type { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const INLINE_RUNTIME_GLOBAL_KEY = Symbol.for("eve.loop-benchmark.inline-runtime");

interface InlineRuntimeGlobal {
  readonly sessionIdByContinuationToken: Map<string, string>;
  readonly sessionsById: Map<string, InlineSession>;
}

interface InlineRuntimeGlobalContainer {
  [INLINE_RUNTIME_GLOBAL_KEY]?: InlineRuntimeGlobal;
}

type InlineSessionPhase = "done" | "failed" | "initializing" | "parked" | "running";

interface InlineSession {
  continuationToken: string;
  deliveryWaiter: ((delivery: DeliverHookPayload) => void) | undefined;
  readonly eventLog: InMemoryBenchmarkEventLog;
  readonly id: string;
  readonly pendingDeliveries: DeliverHookPayload[];
  phase: InlineSessionPhase;
  readonly telemetry: LoopBenchmarkRecorder | undefined;
}

const globalContainer = globalThis as typeof globalThis & InlineRuntimeGlobalContainer;

/** Creates the process-local direct runtime used by the loop benchmark. */
export function createInlineBenchmarkRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Runtime {
  const state = getInlineRuntimeGlobal();

  return {
    async run(input: RunInput): Promise<RunHandle> {
      assertSupportedRunInput(input);

      const sessionId = createSessionId(state);
      const continuationToken = input.continuationToken ?? sessionId;
      const telemetry = createLoopBenchmarkRecorder({
        actor: "controller",
        attempt: `${sessionId}:inline`,
        hostRole: "controller",
        runtime: "inline",
        sampleId: input.requestId,
      });
      telemetry?.engine({ controllerId: sessionId, kind: "inline.controller" });
      const session: InlineSession = {
        continuationToken,
        deliveryWaiter: undefined,
        eventLog: new InMemoryBenchmarkEventLog(),
        id: sessionId,
        pendingDeliveries: [],
        phase: "initializing",
        telemetry,
      };

      claimContinuationToken(state, session);
      state.sessionsById.set(sessionId, session);
      const initialization = {
        compiledArtifactsSource: config.compiledArtifactsSource,
        runInput: input,
        session,
        state,
      };
      if (telemetry === undefined) {
        startSessionInitialization(initialization);
      } else {
        await recordLoopBenchmarkInterval(telemetry, "engine.dispatch", async () => {
          startSessionInitialization(initialization);
        });
        scheduleLoopBenchmarkRecorderFlush(telemetry);
      }

      let events: ReadableStream<HandleMessageStreamEvent> | undefined;
      return {
        continuationToken,
        get events() {
          events ??= session.eventLog.stream();
          return events;
        },
        sessionId,
      };
    },

    async deliver(input: DeliverInput): Promise<{ sessionId: string }> {
      const sessionId = state.sessionIdByContinuationToken.get(input.continuationToken);
      const session = sessionId === undefined ? undefined : state.sessionsById.get(sessionId);

      if (session === undefined || session.phase === "done" || session.phase === "failed") {
        throw new RuntimeNoActiveSessionError(input.continuationToken);
      }

      enqueueDelivery(session, {
        auth: input.auth,
        kind: "deliver",
        payloads: [input.payload],
        requestId: input.requestId,
      });
      return { sessionId: session.id };
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<HandleMessageStreamEvent>> {
      const session = state.sessionsById.get(sessionId);
      if (session === undefined) {
        throw new Error(`Inline benchmark session "${sessionId}" was not found.`);
      }
      return session.eventLog.stream(options?.startIndex);
    },
  };
}

function getInlineRuntimeGlobal(): InlineRuntimeGlobal {
  globalContainer[INLINE_RUNTIME_GLOBAL_KEY] ??= {
    sessionIdByContinuationToken: new Map(),
    sessionsById: new Map(),
  };
  return globalContainer[INLINE_RUNTIME_GLOBAL_KEY];
}

function assertSupportedRunInput(input: RunInput): void {
  if (input.mode !== "conversation") {
    throw new Error("The inline benchmark runtime only supports conversation mode.");
  }
  if (
    input.parent !== undefined ||
    input.subagentDepth !== undefined ||
    input.subagentMaxDepth !== undefined
  ) {
    throw new Error("The inline benchmark runtime does not support delegated subagent runs.");
  }
  if (input.callback !== undefined) {
    throw new Error("The inline benchmark runtime does not support session callbacks.");
  }
}

function createSessionId(state: InlineRuntimeGlobal): string {
  let sessionId: string;
  do {
    sessionId = `inline_${crypto.randomUUID()}`;
  } while (state.sessionsById.has(sessionId));
  return sessionId;
}

function createInitialDelivery(input: RunInput): DeliverHookPayload {
  return {
    kind: "deliver",
    payloads: [
      {
        context: input.input.context,
        message: input.input.message,
        outputSchema: input.input.outputSchema,
      },
    ],
    requestId: input.requestId,
  };
}

function startSessionInitialization(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly runInput: RunInput;
  readonly session: InlineSession;
  readonly state: InlineRuntimeGlobal;
}): void {
  void initializeAndDriveSession(input).catch((error: unknown) => {
    const { session, state } = input;
    session.phase = "failed";
    releaseContinuationToken(state, session);
    scheduleLoopBenchmarkRecorderFlush(session.telemetry);
    session.eventLog.fail(error);
  });
}

async function initializeAndDriveSession(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly runInput: RunInput;
  readonly session: InlineSession;
  readonly state: InlineRuntimeGlobal;
}): Promise<void> {
  const { compiledArtifactsSource, runInput, session, state } = input;
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const ctx = buildRunContext({ bundle, run: runInput });
  ctx.set(ContinuationTokenKey, session.continuationToken);
  ctx.set(SessionIdKey, session.id);
  const serializedContext = serializeContext(ctx);
  const { state: sessionState } = await recordLoopBenchmarkInterval(
    session.telemetry,
    "session.create.operation",
    async () =>
      await createSessionOperation({
        compiledArtifactsSource,
        continuationToken: session.continuationToken,
        outputSchema: runInput.input.outputSchema,
        sessionId: session.id,
      }),
  );

  session.phase = "running";
  await driveSession({
    initialInput: createInitialDelivery(runInput),
    serializedContext,
    session,
    sessionState,
    state,
  });
}

async function driveSession(input: {
  readonly initialInput: HookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly session: InlineSession;
  readonly sessionState: DurableSessionState;
  readonly state: InlineRuntimeGlobal;
}): Promise<void> {
  const { session, state } = input;
  let nextInput: HookPayload | undefined = input.initialInput;
  let serializedContext = input.serializedContext;
  let sessionState = input.sessionState;

  while (true) {
    const durableSession = readSnapshot(sessionState);
    const emissionState = sessionState.emissionState;
    const result = await recordLoopBenchmarkInterval(
      session.telemetry,
      "turn.step.operation",
      async () =>
        await executeTurnStepOperation({
          callbackBaseUrl: undefined,
          createEventSink: () => ({
            async write(publication) {
              await recordLoopBenchmarkInterval(session.telemetry, "event.publish", async () => {
                session.eventLog.append({
                  encoded: publication.encoded,
                  event: publication.event,
                  publicationKey: JSON.stringify([
                    session.id,
                    emissionState.sequence,
                    emissionState.turnId,
                    emissionState.stepIndex,
                    publication.emissionOrdinal,
                  ]),
                });
              });
            },
          }),
          durableSession,
          input: nextInput,
          serializedContext,
          sessionState,
        }),
    );
    scheduleLoopBenchmarkRecorderFlush(session.telemetry);

    serializedContext = result.serializedContext;
    sessionState = result.sessionState;

    if (result.action === "continue") {
      nextInput = undefined;
      continue;
    }

    if (result.action === "done") {
      session.phase = "done";
      releaseContinuationToken(state, session);
      session.eventLog.close();
      return;
    }

    if (result.action === "dispatch-workflow-runtime-actions") {
      throw new Error("The inline benchmark runtime does not support workflow runtime actions.");
    }
    if (!isParkResult(result)) {
      throw new Error(`Inline benchmark runtime received unexpected action "${result.action}".`);
    }
    assertSupportedWait(result);
    await recordLoopBenchmarkInterval(session.telemetry, "session.rekey", async () => {
      rekeyContinuationToken(state, session, result.sessionState.continuationToken);
    });
    session.phase = "parked";
    session.telemetry?.mark("session.rekey.accepted");
    session.telemetry?.mark("runtime.park.accepted");
    scheduleLoopBenchmarkRecorderFlush(session.telemetry);
    nextInput = await waitForDelivery(session);
    session.phase = "running";
  }
}

function readSnapshot(state: DurableSessionState): DurableSession {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    throw new Error("Inline benchmark session state did not include a durable snapshot.");
  }
  return snapshot.session;
}

function isParkResult(
  result: DurableStepResult,
): result is Extract<DurableStepResult, { readonly action: "park" }> {
  return result.action === "park";
}

function assertSupportedWait(
  result: Extract<DurableStepResult, { readonly action: "park" }>,
): void {
  if (result.pendingRuntimeActionKeys !== undefined) {
    throw new Error(
      "The inline benchmark runtime does not support subagent or runtime-action waits.",
    );
  }
  if (result.hasPendingAuthorization || (result.authorizationNames?.length ?? 0) > 0) {
    throw new Error("The inline benchmark runtime does not support authorization approvals.");
  }
  if (result.hasPendingInputBatch) {
    throw new Error("The inline benchmark runtime does not support human input waits.");
  }
}

function claimContinuationToken(state: InlineRuntimeGlobal, session: InlineSession): void {
  const owner = state.sessionIdByContinuationToken.get(session.continuationToken);
  if (owner !== undefined && owner !== session.id) {
    throw new Error(
      `Continuation token "${session.continuationToken}" already belongs to session "${owner}".`,
    );
  }
  state.sessionIdByContinuationToken.set(session.continuationToken, session.id);
}

function rekeyContinuationToken(
  state: InlineRuntimeGlobal,
  session: InlineSession,
  nextToken: string,
): void {
  if (nextToken.length === 0) {
    throw new Error("Cannot park an inline benchmark session without a continuation token.");
  }

  const previousToken = session.continuationToken;
  const previousOwner = state.sessionIdByContinuationToken.get(previousToken);
  if (previousOwner !== session.id) {
    throw new Error(
      `Inline benchmark session "${session.id}" lost continuation token "${previousToken}".`,
    );
  }

  const nextOwner = state.sessionIdByContinuationToken.get(nextToken);
  if (nextOwner !== undefined && nextOwner !== session.id) {
    throw new Error(`Continuation token "${nextToken}" already belongs to session "${nextOwner}".`);
  }

  if (previousToken !== nextToken) {
    state.sessionIdByContinuationToken.delete(previousToken);
  }
  state.sessionIdByContinuationToken.set(nextToken, session.id);
  session.continuationToken = nextToken;
}

function releaseContinuationToken(state: InlineRuntimeGlobal, session: InlineSession): void {
  if (state.sessionIdByContinuationToken.get(session.continuationToken) === session.id) {
    state.sessionIdByContinuationToken.delete(session.continuationToken);
  }
}

function enqueueDelivery(session: InlineSession, delivery: DeliverHookPayload): void {
  const waiter = session.deliveryWaiter;
  if (waiter === undefined) {
    session.pendingDeliveries.push(delivery);
    return;
  }

  session.deliveryWaiter = undefined;
  waiter(delivery);
}

async function waitForDelivery(session: InlineSession): Promise<DeliverHookPayload> {
  const pending = session.pendingDeliveries.shift();
  if (pending !== undefined) return pending;

  return await new Promise<DeliverHookPayload>((resolve) => {
    session.deliveryWaiter = resolve;
  });
}
