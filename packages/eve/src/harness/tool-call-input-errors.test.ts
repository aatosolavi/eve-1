import type { ToolSet, TypedToolCall } from "ai";
import { describe, expect, it } from "vitest";

import { getInvalidToolCallInputs, isInvalidToolCall } from "#harness/tool-call-input-errors.js";

function toolCall(overrides: Record<string, unknown>): TypedToolCall<ToolSet> {
  return {
    input: {},
    toolCallId: "call-1",
    toolName: "add",
    type: "tool-call",
    ...overrides,
  } as TypedToolCall<ToolSet>;
}

describe("isInvalidToolCall", () => {
  it("returns true only for AI-SDK-invalid calls", () => {
    expect(isInvalidToolCall(toolCall({ invalid: true }))).toBe(true);
    expect(isInvalidToolCall(toolCall({}))).toBe(false);
  });
});

describe("getInvalidToolCallInputs", () => {
  it("returns nothing for calls with object input", () => {
    const result = getInvalidToolCallInputs({
      toolCalls: [toolCall({ input: { a: 1 } })],
    });

    expect([...result.callIds]).toEqual([]);
    expect(result.toolErrors).toEqual([]);
  });

  it("collects AI-SDK-invalid calls without synthesizing a tool error", () => {
    // The AI SDK marks the call invalid (unparsable argument JSON or unknown
    // tool) and synthesizes its tool-error result itself, so the call is only
    // excluded from projection.
    const result = getInvalidToolCallInputs({
      toolCalls: [toolCall({ input: '{"prompt": "Continue?', invalid: true })],
    });

    expect([...result.callIds]).toEqual(["call-1"]);
    expect(result.toolErrors).toEqual([]);
  });

  it("synthesizes a tool error for input that parses to a non-object", () => {
    const result = getInvalidToolCallInputs({
      toolCalls: [toolCall({ input: [1, 2] })],
    });

    expect([...result.callIds]).toEqual(["call-1"]);
    expect(result.toolErrors).toEqual([
      expect.objectContaining({
        error: expect.any(TypeError),
        input: [1, 2],
        toolCallId: "call-1",
        toolName: "add",
        type: "tool-error",
      }),
    ]);
  });

  it("exempts excluded tool names from the non-object contract check", () => {
    const result = getInvalidToolCallInputs({
      excludedToolNames: new Set(["final_output"]),
      toolCalls: [toolCall({ input: [1, 2], toolName: "final_output" })],
    });

    expect([...result.callIds]).toEqual([]);
    expect(result.toolErrors).toEqual([]);
  });

  it("classifies AI-SDK-invalid calls even for excluded tool names", () => {
    // A name exclusion only exempts the non-object contract check; an
    // unparsable-JSON call can never satisfy any input contract.
    const result = getInvalidToolCallInputs({
      excludedToolNames: new Set(["final_output"]),
      toolCalls: [toolCall({ input: '{"answer": "hel', invalid: true, toolName: "final_output" })],
    });

    expect([...result.callIds]).toEqual(["call-1"]);
    expect(result.toolErrors).toEqual([]);
  });

  it("does not synthesize tool errors for provider-executed calls", () => {
    // Provider-executed outcomes live in the assistant message; a locally
    // synthesized tool result would answer a server-side tool_use.
    const result = getInvalidToolCallInputs({
      toolCalls: [toolCall({ input: "not an object", providerExecuted: true })],
    });

    expect([...result.callIds]).toEqual([]);
    expect(result.toolErrors).toEqual([]);
  });
});
