import { describe, expect, it } from "vitest";

import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  enforceConsecutiveToolErrorLimit,
  recordConsecutiveToolErrors,
} from "#harness/tool-error-limit.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function createSession(
  maxConsecutiveToolErrors: number,
  mode: ToolLoopHarnessConfig["mode"] = "conversation",
): { readonly config: ToolLoopHarnessConfig; readonly session: HarnessSession } {
  return {
    config: {
      mode,
      resolveModel: async () => {
        throw new Error("The tool error policy does not resolve a model.");
      },
      tools: new Map(),
    },
    session: {
      agent: {
        modelReference: { id: "test-model" },
        system: "Test",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:test-session",
      history: [],
      limits: { maxConsecutiveToolErrors },
      sessionId: "test-session",
    },
  };
}

function createStepResult(input?: { readonly successfulToolCallId?: string }): HarnessStepResult {
  const toolResults =
    input?.successfulToolCallId === undefined
      ? []
      : [
          {
            input: {},
            output: { ok: true },
            toolCallId: input.successfulToolCallId,
            toolName: "query_dataset",
            type: "tool-result" as const,
          },
        ];

  return {
    content: [],
    finishReason: "tool-calls",
    providerMetadata: undefined,
    response: {
      id: "response-1",
      messages: [],
      modelId: "test-model",
      timestamp: new Date(0),
    },
    text: "",
    toolCalls: [],
    toolResults,
    usage: {
      inputTokenDetails: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        noCacheTokens: 1,
      },
      inputTokens: 1,
      outputTokenDetails: { reasoningTokens: undefined, textTokens: 1 },
      outputTokens: 1,
      totalTokens: 2,
    },
  } as HarnessStepResult;
}

describe("consecutive tool error limit", () => {
  it("stops a conversation turn recoverably at the configured limit", async () => {
    const { config, session: initialSession } = createSession(2);
    const result = createStepResult();
    const events: HandleMessageStreamEvent[] = [];
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      events.push(event);
    };
    const emissionState = {
      sessionStarted: true,
      sequence: 0,
      stepIndex: 2,
      turnId: "turn_0",
    };
    const afterFirst = recordConsecutiveToolErrors({
      invalidToolCallIds: new Set(["call-1"]),
      result,
      session: initialSession,
      turnId: emissionState.turnId,
    });
    const afterSecond = recordConsecutiveToolErrors({
      invalidToolCallIds: new Set(["call-2"]),
      result,
      session: afterFirst,
      turnId: emissionState.turnId,
    });

    const stopped = await enforceConsecutiveToolErrorLimit({
      config,
      emit,
      emissionState,
      session: afterSecond,
    });

    expect(stopped?.next).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      "step.failed",
      "turn.failed",
      "session.waiting",
    ]);
    expect(events.find((event) => event.type === "step.failed")?.data).toMatchObject({
      code: "CONSECUTIVE_TOOL_ERROR_LIMIT_REACHED",
      details: { consecutiveToolErrors: 2, limit: 2 },
      message: "The turn stopped after 2 consecutive tool errors.",
    });
    expect(
      await enforceConsecutiveToolErrorLimit({
        config,
        emissionState: { ...emissionState, turnId: "turn_1" },
        session: stopped?.session ?? afterSecond,
      }),
    ).toBeNull();
  });

  it("fails a task turn terminally at the configured limit", async () => {
    const { config, session: initialSession } = createSession(1, "task");
    const session = recordConsecutiveToolErrors({
      invalidToolCallIds: new Set(["call-1"]),
      result: createStepResult(),
      session: initialSession,
      turnId: "turn_0",
    });

    const stopped = await enforceConsecutiveToolErrorLimit({
      config,
      emissionState: {
        sessionStarted: true,
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_0",
      },
      session,
    });

    expect(stopped?.next).toEqual({
      done: true,
      isError: true,
      output: "The turn stopped after 1 consecutive tool error.",
    });
  });

  it("resets the count when a step has any successful tool result", async () => {
    const { config, session: initialSession } = createSession(1);
    const failedSession = recordConsecutiveToolErrors({
      invalidToolCallIds: new Set(["call-error"]),
      result: createStepResult(),
      session: initialSession,
      turnId: "turn_0",
    });
    const recoveredSession = recordConsecutiveToolErrors({
      invalidToolCallIds: new Set(["call-error-again"]),
      result: createStepResult({ successfulToolCallId: "call-success" }),
      session: failedSession,
      turnId: "turn_0",
    });

    expect(
      await enforceConsecutiveToolErrorLimit({
        config,
        emissionState: {
          sessionStarted: true,
          sequence: 0,
          stepIndex: 2,
          turnId: "turn_0",
        },
        session: recoveredSession,
      }),
    ).toBeNull();
  });
});
