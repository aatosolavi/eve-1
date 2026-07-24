import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { HarnessSession, StepResult, ToolLoopHarnessConfig } from "#harness/types.js";

const CONSECUTIVE_TOOL_ERRORS_STATE_KEY = "eve.tool-errors.consecutive";
const CONSECUTIVE_TOOL_ERROR_LIMIT_REACHED_CODE = "CONSECUTIVE_TOOL_ERROR_LIMIT_REACHED";

interface ConsecutiveToolErrorsState {
  readonly count: number;
  readonly turnId: string;
}

/**
 * Records the tool outcomes from one completed model step.
 *
 * Failed calls accumulate only when the step made no successful tool-call
 * progress. Any successful result, or a step without tool errors, resets the
 * counter. The count is scoped to the active turn id so cancelled or otherwise
 * interrupted turns cannot poison a later user turn.
 */
export function recordConsecutiveToolErrors(input: {
  readonly invalidToolCallIds: ReadonlySet<string>;
  readonly result: HarnessStepResult;
  readonly session: HarnessSession;
  readonly turnId: string;
}): HarnessSession {
  if (input.session.limits?.maxConsecutiveToolErrors === undefined) {
    return clearConsecutiveToolErrors(input.session);
  }

  const outcomes = collectToolOutcomes(input.result, input.invalidToolCallIds);
  if (outcomes.errorCallIds.size === 0 || outcomes.successCallIds.size > 0) {
    return clearConsecutiveToolErrors(input.session);
  }

  const previous = readConsecutiveToolErrors(input.session);
  const count =
    (previous?.turnId === input.turnId ? previous.count : 0) + outcomes.errorCallIds.size;

  return {
    ...input.session,
    state: {
      ...input.session.state,
      [CONSECUTIVE_TOOL_ERRORS_STATE_KEY]: {
        count,
        turnId: input.turnId,
      } satisfies ConsecutiveToolErrorsState,
    },
  };
}

/**
 * Stops a turn before its next model call when its consecutive tool-error
 * count has reached the configured agent limit.
 *
 * Conversation sessions emit a recoverable turn failure and remain resumable.
 * Task sessions fail terminally so a delegating parent receives an error
 * result instead of silently retrying the child.
 */
export async function enforceConsecutiveToolErrorLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}): Promise<StepResult | null> {
  const limit = input.session.limits?.maxConsecutiveToolErrors;
  const current = readConsecutiveToolErrors(input.session);
  if (
    limit === undefined ||
    current === undefined ||
    current.turnId !== input.emissionState.turnId ||
    current.count < limit
  ) {
    return null;
  }

  const message = `The turn stopped after ${current.count} consecutive tool ${
    current.count === 1 ? "error" : "errors"
  }.`;
  const details = {
    consecutiveToolErrors: current.count,
    limit,
  };
  let session = clearConsecutiveToolErrors(input.session);

  if (input.config.mode === "conversation") {
    if (input.emit !== undefined) {
      const emissionState = await emitRecoverableFailedTurn(input.emit, input.emissionState, {
        code: CONSECUTIVE_TOOL_ERROR_LIMIT_REACHED_CODE,
        continuationToken: session.continuationToken,
        details,
        message,
      });
      session = setHarnessEmissionState(session, emissionState);
    }
    return { next: null, session };
  }

  if (input.emit !== undefined) {
    await emitFailedStep(input.emit, input.emissionState, {
      code: CONSECUTIVE_TOOL_ERROR_LIMIT_REACHED_CODE,
      details,
      message,
      sessionId: session.sessionId,
    });
  }
  return {
    next: { done: true, isError: true, output: message },
    session,
  };
}

function collectToolOutcomes(
  result: HarnessStepResult,
  invalidToolCallIds: ReadonlySet<string>,
): {
  readonly errorCallIds: ReadonlySet<string>;
  readonly successCallIds: ReadonlySet<string>;
} {
  const errorCallIds = new Set(invalidToolCallIds);
  const successCallIds = new Set(result.toolResults.map((toolResult) => toolResult.toolCallId));

  collectContentOutcomes(result.content ?? [], errorCallIds, successCallIds);
  for (const message of result.response.messages) {
    if (Array.isArray(message.content)) {
      collectContentOutcomes(message.content, errorCallIds, successCallIds);
    }
  }

  for (const callId of errorCallIds) {
    successCallIds.delete(callId);
  }

  return { errorCallIds, successCallIds };
}

function collectContentOutcomes(
  content: readonly unknown[],
  errorCallIds: Set<string>,
  successCallIds: Set<string>,
): void {
  for (const candidate of content) {
    if (typeof candidate !== "object" || candidate === null || !("type" in candidate)) {
      continue;
    }

    const part = candidate as {
      readonly output?: unknown;
      readonly toolCallId?: unknown;
      readonly type?: unknown;
    };
    if (typeof part.toolCallId !== "string") {
      continue;
    }

    if (part.type === "tool-error" || isErrorToolResultOutput(part.output)) {
      errorCallIds.add(part.toolCallId);
    } else if (part.type === "tool-result") {
      successCallIds.add(part.toolCallId);
    }
  }
}

function isErrorToolResultOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null || !("type" in output)) {
    return false;
  }
  const type = (output as { readonly type?: unknown }).type;
  return type === "error-json" || type === "error-text";
}

function readConsecutiveToolErrors(
  session: HarnessSession,
): ConsecutiveToolErrorsState | undefined {
  const value = session.state?.[CONSECUTIVE_TOOL_ERRORS_STATE_KEY];
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const state = value as Partial<ConsecutiveToolErrorsState>;
  if (
    typeof state.count !== "number" ||
    !Number.isSafeInteger(state.count) ||
    state.count < 1 ||
    typeof state.turnId !== "string"
  ) {
    return undefined;
  }
  return { count: state.count, turnId: state.turnId };
}

function clearConsecutiveToolErrors(session: HarnessSession): HarnessSession {
  if (session.state?.[CONSECUTIVE_TOOL_ERRORS_STATE_KEY] === undefined) {
    return session;
  }

  const { [CONSECUTIVE_TOOL_ERRORS_STATE_KEY]: _consecutiveToolErrors, ...state } = session.state;
  return { ...session, state };
}
