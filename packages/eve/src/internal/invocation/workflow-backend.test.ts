import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { WorkflowAgentInvocationBackend } from "#internal/invocation/workflow-backend.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const runsGet = vi.fn();
const returnValue = vi.fn();
const getReadable = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: runsGet } }),
  getRun: () => ({
    get returnValue() {
      return returnValue();
    },
    getReadable,
  }),
}));

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const runtime: Runtime = {
  cancelTurn: vi.fn(),
  deliver: vi.fn(),
  getEventStream: vi.fn(),
  resolveSession: vi.fn(),
  run: vi.fn(),
};

describe("WorkflowAgentInvocationBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReadable.mockReturnValue(eventStream([]));
  });

  it("starts an invocation with a continuation token", async () => {
    vi.mocked(runtime.run).mockResolvedValue({
      continuationToken: "mcp:invocation:token",
      events: new ReadableStream(),
      sessionId: "wrun_invocation",
    });
    const invocation = await execution().create({
      auth,
      message: "work",
    });

    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: "mcp",
        continuationToken: expect.stringMatching(/^mcp:invocation:/u),
        mode: "task",
      }),
    );
    expect(invocation).toMatchObject({ invocationId: "wrun_invocation", status: "working" });
  });

  it("allows another authenticated principal to use an invocation handle", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));

    await expect(execution().read({ invocationId: "wrun_invocation" })).resolves.toMatchObject({
      status: "working",
    });
  });

  it("rejects a workflow run without this channel's invocation token", async () => {
    runsGet.mockResolvedValue(
      run({ continuationToken: "other:invocation:token", status: "running" }),
    );

    await expect(execution().read({ invocationId: "wrun_invocation" })).resolves.toBeUndefined();
  });

  it("delivers responses through the persisted continuation token", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action: {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "ask_question",
                },
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
        } as HandleMessageStreamEvent,
      ]),
    );
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "wrun_invocation" });

    await backend().update({
      invocationId: "wrun_invocation",
      responses: [{ requestId: "question", text: "yes" }],
    });

    expect(runtime.deliver).toHaveBeenCalledWith({
      continuationToken: "mcp:invocation:token",
      payload: { inputResponses: [{ requestId: "question", text: "yes" }] },
      requestId: undefined,
    });
  });

  it("replays the existing event stream to reconstruct pending input", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        { type: "turn.started", data: { turnId: "turn_1" } } as HandleMessageStreamEvent,
        {
          type: "input.requested",
          data: {
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
            requests: [
              {
                action: {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "ask_question",
                },
                options: [{ id: "yes", label: "Yes" }],
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
          },
        } as HandleMessageStreamEvent,
      ]),
    );

    await expect(execution().read({ invocationId: "wrun_invocation" })).resolves.toMatchObject({
      inputRequests: [{ prompt: "Proceed?" }],
      status: "input_required",
    });
  });

  it("uses workflow return value as terminal result", async () => {
    runsGet.mockResolvedValue(run({ status: "completed" }));
    returnValue.mockResolvedValue({ output: { answer: 42 } });

    await expect(execution().read({ invocationId: "wrun_invocation" })).resolves.toMatchObject({
      result: { answer: 42 },
      status: "completed",
    });
    expect(getReadable).not.toHaveBeenCalled();
  });
});

function execution(): WorkflowAgentInvocationBackend {
  return backend();
}

function backend(): WorkflowAgentInvocationBackend {
  return new WorkflowAgentInvocationBackend({
    adapter: { kind: "mcp" },
    channelName: "mcp",
    runtime,
  });
}

function run(input: { continuationToken?: string; status: string }) {
  return {
    attributes: {},
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
    input: [
      {
        serializedContext: {
          "eve.channelInstrumentation": { kind: "channel:mcp", metadata: {} },
          "eve.continuationToken": input.continuationToken ?? "mcp:invocation:token",
          "eve.initiatorAuth": auth,
        },
      },
    ],
    runId: "wrun_invocation",
    status: input.status,
  };
}

function eventStream(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`${JSON.stringify(event)}\n`));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return Object.assign(stream, { getTailIndex: async () => events.length - 1 });
}
