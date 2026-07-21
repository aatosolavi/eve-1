import { describe, expect, it, vi } from "vitest";

import {
  AgentInvocationConflictError,
  AgentInvocationNotFoundError,
  type AgentInvocation,
  type AgentInvocationClient,
} from "#internal/invocation/agent-invocation-service.js";
import { createMcpInvocationTools } from "#internal/mcp/invocation-tools.js";

const invocation: AgentInvocation = {
  invocationId: "inv_1",
  status: "working",
};

function client(): AgentInvocationClient {
  return {
    create: vi.fn().mockResolvedValue(invocation),
    read: vi.fn().mockResolvedValue(invocation),
    update: vi.fn().mockResolvedValue(invocation),
  };
}

function clientForCaller(invocationClient = client()): () => AgentInvocationClient {
  return () => invocationClient;
}

describe("MCP invocation tools", () => {
  it("derives agent_respond JSON Schema from the runtime input schema", () => {
    const update = createMcpInvocationTools(clientForCaller(), {
      description: "Delegates work.",
    }).find((tool) => tool.definition.name === "agent_respond");

    expect(update?.definition.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        responses: {
          items: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                required: expect.arrayContaining(["requestId", "optionId"]),
              }),
              expect.objectContaining({ required: expect.arrayContaining(["requestId", "text"]) }),
            ]),
            description:
              "One answer to a pending input request. Provide exactly one of optionId or text.",
          },
          minItems: 1,
          type: "array",
        },
      },
      required: ["invocationId", "responses"],
      type: "object",
    });
  });

  it.each([
    [new AgentInvocationNotFoundError(), "invocation_not_found"],
    [new AgentInvocationConflictError("not waiting"), "invocation_conflict"],
  ])("maps invocation domain errors at the tool boundary", async (error, code) => {
    const invocationClient = client();
    vi.mocked(invocationClient.read).mockRejectedValue(error);
    const read = createMcpInvocationTools(clientForCaller(invocationClient), {
      description: "Delegates work.",
    }).find((tool) => tool.definition.name === "agent_get")!;

    await expect(
      read.call(
        { invocationId: "inv_1" },
        { auth: {} as never, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code });
  });

  it("uses the same schema to parse agent_respond calls", async () => {
    const invocationClient = client();
    const update = createMcpInvocationTools(clientForCaller(invocationClient), {
      description: "Delegates work.",
    }).find((tool) => tool.definition.name === "agent_respond")!;

    await update.call(
      {
        invocationId: "inv_1",
        responses: [{ requestId: "question", text: "yes" }],
      },
      { auth: {} as never, signal: new AbortController().signal },
    );

    expect(invocationClient.update).toHaveBeenCalledWith({
      invocationId: "inv_1",
      responses: [{ requestId: "question", text: "yes" }],
    });
    await expect(
      update.call(
        { invocationId: "inv_1", responses: [{ requestId: "question", extra: true }] },
        { auth: {} as never, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      data: { issues: expect.any(Array) },
    });
  });
});
