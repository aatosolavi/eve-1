import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";

/**
 * Target minimum number of model steps between compactions. The per-step
 * tool-output budget is the compaction threshold divided by this count, so a
 * step's combined tool results can never fill the context in fewer steps.
 */
export const MIN_STEPS_BETWEEN_COMPACTIONS = 20;

// Only guards degenerate thresholds (tests force compaction with thresholds in
// the hundreds); it binds when threshold < 40k and never for a real context
// window. There is deliberately no larger floor: at production thresholds the
// step cadence wins over keeping a single maximum-size tool result whole.
const DEGENERATE_THRESHOLD_GUARD_TOKENS = 2_000;

// Truncated results keep at least this much content so the model can see what
// the tool returned and refine its next call instead of flying blind.
const MIN_KEPT_CHARS = 400;

const TRUNCATION_ANNOTATION =
  "[Truncated by eve: this step's tool results exceeded the per-step context budget. Use narrower queries, smaller ranges, or offsets.]";

/** Per-step tool-output budget (tokens) for a given compaction threshold. */
export function resolveStepToolBudget(threshold: number): number {
  return Math.max(
    Math.floor(threshold / MIN_STEPS_BETWEEN_COMPACTIONS),
    DEGENERATE_THRESHOLD_GUARD_TOKENS,
  );
}

/**
 * Bounds the combined size of one step's tool results to `budgetTokens`.
 *
 * Returns the input array unchanged (reference-equal) when the step is within
 * budget. Otherwise the largest results are truncated first, each replaced by
 * a text output carrying a content prefix plus an annotation steering the
 * model toward narrower queries. Results are never dropped, so every tool_use
 * keeps its paired tool_result.
 */
export function applyStepToolBudget(
  messages: readonly ModelMessage[],
  budgetTokens: number,
): readonly ModelMessage[] {
  const parts: { estimate: number; messageIndex: number; partIndex: number }[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool" || typeof message.content === "string") {
      continue;
    }
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type === "tool-result") {
        parts.push({ estimate: estimateTokens(part.output), messageIndex, partIndex });
      }
    }
  }

  let total = parts.reduce((sum, part) => sum + part.estimate, 0);
  if (total <= budgetTokens) {
    return messages;
  }

  const truncations = new Map<string, number>();
  for (const part of parts.toSorted((a, b) => b.estimate - a.estimate)) {
    if (total <= budgetTokens) {
      break;
    }

    const allowedTokens = Math.max(budgetTokens - (total - part.estimate), 0);
    const keptChars = Math.max(Math.floor(allowedTokens * 4), MIN_KEPT_CHARS);
    truncations.set(`${part.messageIndex}:${part.partIndex}`, keptChars);
    total -= part.estimate - keptChars / 4;
  }

  return messages.map((message, messageIndex) => {
    if (message.role !== "tool" || typeof message.content === "string") {
      return message;
    }

    let changed = false;
    const content = message.content.map((part, partIndex) => {
      const keptChars = truncations.get(`${messageIndex}:${partIndex}`);
      if (keptChars === undefined || part.type !== "tool-result") {
        return part;
      }

      changed = true;
      const serialized =
        typeof part.output === "object" && part.output !== null
          ? JSON.stringify(part.output)
          : String(part.output);
      // Annotation leads so the model reads the caveat before the content and
      // so it survives prefix-capped renderings (compaction trail lines).
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${TRUNCATION_ANNOTATION}\n\n${serialized.slice(0, keptChars)}`,
        },
      };
    });

    return changed ? { ...message, content } : message;
  }) as readonly ModelMessage[];
}
