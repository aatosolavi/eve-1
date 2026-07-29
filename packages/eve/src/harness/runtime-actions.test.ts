import { describe, expect, it } from "vitest";

import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
  resolvePendingRuntimeActions,
  resolveToolCallInputObject,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

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

  it("backfills inherited sandbox state without exposing internal metadata", async () => {
    const session = createParkedSession();
    const events: unknown[] = [];
    const sandboxState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };

    const resolved = await resolvePendingRuntimeActions({
      emit: async (event) => {
        events.push(event);
      },
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "test-session",
              state: sandboxState,
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    const actionResult = events.find(isActionResultEvent);

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toEqual(sandboxState);
    expect(actionResult?.data.result).toMatchObject({
      callId: "call-1",
      kind: "subagent-result",
      output: "done",
      subagentName: "researcher",
    });
    expect(actionResult?.data.result).not.toHaveProperty("inheritedSandbox");
  });

  it("backfills inherited sandbox state from failed subagent results", async () => {
    const session = createParkedSession();
    const sandboxState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "test-session",
              state: sandboxState,
            },
            isError: true,
            kind: "subagent-result",
            output: { code: "SUBAGENT_EXECUTION_FAILED", message: "boom" },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toEqual(sandboxState);
  });

  it("prefers initialized inherited sandbox state over a later uninitialized capture", async () => {
    let session = createParkedSession();
    session = setPendingRuntimeActionBatch({
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
        {
          callId: "call-2",
          description: "reviewer subagent",
          input: { message: "review" },
          kind: "subagent-call",
          name: "reviewer",
          nodeId: "subagents/reviewer",
          subagentName: "reviewer",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session,
    });

    const initializedState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };
    const uninitializedState = {
      initialized: false,
      session: null,
    };

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "test-session",
              state: initializedState,
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
          {
            callId: "call-2",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "test-session",
              state: uninitializedState,
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "reviewer",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toEqual(initializedState);
  });

  it("ignores inherited sandbox results that do not match the parent session id", async () => {
    const session = createParkedSession();
    const sandboxState = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "other-session",
              state: sandboxState,
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toBeUndefined();
  });

  it("accepts nested shared-sandbox backfill addressed to the mid-chain parent", async () => {
    // Leaf kept sandboxSessionId=root owner, but inheritedSandbox.sessionId is
    // the immediate parent (mid). Mid must accept and store the capture so it
    // can later forward to root.
    const midSession = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-leaf",
          description: "leaf worker",
          input: { message: "work" },
          kind: "subagent-call",
          name: "worker",
          nodeId: "subagents/researcher/subagents/worker",
          subagentName: "worker",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: {
        agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:mid-session",
        history: [{ content: "delegate", role: "user" }],
        sessionId: "mid-session",
      },
    });

    const leafCapture = {
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    };

    const resolved = await resolvePendingRuntimeActions({
      session: midSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-leaf",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "mid-session",
              state: leafCapture,
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "worker",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toEqual(leafCapture);
  });

  it("does not clobber reattach metadata with an initialized capture that has null session", async () => {
    let session = createParkedSession();
    session = {
      ...session,
      sandboxState: {
        initialized: true,
        session: {
          backendName: "test-sandbox",
          metadata: { workspace: "repo" },
          sessionKey: "sandbox-session-key",
        },
      },
    };
    session = setPendingRuntimeActionBatch({
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
      session,
    });

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            inheritedSandbox: {
              nodeId: "__root__",
              sessionId: "test-session",
              state: { initialized: true, session: null },
            },
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(resolved.session.sandboxState).toEqual({
      initialized: true,
      session: {
        backendName: "test-sandbox",
        metadata: { workspace: "repo" },
        sessionKey: "sandbox-session-key",
      },
    });
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

describe("resolveToolCallInputObject", () => {
  const context = { callId: "call-1", toolName: "web_search" };

  it("passes plain objects through", () => {
    expect(resolveToolCallInputObject({ query: "eve" }, context)).toEqual({ query: "eve" });
  });

  it("treats undefined, null, and empty-string inputs as empty arguments", () => {
    expect(resolveToolCallInputObject(undefined, context)).toEqual({});
    expect(resolveToolCallInputObject(null, context)).toEqual({});
    expect(resolveToolCallInputObject("", context)).toEqual({});
    expect(resolveToolCallInputObject("  ", context)).toEqual({});
  });

  it("parses raw JSON-string inputs from provider-executed tool calls", () => {
    expect(resolveToolCallInputObject('{"query":"eve"}', context)).toEqual({ query: "eve" });
  });

  it("rejects strings that are not JSON objects, naming the tool and call", () => {
    expect(() => resolveToolCallInputObject('"query"', context)).toThrow(
      /web_search.*call-1.*Expected a JSON-serializable object/su,
    );
    expect(() => resolveToolCallInputObject("not json", context)).toThrow(/web_search.*call-1/su);
  });

  it("rejects non-object JSON values", () => {
    expect(() => resolveToolCallInputObject(42, context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
    expect(() => resolveToolCallInputObject(["a"], context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
  });
});

function isActionResultEvent(event: unknown): event is {
  readonly data: { readonly result: Record<string, unknown> };
  readonly type: "action.result";
} {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { readonly type?: unknown }).type === "action.result" &&
    typeof (event as { readonly data?: unknown }).data === "object" &&
    (event as { readonly data?: unknown }).data !== null
  );
}
