import { describe, expect, it, vi } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/slack/defaults.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

function sessionContext(
  current: SessionContext["session"]["auth"]["current"] = null,
): SessionContext {
  return {
    getSandbox: vi.fn(),
    getSkill: vi.fn(),
    session: {
      auth: { current, initiator: null },
      id: "test-session",
      turn: { id: "test-turn", sequence: 0 },
    },
  };
}

const sessionCtx = sessionContext();

function buildChannelStub(state: Partial<SlackChannelState> = {}) {
  const postEphemeral = vi.fn().mockResolvedValue({ id: "eph1" });
  const post = vi.fn().mockResolvedValue({ id: "ts1" });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn().mockResolvedValue({ ok: true });
  const channel = {
    thread: { postEphemeral, post, startTyping } as Partial<SlackEventContext["thread"]>,
    slack: { channelId: "C123", request } as Partial<SlackEventContext["slack"]>,
    state: {
      channelId: "C123",
      threadTs: "111.222",
      teamId: null,
      ...state,
    },
  } as SlackEventContext;
  return { channel, post, postEphemeral, request, startTyping };
}

type ActionsRequestedEvent = Extract<HandleMessageStreamEvent, { type: "actions.requested" }>;
type ActionResultEvent = Extract<HandleMessageStreamEvent, { type: "action.result" }>;

function actionsRequested(
  toolName: string,
  input: ActionsRequestedEvent["data"]["actions"][number]["input"],
  callId = "call_1",
): ActionsRequestedEvent {
  return {
    type: "actions.requested",
    data: {
      actions: [{ callId, input, kind: "tool-call", toolName }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
  };
}

function actionResult(
  toolName: string,
  status: ActionResultEvent["data"]["status"] = "completed",
  callId = "call_1",
): ActionResultEvent {
  return {
    type: "action.result",
    data: {
      result: {
        callId,
        ...(status === "completed" ? {} : { isError: true }),
        kind: "tool-result",
        output: { todos: [] },
        toolName,
      },
      sequence: 1,
      status,
      stepIndex: 0,
      turnId: "turn_0",
    },
  };
}

function nestedSubagentEvent(
  event: HandleMessageStreamEvent,
): Extract<HandleMessageStreamEvent, { type: "subagent.event" }> {
  return {
    type: "subagent.event",
    data: {
      callId: "outer_call",
      subagentName: "outer",
      event: {
        type: "subagent.event",
        data: {
          callId: "inner_call",
          subagentName: "inner",
          event,
        },
      },
    },
  };
}

function authRequiredEvent(
  overrides: { url?: string; userCode?: string; displayName?: string } = {},
) {
  return {
    authorization: { url: overrides.url ?? "https://connect.example.com/a/sca_1", ...overrides },
    description: "Authorization required for notion",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  };
}

describe("defaultEvents authorization.required", () => {
  it("posts a public status and delivers the challenge ephemerally to the triggering user", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Connect with Notion to continue");
    expect(publicText).not.toContain("https://");
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U777");
    const message = postEphemeral.mock.calls[0]?.[1] as { text: string; blocks: unknown[] };
    expect(message.text).toContain("https://connect.example.com/a/sca_1");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("targets the current Slack caller instead of stale channel state", async () => {
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U_FIRST" });
    const currentCaller = sessionContext({
      attributes: { user_id: "U_CURRENT" },
      authenticator: "slack-webhook",
      principalId: "slack:T01:U_CURRENT",
      principalType: "user",
    });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, currentCaller);

    expect(postEphemeral.mock.calls[0]?.[0]).toBe("U_CURRENT");
  });

  it("renders the device user code in the ephemeral blocks and fallback text", async () => {
    const { channel, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ userCode: "OTB-DGO" }),
      channel,
      sessionCtx,
    );

    const message = postEphemeral.mock.calls[0]?.[1] as { text: string; blocks: unknown[] };
    expect(JSON.stringify(message.blocks)).toContain("OTB-DGO");
    expect(message.text).toContain("(code: OTB-DGO)");
  });

  it("renders the challenge displayName instead of the title-cased connection name", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });

    await defaultEvents["authorization.required"]!(
      authRequiredEvent({ displayName: "Notion Workspace" }),
      channel,
      sessionCtx,
    );

    expect(post.mock.calls[0]?.[0]).toBe("Connect with Notion Workspace to continue");
    const message = postEphemeral.mock.calls[0]?.[1] as { text: string };
    expect(message.text).toContain("Sign in with Notion Workspace");
  });

  it("posts a link-free public status when there is no triggering user", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: null });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Authorization required for Notion (no triggering user)");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("keeps the link-free public status when the ephemeral delivery fails", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({ triggeringUserId: "U777" });
    postEphemeral.mockRejectedValueOnce(new Error("ephemeral rejected"));

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledTimes(1);
    const publicText = post.mock.calls[0]?.[0] as string;
    expect(publicText).toBe("Connect with Notion to continue");
    expect(publicText).not.toContain("https://");
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts1" });
  });

  it("reuses an existing public status when authorization is already pending", async () => {
    const { channel, post, postEphemeral } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts0" },
    });

    await defaultEvents["authorization.required"]!(authRequiredEvent(), channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(channel.state.pendingAuthMessageTs).toEqual({ notion: "ts0" });
  });
});

