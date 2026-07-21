import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  applyStepToolBudget,
  MIN_STEPS_BETWEEN_COMPACTIONS,
  resolveStepToolBudget,
} from "#harness/step-tool-budget.js";
import { estimateTokens } from "#harness/token-estimate.js";

function toolResultMessage(callId: string, value: string): ModelMessage {
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

describe("resolveStepToolBudget", () => {
  it("derives the budget from the compaction threshold", () => {
    expect(resolveStepToolBudget(180_000)).toBe(
      Math.floor(180_000 / MIN_STEPS_BETWEEN_COMPACTIONS),
    );
  });

  it("guards degenerate thresholds", () => {
    // Deterministic test agents force compaction with thresholds in the
    // hundreds; the guard keeps their small tool results untouched.
    expect(resolveStepToolBudget(640)).toBe(2_000);
  });
});

describe("applyStepToolBudget", () => {
  it("returns the input reference-equal when the step is within budget", () => {
    const messages: ModelMessage[] = [
      { content: "run it", role: "user" },
      toolResultMessage("call-1", "small result"),
    ];

    expect(applyStepToolBudget(messages, 2_000)).toBe(messages);
  });

  it("truncates the largest results first and annotates them", () => {
    const large = toolResultMessage("call-1", "L".repeat(40_000));
    const small = toolResultMessage("call-2", "s".repeat(1_000));
    const messages: ModelMessage[] = [large, small];

    const result = applyStepToolBudget(messages, 2_000);

    expect(result).not.toBe(messages);
    const [first, second] = result;
    const firstPart = Array.isArray(first?.content) ? first.content[0] : undefined;
    expect(firstPart?.type).toBe("tool-result");
    expect(JSON.stringify(firstPart)).toContain("Truncated by eve");
    // The small result was untouched — same reference.
    expect(second).toBe(small);
  });

  it("keeps every tool_result paired with its call after truncation", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("call-1", "a".repeat(30_000)),
      toolResultMessage("call-2", "b".repeat(30_000)),
      toolResultMessage("call-3", "c".repeat(30_000)),
    ];

    const result = applyStepToolBudget(messages, 3_000);

    const ids: string[] = [];
    for (const message of result) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-result") ids.push(part.toolCallId);
        }
      }
    }
    expect(ids).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("brings a multi-result step down to roughly the budget", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("call-1", "a".repeat(50_000)),
      toolResultMessage("call-2", "b".repeat(50_000)),
      toolResultMessage("call-3", "c".repeat(50_000)),
    ];
    const budget = 9_000;

    const result = applyStepToolBudget(messages, budget);

    // Within 2x of the budget: the estimate is a heuristic and each truncated
    // result keeps a minimum readable prefix plus the annotation.
    expect(estimateTokens(result)).toBeLessThan(budget * 2);
    expect(estimateTokens(result)).toBeLessThan(estimateTokens(messages) / 2);
  });

  it("keeps a readable prefix even when the budget is dwarfed", () => {
    const messages: ModelMessage[] = [toolResultMessage("call-1", "z".repeat(100_000))];

    const result = applyStepToolBudget(messages, 2_000);

    const part = Array.isArray(result[0]?.content) ? result[0].content[0] : undefined;
    const output = part?.type === "tool-result" ? part.output : undefined;
    const value =
      typeof output === "object" && output !== null && "value" in output
        ? String(output.value)
        : "";
    expect(value.length).toBeGreaterThanOrEqual(400);
    expect(value).toContain("zzz");
    expect(value).toContain("Truncated by eve");
  });
});
