import { describe, expect, it } from "vitest";

import {
  appendUser,
  closeExchange,
  emptyHistory,
  openExchange,
  resolveExchangeRequest,
} from "./transcript.js";
import { createBalancedHistory } from "./types.js";

describe("prototype transcript", () => {
  it("rejects history with an unresolved assistant request", () => {
    expect(() =>
      createBalancedHistory([{ content: "calling", requestIds: ["request-1"], role: "assistant" }]),
    ).toThrow('Assistant request "request-1" has no matching result.');
  });

  it("keeps an unresolved request outside balanced history", () => {
    const history = appendUser(emptyHistory(), "hello");
    const exchange = openExchange({
      assistant: {
        content: "calling",
        requestIds: ["request-1"],
        role: "assistant",
      },
      requests: [
        {
          input: "hello",
          kind: "approval",
          name: "echo",
          requestId: "request-1",
        },
      ],
    });

    expect(closeExchange(history, exchange)).toBeNull();
    expect(history).toEqual([{ content: "hello", role: "user" }]);
  });

  it("commits the assistant request and matching result together", () => {
    const history = appendUser(emptyHistory(), "hello");
    const exchange = resolveExchangeRequest(
      openExchange({
        assistant: {
          content: "calling",
          requestIds: ["request-1"],
          role: "assistant",
        },
        requests: [
          {
            input: "hello",
            kind: "tool",
            name: "echo",
            requestId: "request-1",
          },
        ],
      }),
      { isError: false, requestId: "request-1", value: "hello" },
    );

    expect(closeExchange(history, exchange)).toEqual([
      { content: "hello", role: "user" },
      { content: "calling", requestIds: ["request-1"], role: "assistant" },
      { content: "hello", isError: false, requestId: "request-1", role: "tool" },
    ]);
  });

  it("rejects assistant request IDs that do not match the request list", () => {
    expect(() =>
      openExchange({
        assistant: { content: "calling", requestIds: ["assistant-id"], role: "assistant" },
        requests: [{ input: "hello", kind: "tool", name: "echo", requestId: "request-id" }],
      }),
    ).toThrow("Assistant request IDs do not match");
  });
});