describe("defaultEvents authorization.completed", () => {
  it("edits the public status in place when one was posted", async () => {
    const { channel, postEphemeral, request } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts1" },
    });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts1",
      text: ":white_check_mark: Notion connected",
    });
    expect(postEphemeral).not.toHaveBeenCalled();
    expect(channel.state.pendingAuthMessageTs).toEqual({});
  });

  it("renders the challenge displayName in the completion status", async () => {
    const { channel, request } = buildChannelStub({
      triggeringUserId: "U777",
      pendingAuthMessageTs: { notion: "ts1" },
    });

    await defaultEvents["authorization.completed"]!(
      {
        authorization: { displayName: "Notion Workspace" },
        name: "notion",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      },
      channel,
      sessionCtx,
    );

    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts1",
      text: ":white_check_mark: Notion Workspace connected",
    });
  });

  it("stays silent when no public status was recorded", async () => {
    const { channel, post, postEphemeral, request } = buildChannelStub({
      triggeringUserId: "U777",
    });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "failed", sequence: 1, stepIndex: 0, turnId: "turn_0" },
      channel,
      sessionCtx,
    );

    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});

describe("defaultEvents progress rendering", () => {
  it("keeps requested-action labels in the transient typing status", async () => {
    const { channel, post, startTyping } = buildChannelStub();
    const event = actionsRequested("grep", { pattern: "subagent.event" });

    await defaultEvents["actions.requested"]!(event.data, channel, sessionCtx);

    expect(startTyping).toHaveBeenCalledWith("grep subagent.event");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts a todo write only after it succeeds", async () => {
    const { channel, post } = buildChannelStub();
    const requested = actionsRequested("functions.todo", {
      todos: [
        { content: "Inspect the Slack renderer", priority: "high", status: "completed" },
        { content: "Render todo progress", priority: "high", status: "in_progress" },
        { content: "Run validation", priority: "medium", status: "pending" },
        { content: "Skip unrelated cleanup", priority: "low", status: "cancelled" },
      ],
    });

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    expect(post).not.toHaveBeenCalled();

    const completed = actionResult("functions.todo");
    await defaultEvents["action.result"]!(completed.data, channel, sessionCtx);

    expect(post).toHaveBeenCalledWith(
      [
        "*Progress*",
        "- [x] Inspect the Slack renderer",
        "- [~] Render todo progress",
        "- [ ] Run validation",
        "- [-] Skip unrelated cleanup",
      ].join("\n"),
    );
    expect(channel.state.todoProgressMessageTs).toBe("ts1");
  });

  it.each(["failed", "rejected"] as const)("does not persist a %s todo write", async (status) => {
    const { channel, post } = buildChannelStub();
    const requested = actionsRequested("todo", {
      todos: [{ content: "Do not show this", priority: "high", status: "in_progress" }],
    });

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    const result = actionResult("todo", status);
    await defaultEvents["action.result"]!(result.data, channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(channel.state.pendingTodoProgress).toEqual({});
  });

  it("does not persist successful todo reads", async () => {
    const { channel, post, startTyping } = buildChannelStub();
    const requested = actionsRequested("todo", {});

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    const completed = actionResult("todo");
    await defaultEvents["action.result"]!(completed.data, channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(startTyping).toHaveBeenCalledWith("todo");
  });

  it("replaces the existing persistent checklist", async () => {
    const { channel, post, request } = buildChannelStub({ todoProgressMessageTs: "ts0" });
    const requested = actionsRequested(
      "todo",
      { todos: [{ content: "Publish", priority: "high", status: "completed" }] },
      "call_2",
    );

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    const completed = actionResult("todo", "completed", "call_2");
    await defaultEvents["action.result"]!(completed.data, channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts0",
      text: "*Progress*\n- [x] Publish",
    });
  });

  it("clears the existing checklist after a successful empty write", async () => {
    const { channel, post, request } = buildChannelStub({ todoProgressMessageTs: "ts0" });
    const requested = actionsRequested("todo", { todos: [] });

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    const completed = actionResult("todo");
    await defaultEvents["action.result"]!(completed.data, channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C123",
      ts: "ts0",
      text: "*Progress*\n_No tasks._",
    });
  });

  it("ignores malformed todo writes", async () => {
    const { channel, post } = buildChannelStub();
    const requested = actionsRequested("todo", {
      todos: [{ content: "Invalid", priority: "high", status: "unknown" }],
    });

    await defaultEvents["actions.requested"]!(requested.data, channel, sessionCtx);
    const completed = actionResult("todo");
    await defaultEvents["action.result"]!(completed.data, channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
  });

  it("posts successful todo writes nested inside inline subagent events", async () => {
    const { channel, post } = buildChannelStub();
    const requested = nestedSubagentEvent(
      actionsRequested("todo", {
        todos: [{ content: "Check the child result", priority: "high", status: "in_progress" }],
      }),
    );

    await defaultEvents["subagent.event"]!(requested.data, channel, sessionCtx);
    expect(post).not.toHaveBeenCalled();

    const completed = nestedSubagentEvent(actionResult("todo"));
    await defaultEvents["subagent.event"]!(completed.data, channel, sessionCtx);

    expect(post).toHaveBeenCalledWith("*Progress*\n- [~] Check the child result");
  });
});
