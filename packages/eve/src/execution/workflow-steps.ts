import { buildAdapterContext } from "#channel/adapter-context.js";
import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type {
  DeliverPayload,
  SessionAuthContext,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ModeKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger, formatError } from "#internal/logging.js";
import {
  createSessionFailedEvent,
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  createDurableSessionState,
  type DurableSessionState,
} from "#execution/durable-session-state.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import {
  createTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { emitProxiedInputRequest, routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  executeTurnStepOperation,
  reconcileSessionContinuationToken,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";
import {
  buildTurnAttributes,
  readChannelRequestId,
  readRootSessionId,
} from "#execution/eve-workflow-attributes.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { startWorkflowPreferLatest, turnWorkflowReference } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";

export type { TurnStepInput };
export {
  reconcileSessionContinuationToken,
  resolveEffectiveOutputSchema,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";

/** Runs one atomic harness step inside a durable `"use step"` boundary. */
export async function turnStep(rawInput: TurnStepInput): Promise<DurableStepResult> {
  "use step";

  const sampleId = readChannelRequestId(rawInput.serializedContext);
  const attempt = readWorkflowStepAttempt(
    `${rawInput.sessionState.sessionId}:workflow-turn-step:${String(rawInput.sessionState.emissionState.sequence)}:${String(rawInput.sessionState.emissionState.stepIndex)}`,
  );
  const telemetry = createLoopBenchmarkRecorder({
    actor: "worker",
    attempt,
    hostRole: "worker",
    runtime: "workflow",
    sampleId,
  });
  const durableSession = await readDurableSession(rawInput.sessionState);
  const callbackBaseUrl = await resolveTurnStepCallbackBaseUrl();
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  try {
    const operation = async () =>
      await executeTurnStepOperation({
        callbackBaseUrl,
        createEventSink() {
          const openedWriter = rawInput.parentWritable.getWriter();
          writer = openedWriter;
          return {
            async write(publication) {
              if (telemetry === undefined) {
                await openedWriter.write(publication.encoded);
                return;
              }
              await recordLoopBenchmarkInterval(telemetry, "event.publish", async () => {
                await openedWriter.write(publication.encoded);
              });
            },
          };
        },
        durableSession,
        input: rawInput.input,
        serializedContext: rawInput.serializedContext,
        sessionState: rawInput.sessionState,
      });

    const result =
      telemetry === undefined
        ? await operation()
        : await recordLoopBenchmarkInterval(telemetry, "turn.step.operation", operation);

    if (writer !== undefined) {
      if (result.action === "done") {
        await writer.close();
      } else {
        writer.releaseLock();
      }
    }

    scheduleLoopBenchmarkRecorderFlush(telemetry);
    return result;
  } catch (error) {
    scheduleLoopBenchmarkRecorderFlush(telemetry);
    throw error;
  }
}

/** Records that the Workflow driver has accepted and rekeyed one parked turn. */
export async function recordWorkflowBenchmarkParkAcceptedStep(input: {
  readonly sampleId: string;
}): Promise<void> {
  "use step";

  const attempt = readWorkflowStepAttempt(`${input.sampleId}:workflow-park-accepted`);
  const telemetry = createLoopBenchmarkRecorder({
    actor: "session",
    attempt,
    hostRole: "worker",
    runtime: "workflow",
    sampleId: input.sampleId,
  });
  telemetry?.mark("session.rekey.accepted");
  telemetry?.mark("runtime.park.accepted");
  scheduleLoopBenchmarkRecorderFlush(telemetry);
}

function readWorkflowStepAttempt(fallback: string): string {
  try {
    const metadata = getStepMetadata();
    return `${fallback}:${metadata.stepId}:attempt:${String(metadata.attempt)}`;
  } catch {
    return fallback;
  }
}

async function resolveTurnStepCallbackBaseUrl(): Promise<string | undefined> {
  // Populate the callback base URL so getHookUrl() works during tool
  // execution, preferring eve's active local origin over metadata fallback.
  try {
    const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
    const metadata = getWorkflowMetadata();
    return typeof metadata.url === "string"
      ? resolveWorkflowCallbackBaseUrl(metadata.url)
      : undefined;
  } catch {
    // Outside a workflow context (e.g. tests) — getHookUrl will return undefined.
    return undefined;
  }
}

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.failed` to the adapter and durable stream. */
export async function emitTerminalSessionFailureStep(input: {
  readonly error: unknown;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const details = formatError(input.error);
  const code = typeof details.name === "string" ? details.name : "WORKFLOW_EXECUTION_FAILED";
  const message = typeof details.message === "string" ? details.message : String(input.error);
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";

  log.error("workflow loop threw — emitting terminal session.failed", {
    sessionId,
    errorId: typeof details.errorId === "string" ? details.errorId : undefined,
    code,
    message,
    detail: typeof details.detail === "string" ? details.detail : undefined,
  });

  const event = createSessionFailedEvent({ code, details, message, sessionId });

  // Best-effort: invoke the adapter handler so channels surface the
  // failure. Errors are logged, never rethrown — the outer workflow
  // throw must still reach the run handle.
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.get(ChannelKey);
    if (adapter !== undefined) {
      const adapterCtx = buildAdapterContext(adapter, ctx);
      await callAdapterEventHandler(adapter, event, adapterCtx);
    }
  } catch (notificationError) {
    log.error("adapter failed to handle terminal session.failed event", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: notificationError,
    });
  }

  // Always write the event to the durable stream so downstream
  // consumers see a canonical terminal event instead of an abrupt
  // stream close.
  try {
    const writer = input.parentWritable.getWriter();
    try {
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event)));
    } finally {
      writer.releaseLock();
    }
  } catch (writeError) {
    log.error("failed to write terminal session.failed event to durable stream", {
      errorId: typeof details.errorId === "string" ? details.errorId : undefined,
      sessionId,
      error: writeError,
    });
  }
}

export interface ProxyInputRequestResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Emits a proxied `input.requested` event through the parent's adapter
 * and records the routing entries on the parent session.
 */
export async function runProxyInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ProxyInputRequestResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const mode = ctx.require(ModeKey);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const writer = input.parentWritable.getWriter();

  let scopeResult: {
    readonly result: readonly (readonly [requestId: string, childContinuationToken: string])[];
    readonly session: HarnessSession;
  };
  try {
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
    };

    scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      const proxyResult = await emitProxiedInputRequest({
        emit,
        hookPayload: input.hookPayload,
        mode,
        session: enrichedSession,
      });
      return { result: proxyResult.entries, session: proxyResult.session };
    });
  } finally {
    writer.releaseLock();
  }

  // Persist adapter-state mutations (e.g. Slack's `pendingRequests`
  // cache populated by the `input.requested` handler) so the next
  // `turnStep` observes them across the serialized context
  // boundary. Without this the workflow runtime rehydrates a stale
  // adapter and later text-reply deliveries miss the cached batch.
  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  const nextSerializedContext = serializeContext(ctx);

  const sessionWithProxyEntries = upsertProxyInputRequests({
    entries: scopeResult.result,
    forChildContinuationToken: input.hookPayload.childContinuationToken,
    session: scopeResult.session,
  });
  const nextSession = reconcileSessionContinuationToken(ctx, sessionWithProxyEntries);
  const nextState = createDurableSessionState({ session: nextSession });

  return {
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}

export interface RoutedDeliverResult {
  /** `undefined` when the entire payload was routed to descendants. */
  readonly remainder: DeliverPayload | undefined;
}

/**
 * Splits an inbound deliver payload into parent-local and
 * proxied-child buckets and forwards the child buckets via
 * `resumeHook`. Read-only: never appends a snapshot.
 */
export async function routeProxiedDeliverStep(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const routed = routeDeliverPayload({
    payload: input.payload,
    state: durableSession.state,
  });

  for (const forChild of routed.forChildren) {
    await resumeHook(forChild.childContinuationToken, {
      auth: input.auth,
      kind: "deliver",
      payloads: [forChild.payload],
    });
  }

  return { remainder: routed.forSelf };
}

/** Starts a per-turn child workflow for the current driver session. */
export async function dispatchTurnStep(
  input: TurnWorkflowDispatchInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferLatest(
    turnWorkflowReference,
    [createTurnWorkflowInput(input)],
    {
      allowReservedAttributes: true,
      attributes: normalizeEveAttributes(
        buildTurnAttributes({
          parentSessionId: input.sessionState.sessionId,
          requestId: input.delivery.kind === "deliver" ? input.delivery.requestId : undefined,
          rootSessionId: readRootSessionId(input.serializedContext) ?? input.sessionState.sessionId,
        }),
      ),
    },
  );

  return { runId: run.runId };
}
