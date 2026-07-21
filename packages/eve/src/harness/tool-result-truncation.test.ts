import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { truncateToolResults } from "#harness/tool-result-truncation.js";

function toolMessage(callId: string, value: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "json", value: { content: value } },
        toolCallId: callId,
        toolName: "grep",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

describe("truncateToolResults", () => {
  it("returns the input reference-equal when the decider declines every part", () => {
    const messages: ModelMessage[] = [{ content: "hi", role: "user" }, toolMessage("c1", "small")];

    expect(truncateToolResults(messages, "[note]", () => undefined)).toBe(messages);
  });

  it("rewrites decided parts to annotation-led truncated text and keeps others by identity", () => {
    const untouched = toolMessage("c1", "keep me");
    const oversized = toolMessage("c2", "x".repeat(5_000));
    const messages: ModelMessage[] = [untouched, oversized];

    const result = truncateToolResults(messages, "[cut]", (_part, serialized) =>
      serialized.length > 1_000 ? 100 : undefined,
    );

    expect(result).not.toBe(messages);
    expect(result[0]).toBe(untouched);
    const part = Array.isArray(result[1]?.content) ? result[1].content[0] : undefined;
    expect(part?.type).toBe("tool-result");
    const output = part?.type === "tool-result" ? part.output : undefined;
    const value =
      typeof output === "object" && output !== null && "value" in output
        ? String(output.value)
        : "";
    expect(value.startsWith("[cut]\n\n")).toBe(true);
    expect(value.length).toBeLessThan(200);
    expect(part?.type === "tool-result" ? part.toolCallId : undefined).toBe("c2");
  });

  it("leaves a part untouched when the decided budget already covers it", () => {
    const messages: ModelMessage[] = [toolMessage("c1", "tiny")];

    expect(truncateToolResults(messages, "[cut]", () => 10_000)).toBe(messages);
  });
});
