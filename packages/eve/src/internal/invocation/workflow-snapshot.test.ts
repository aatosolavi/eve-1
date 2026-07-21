import { describe, expect, it } from "vitest";

import {
  createFailedAgentInvocation,
  projectActiveWorkflowInvocation,
} from "#internal/invocation/workflow-snapshot.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

describe("workflow invocation snapshots", () => {
  it("projects the latest pending input batch", () => {
    const invocation = projectActiveWorkflowInvocation({
      events: [
        { type: "turn.started", data: { sequence: 0, turnId: "turn_1" } },
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
                display: "select",
                options: [{ id: "yes", label: "Yes", style: "primary" }],
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
      ] as HandleMessageStreamEvent[],
      invocationId: "invocation",
    });

    expect(invocation).toMatchObject({
      inputRequests: [{ prompt: "Proceed?", requestId: "question" }],
      status: "input_required",
    });
    if (invocation.status !== "input_required") throw new Error("expected input_required");
    expect(invocation.inputRequests[0]).not.toHaveProperty("action");
    expect(invocation.inputRequests[0]).not.toHaveProperty("display");
    expect(invocation.inputRequests[0]?.options?.[0]).not.toHaveProperty("style");
  });

  it("projects only the workflow failure message", () => {
    expect(
      createFailedAgentInvocation({
        error: new Error("provider failed"),
        invocationId: "invocation",
      }),
    ).toEqual({
      error: { message: "provider failed" },
      invocationId: "invocation",
      status: "failed",
    });
  });
});
