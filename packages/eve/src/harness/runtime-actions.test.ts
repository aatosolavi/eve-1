import { describe, expect, it, vi } from "vitest";

import {
  collectTaskElections,
  createRuntimeActionRequestFromToolCall,
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "research subagent",
        input: { message: "go" },
        kind: "subagent-call",
        name: "researcher",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

describe("resolvePendingRuntimeActions", () => {
  it("draws completed child usage down against the parent's session totals", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });
  });

  it("leaves the parent's totals untouched when the child reports no usage", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
  });
});

describe("task election gating", () => {
  const toolCall = (input: Record<string, unknown>) =>
    ({
      input,
      toolCallId: "call-1",
      toolName: "agent",
      type: "tool-call" as const,
    }) as Parameters<typeof createRuntimeActionRequestFromToolCall>[0]["toolCall"];

  const toolsWith = (taskSupport?: "optional"): HarnessToolMap => {
    const runtimeAction = {
      kind: "subagent-call" as const,
      nodeId: "subagents/agent",
      subagentName: "agent",
    };
    return new Map([
      [
        "agent",
        {
          description: "delegate",
          inputSchema: { jsonSchema: { type: "object" } } as never,
          name: "agent",
          runtimeAction:
            taskSupport === undefined ? runtimeAction : { ...runtimeAction, taskSupport },
        },
      ],
    ]);
  };

  it("records a valid election when the definition declares taskSupport", () => {
    const elections = collectTaskElections({
      toolCalls: [toolCall({ message: "go", task: { ttlMs: 60_000 } })],
      tools: toolsWith("optional"),
    });

    expect(elections).toEqual({ "call-1": { ttlMs: 60_000 } });
  });

  it("keeps the action request itself election-free", () => {
    const action = createRuntimeActionRequestFromToolCall({
      toolCall: toolCall({ message: "go", task: { ttlMs: 60_000 } }),
      tools: toolsWith("optional"),
    });

    expect("task" in action).toBe(false);
  });

  it("never records an election for an undeclared tool, whatever the model sent", () => {
    const elections = collectTaskElections({
      toolCalls: [toolCall({ message: "go", task: {} })],
      tools: toolsWith(undefined),
    });

    expect(elections).toBeUndefined();
  });

  it("ignores malformed task fields", () => {
    const elections = collectTaskElections({
      toolCalls: [toolCall({ message: "go", task: { ttlMs: "forever" } })],
      tools: toolsWith("optional"),
    });

    expect(elections).toBeUndefined();
  });

  it("stores elections on the pending batch", () => {
    const session = setPendingRuntimeActionBatch({
      actions: [],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createParkedSession(),
      taskElections: { "call-1": { ttlMs: null } },
    });

    expect(getPendingRuntimeActionBatch(session.state)?.taskElections).toEqual({
      "call-1": { ttlMs: null },
    });
  });
});

describe("placeholder result events", () => {
  it("suppresses subagent.completed for CreateTaskResult placeholders", async () => {
    const session = createParkedSession();
    const emit = vi.fn();

    const resolved = await resolvePendingRuntimeActions({
      emit,
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: {
              createdAt: "2026-07-23T00:00:00.000Z",
              lastUpdatedAt: "2026-07-23T00:00:00.000Z",
              status: "working",
              taskId: "task_1",
              ttlMs: null,
            },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    const emitted = emit.mock.calls.map(([event]) => (event as { type: string }).type);
    expect(emitted).not.toContain("subagent.completed");
    expect(emitted).toContain("action.result");
  });

  it("still emits subagent.completed for real subagent outputs", async () => {
    const session = createParkedSession();
    const emit = vi.fn();

    await resolvePendingRuntimeActions({
      emit,
      session,
      stepInput: {
        runtimeActionResults: [
          { callId: "call-1", kind: "subagent-result", output: "done", subagentName: "researcher" },
        ],
      },
    });

    expect(emit.mock.calls.map(([event]) => (event as { type: string }).type)).toContain(
      "subagent.completed",
    );
  });
});

describe("pending subagent child adoption", () => {
  it("records child session ids without disturbing local continuation-token cleanup", () => {
    let session = createParkedSession();
    session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken: "subagent:test-session:call-1",
        kind: "local",
        sessionId: "local-child",
      },
      session,
    });
    session = recordPendingSubagentChild({
      callId: "call-remote",
      child: { kind: "remote", sessionId: "remote-child" },
      session,
    });

    expect(getPendingRuntimeActionBatch(session.state)).toMatchObject({
      childContinuationTokens: {
        "call-1": "subagent:test-session:call-1",
      },
      childSessionIds: {
        "call-1": "local-child",
        "call-remote": "remote-child",
      },
    });
  });
});
