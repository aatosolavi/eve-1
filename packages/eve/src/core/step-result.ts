import type { ModelMessage, ToolSet, TypedToolCall, TypedToolResult } from "ai";
import { createToolResultMessagePartFromToolError } from "#core/action-result-helpers.js";
import { getAdvertisedTools } from "#core/advertised-tools.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  setPendingAuthorization,
} from "#core/authorization.js";
import { createNextCompactionConfig } from "#core/compaction.js";
import {
  advanceStep,
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#core/emission.js";
import {
  extractQuestionInputRequests,
  extractToolApprovalInputRequests,
} from "#core/input-extraction.js";
import { hasDeferredStepInput, setPendingInputBatch } from "#core/input-requests.js";
import { resolveAssistantStepText } from "#core/messages.js";
import {
  appendMissingToolResultMessages,
  getInvalidToolCallInputErrors,
} from "#core/model-call-recovery.js";
import { normalizeProviderToolHistory } from "#core/provider-tool-history.js";
import {
  createRuntimeActionRequestFromToolCall,
  setPendingRuntimeActionBatch,
} from "#core/runtime-actions.js";
import type { HarnessStepResult } from "#core/step-hooks.js";
import { isInvalidToolCall } from "#core/tool-call-input-errors.js";
import type { GenerateOutcome, HarnessSession, GenerateConfig } from "#core/step-types.js";
import { readWorkflowContinuationSecurity } from "#core/workflow-continuation-security.js";
import { isWorkflowRuntimeActionInterrupt } from "#core/workflow-runtime-action-state.js";
import { parkOnWorkflowInterrupt } from "#core/workflow-interrupt-continuation.js";
import {
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createResultCompletedEvent,
} from "#core/protocol/message.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#core/output-schema.js";
import type { InputRequest } from "#core/input/types.js";
import { hasEmptyDeliverySentinel } from "#core/shared/empty-delivery.js";
import type { RunMode } from "#shared/run-mode.js";
import type { JsonObject, JsonValue } from "#core/shared/json.js";
import { getWorkflowSandboxInterrupt } from "#core/workflow-sandbox-module.js";

import { classifyParkedSession } from "#core/step-outcome.js";
import type { StepLog } from "#core/step-services.js";

/**
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
export async function handleStepResult(input: {
  readonly config: GenerateConfig;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly log: StepLog;
  readonly promptMessages: readonly ModelMessage[];
  readonly readStashedToolInterrupt: (callId: string) => unknown;
  readonly result: HarnessStepResult;
  readonly session: HarnessSession;
}): Promise<GenerateOutcome> {
  const { config, emit, log, promptMessages, result } = input;
  let { emissionState, session } = input;

  const resolvedStepOutput = resolveAssistantStepText(result.response.messages, result.text);
  const emptyDelivery =
    result.finishReason !== "tool-calls" &&
    result.toolCalls.length === 0 &&
    hasEmptyDeliverySentinel(resolvedStepOutput);
  const invalidInputToolErrors = getInvalidToolCallInputErrors({
    toolCalls: result.toolCalls as TypedToolCall<ToolSet>[],
  });
  // Unions every invalid-input signal: SDK-marked invalid calls (which get
  // SDK-synthesized tool errors), non-object inputs caught by
  // getInvalidToolCallInputErrors, and ids the stream consumer observed.
  const invalidInputToolCallIds = new Set([
    ...(result.invalidInputToolCallIds ?? []),
    ...result.toolCalls.filter(isInvalidToolCall).map((toolCall) => toolCall.toolCallId),
    ...invalidInputToolErrors.map((toolError) => toolError.toolCallId),
  ]);
  const rawResponseMessages = emptyDelivery
    ? []
    : appendMissingToolResultMessages({
        append: invalidInputToolErrors.map((toolError) =>
          createToolResultMessagePartFromToolError(toolError),
        ),
        responseMessages: result.response.messages,
      });
  const stepOutput = emptyDelivery ? null : resolvedStepOutput;

  const providerExecutedOutcomeIds = new Set<string>();
  for (const part of [...(result.content ?? []), ...(result.toolResults ?? [])]) {
    if (
      (part.type === "tool-result" || part.type === "tool-error") &&
      part.providerExecuted === true
    ) {
      providerExecutedOutcomeIds.add(part.toolCallId);
    }
  }
  const normalizedProviderHistory = normalizeProviderToolHistory({
    messages: rawResponseMessages,
    providerExecutedOutcomeIds,
  });
  const responseMessages = normalizedProviderHistory.messages;

  const baseSession: HarnessSession = {
    ...session,
    compaction: createNextCompactionConfig(session.compaction, promptMessages, result),
  };

  const workflowContinuationSecurity =
    config.workflow === true ? readWorkflowContinuationSecurity(baseSession) : undefined;

  if (workflowContinuationSecurity !== undefined) {
    const workflowInterrupt = await getWorkflowSandboxInterrupt(
      result,
      workflowContinuationSecurity,
    );
    if (workflowInterrupt !== undefined) {
      if (!isWorkflowRuntimeActionInterrupt(workflowInterrupt)) {
        throw new Error(`Unsupported Workflow interrupt kind "${workflowInterrupt.payload.kind}".`);
      }
      return parkOnWorkflowInterrupt({
        baseSession,
        emissionState,
        interrupt: workflowInterrupt,
        promptMessages,
        responseMessages,
      });
    }
  }

  const approvalRequests = extractToolApprovalInputRequests({
    content: result.content ?? [],
    excludedCallIds: invalidInputToolCallIds,
  });
  const approvalRequestCallIds = new Set(approvalRequests.map((request) => request.action.callId));
  const questionRequests = extractQuestionInputRequests({
    toolCalls: result.toolCalls,
    excludedCallIds: new Set([...invalidInputToolCallIds, ...approvalRequestCallIds]),
  });
  const inputRequests: InputRequest[] = [...approvalRequests, ...questionRequests];
  const advertisedRuntimeActionTools = getAdvertisedTools({
    session: baseSession,
    tools: config.tools,
  });
  const pendingRuntimeActions = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => config.tools.get(toolCall.toolName)?.runtimeAction !== undefined)
    .filter((toolCall) => {
      if (advertisedRuntimeActionTools.get(toolCall.toolName)?.runtimeAction !== undefined) {
        return true;
      }
      log.warn("runtime action tool call blocked because tool is not advertised", {
        callId: toolCall.toolCallId,
        sessionId: baseSession.sessionId,
        toolName: toolCall.toolName,
      });
      return false;
    })
    .map((toolCall) =>
      createRuntimeActionRequestFromToolCall({
        toolCall,
        tools: advertisedRuntimeActionTools,
      }),
    );

  if (pendingRuntimeActions.length > 0) {
    // Stamp the live emission state onto the parked session so the
    // resume turn is classified as a continuation (turnId set), not a
    // fresh turn. Every other park path does this; without it the
    // parked session carries the default emission state (turnId ""),
    // because the post-preamble `setHarnessEmissionState` is dropped by
    // the later `session = pending.session` / `maybeCompact` rebinds.
    return classifyParkedSession(
      setHarnessEmissionState(
        setPendingRuntimeActionBatch({
          actions: pendingRuntimeActions,
          event: {
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          },
          responseMessages,
          session: { ...baseSession, history: [...promptMessages] },
        }),
        emissionState,
      ),
    );
  }

  // --- Park on input requests -----------------------------------------------

  if (inputRequests.length > 0) {
    let parkedSession = setPendingInputBatch({
      event: {
        sequence: emissionState.sequence,
        stepIndex: emissionState.stepIndex,
        turnId: emissionState.turnId,
      },
      requests: inputRequests,
      responseMessages,
      session: { ...baseSession, history: [...promptMessages] },
    });

    if (emit) {
      await emit(
        createInputRequestedEvent({
          requests: inputRequests,
          sequence: emissionState.sequence,
          stepIndex: emissionState.stepIndex,
          turnId: emissionState.turnId,
        }),
      );

      if (config.mode === "conversation") {
        emissionState = await emitTurnEpilogue(
          emit,
          emissionState,
          config.mode,
          parkedSession.continuationToken,
        );
        parkedSession = setHarnessEmissionState(parkedSession, emissionState);
      }
    }

    return classifyParkedSession(parkedSession);
  }

  // --- Park on authorization request ------------------------------------------

  const authSignal = findAuthorizationSignalFromToolResults(
    result.toolResults,
    input.readStashedToolInterrupt,
  );
  if (authSignal) {
    const { challenges } = authSignal;

    if (emit) {
      for (const ch of challenges) {
        await emit(
          createAuthorizationRequiredEvent({
            authorization: ch.challenge,
            name: ch.name,
            description: ch.challenge.instructions ?? `Authorization required for ${ch.name}`,
            webhookUrl: ch.hookUrl,
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          }),
        );
      }
    }

    return classifyParkedSession(
      setHarnessEmissionState(
        {
          ...baseSession,
          history: [...promptMessages],
          state: setPendingAuthorization(baseSession.state, { challenges }),
        },
        emissionState,
      ),
    );
  }

  // --- Continue or terminate ------------------------------------------------

  // History grows by append only; nothing rewrites earlier messages mid-turn,
  // so the prompt prefix stays stable and the provider's prompt cache keeps
  // hitting across steps. Compaction is the sole mechanism that ever rewrites
  // history, and it runs before the model call (see `maybeCompact`).
  const continuationMessages = responseMessages;
  const updatedHistory: ModelMessage[] = [...promptMessages, ...continuationMessages];
  let nextSession: HarnessSession = { ...baseSession, history: updatedHistory };

  // A `final_output` call is terminal even when the model emits it alongside
  // executing tools: continuing the loop would leave the no-execute call as a
  // dangling tool_use the next provider call rejects, and drop the result.
  const calledFinalOutput =
    nextSession.outputSchema !== undefined && extractFinalOutput(result) !== undefined;

  const continueLoop =
    !calledFinalOutput &&
    (continuationMessages.at(-1)?.role === "tool" ||
      normalizedProviderHistory.outcomeEndsResponse ||
      hasDeferredStepInput(nextSession));
  if (continueLoop) {
    if (emit) {
      emissionState = advanceStep(emissionState);
      nextSession = setHarnessEmissionState(nextSession, emissionState);
    }

    return { action: "continue", state: nextSession };
  }

  // `mode` is the fundamental terminal split: a task run must finish (an unmet
  // schema becomes an error), a conversation run may park. Whether a schema is
  // in effect is mode-independent — it is resolved once at the execution layer
  // and read straight off the session here.
  if (config.mode === "task") {
    return finishTaskTurn({
      emissionState,
      emit,
      history: promptMessages,
      result,
      schema: nextSession.outputSchema,
      session: nextSession,
      stepOutput,
    });
  }

  return finishConversationTurn({
    emissionState,
    emit,
    history: promptMessages,
    result,
    schema: nextSession.outputSchema,
    session: nextSession,
  });
}

export const OUTPUT_SCHEMA_NOT_FULFILLED = {
  code: "OUTPUT_SCHEMA_NOT_FULFILLED",
  message: "The agent could not produce a result matching the requested schema.",
} as const;

/**
 * The structured value the model delivered by calling the framework
 * `final_output` tool, or `undefined` when the terminal turn ended in prose.
 */
export function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find(
    (call) => call.toolName === FINAL_OUTPUT_TOOL_NAME && !isInvalidToolCall(call),
  )?.input as JsonValue | undefined;
}

