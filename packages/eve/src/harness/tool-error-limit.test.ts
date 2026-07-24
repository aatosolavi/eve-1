import { describe, expect, it } from "vitest";

import {
  enforceConsecutiveToolErrorLimit,
  recordConsecutiveToolErrors,
} from "#harness/tool-error-limit.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const emissionState: HarnessEmissionState = {
  sessionStarted: true,
  sequence: 0,
  stepIndex: 2,
  turnId: "turn_0",
};

function createSession(maxConsecutiveToolErrors?: number): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "Test",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    limits: maxConsecutiveToolErrors === undefined ? undefined : { maxConsecutiveToolErrors },
    sessionId: "test-session",
  };
}

function record(
  session: HarnessSession,
  failedCallId: string,
  successfulCallId?: string,
): HarnessSession {
  const toolResults =
    successfulCallId === undefined
      ? []
      : [
          {
            input: {},
            output: { ok: true },
            toolCallId: successfulCallId,
            toolName: "query_dataset",
            type: "tool-result" as const,
          },
        ];
  return recordConsecutiveToolErrors({
    invalidToolCallIds: new Set([failedCallId]),
    result: {
      content: [],
      response: {
        id: "response-1",
        messages: [],
        modelId: "test-model",
        timestamp: new Date(0),
      },
      toolResults,
    },
    session,
    turnId: "turn_0",
  });
}

async function enforce(input: {
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly mode?: ToolLoopHarnessConfig["mode"];
  readonly session: HarnessSession;
  readonly turnId?: string;
}) {
  return enforceConsecutiveToolErrorLimit({
    config: {
      mode: input.mode ?? "conversation",
      resolveModel: async () => {
        throw new Error("The tool error policy does not resolve a model.");
      },
      tools: new Map(),
    },
    emissionState: {
      ...emissionState,
      turnId: input.turnId ?? emissionState.turnId,
    },
    emit: input.emit,
    session: input.session,
  });
}

describe("consecutive tool error limit", () => {
  it("defaults to ten errors", async () => {
    let session = createSession();
    for (let index = 1; index < 10; index++) {
      session = record(session, `call-${index}`);
    }
    expect(await enforce({ session })).toBeNull();
    expect(await enforce({ session: record(session, "call-10") })).not.toBeNull();
  });

  it("stops a conversation turn recoverably at the configured limit", async () => {
    const session = record(record(createSession(2), "call-1"), "call-2");
    const events: HandleMessageStreamEvent[] = [];
    const stopped = await enforce({
      emit: async (event) => {
        events.push(event);
      },
      session,
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
      await enforce({
        session: stopped?.session ?? session,
        turnId: "turn_1",
      }),
    ).toBeNull();
  });

  it("fails a task turn terminally at the configured limit", async () => {
    const stopped = await enforce({
      mode: "task",
      session: record(createSession(1), "call-1"),
    });

    expect(stopped?.next).toEqual({
      done: true,
      isError: true,
      output: "The turn stopped after 1 consecutive tool error.",
    });
  });

  it("resets the count when a step has any successful tool result", async () => {
    const failedSession = record(createSession(1), "call-error");
    const recoveredSession = record(failedSession, "call-error-again", "call-success");

    expect(await enforce({ session: recoveredSession })).toBeNull();
  });
});