/**
 * Persists the structured value as the assistant turn rather than the
 * un-executed `final_output` call, which would be a dangling tool_use on the
 * next turn. Clearing the run-scoped schema keeps it scoped to this turn.
 */
export function persistStructuredAssistantTurn(
  session: HarnessSession,
  history: readonly ModelMessage[],
  structured: JsonValue,
): HarnessSession {
  return {
    ...session,
    history: [...history, { content: JSON.stringify(structured), role: "assistant" }],
    outputSchema: undefined,
  };
}

function findAuthorizationSignalFromToolResults(
  toolResults: readonly TypedToolResult<ToolSet>[] | undefined,
  readStashedToolInterrupt: (callId: string) => unknown,
): AuthorizationSignal | undefined {
  for (const toolResult of toolResults ?? []) {
    const stashed = readStashedToolInterrupt(toolResult.toolCallId);
    if (stashed !== undefined && isAuthorizationSignal(stashed)) {
      return stashed;
    }
  }

  for (const toolResult of toolResults ?? []) {
    if (isAuthorizationSignal(toolResult.output)) {
      return toolResult.output;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Turn finish (absorbed from turn-finish.ts: settle is one service)
// ---------------------------------------------------------------------------

/** Emits `result.completed` followed by the turn epilogue for `mode`. */
async function emitStructuredResult(
  emit: NonNullable<GenerateConfig["handleEvent"]>,
  emissionState: ReturnType<typeof getHarnessEmissionState>,
  structured: JsonValue,
  mode: RunMode,
  continuationToken: string,
): Promise<ReturnType<typeof getHarnessEmissionState>> {
  await emit(
    createResultCompletedEvent({
      result: structured,
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    }),
  );
  return emitTurnEpilogue(emit, emissionState, mode, continuationToken);
}

/**
 * Closes a terminal task turn. Task runs cannot park, so an unmet output
 * schema fails as an error a delegating parent can surface; otherwise the
 * structured value — or the plain assistant text — is the run's output.
 */
export async function finishTaskTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
  readonly stepOutput: string | null;
}): Promise<GenerateOutcome> {
  const { emit, history, result, schema, stepOutput } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(
        emit,
        emissionState,
        "task",
        session.continuationToken,
      );
      session = setHarnessEmissionState(session, emissionState);
    }
    return { action: "done", output: stepOutput ?? "", state: session };
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      await emitFailedStep(emit, emissionState, {
        ...OUTPUT_SCHEMA_NOT_FULFILLED,
        sessionId: session.sessionId,
      });
    }
    return {
      action: "done",
      isError: true,
      output: OUTPUT_SCHEMA_NOT_FULFILLED.message,
      state: session,
    };
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(
      emit,
      emissionState,
      structured,
      "task",
      session.continuationToken,
    );
    session = setHarnessEmissionState(session, emissionState);
  }
  return { action: "done", output: structured, state: session };
}

/**
 * Closes a terminal conversation turn. Conversation runs may park, so an unmet
 * output schema parks recoverably; otherwise the structured value (or prose)
 * ends the turn and the session waits for the next message.
 */
export async function finishConversationTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
}): Promise<GenerateOutcome> {
  const { emit, history, result, schema } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(
        emit,
        emissionState,
        "conversation",
        session.continuationToken,
      );
      session = setHarnessEmissionState(session, emissionState);
    }
    return classifyParkedSession(session);
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
        ...OUTPUT_SCHEMA_NOT_FULFILLED,
        continuationToken: session.continuationToken,
      });
      session = setHarnessEmissionState(session, emissionState);
    }
    return classifyParkedSession(session);
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(
      emit,
      emissionState,
      structured,
      "conversation",
      session.continuationToken,
    );
    session = setHarnessEmissionState(session, emissionState);
  }
  return classifyParkedSession(session);
}
