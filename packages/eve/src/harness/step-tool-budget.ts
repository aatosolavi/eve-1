import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";
import { truncateToolResults, type ToolResultPart } from "#harness/tool-result-truncation.js";

/**
 * Target number of tool-output-heavy model steps per compaction threshold.
 * The per-step tool-output budget is the threshold divided by this count, so
 * typical thresholds allocate roughly one-twentieth of the window per step.
 */
export const MIN_STEPS_BETWEEN_COMPACTIONS = 20;

// Keeps tool feedback useful when the proportional budget would be too small.
// It binds when the threshold is below 40k; below that point, readable tool
// results take priority over the twenty-step target.
const DEGENERATE_THRESHOLD_GUARD_TOKENS = 2_000;

// Truncated results keep at least this much content so the model can see what
// the tool returned and refine its next call instead of flying blind. With
// many results in one step, these floors (plus annotations) can leave the
// step somewhat above budget — the budget is a soft cadence target measured
// on the estimateTokens ruler, not a hard cap.
const MIN_KEPT_CHARS = 400;

function truncationAnnotation(toolCallId: string, nearStreamIndex: number | undefined): string {
  const reference =
    nearStreamIndex === undefined
      ? `read_tool_result("${toolCallId}")`
      : `read_tool_result("${toolCallId}", { nearStreamIndex: ${nearStreamIndex} })`;
  return `[Truncated by eve: this step's tool results exceeded the per-step context budget. Retrieve the full output with ${reference}, or use narrower queries.]`;
}

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
 * budget. Otherwise the largest results are truncated first, each keeping an
 * annotated content prefix that steers the model toward narrower queries.
 */
export function applyStepToolBudget(
  messages: readonly ModelMessage[],
  budgetTokens: number,
  lastResultStreamIndex?: number,
): readonly ModelMessage[] {
  const parts: { estimate: number; part: ToolResultPart }[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result") {
        parts.push({ estimate: estimateTokens(part.output), part });
      }
    }
  }

  let total = parts.reduce((sum, entry) => sum + entry.estimate, 0);
  if (total <= budgetTokens) {
    return messages;
  }

  const keptCharsByPart = new Map<ToolResultPart, number>();
  for (const entry of parts.toSorted((a, b) => b.estimate - a.estimate)) {
    if (total <= budgetTokens) {
      break;
    }

    const allowedTokens = Math.max(budgetTokens - (total - entry.estimate), 0);
    const keptChars = Math.max(Math.floor(allowedTokens * 4), MIN_KEPT_CHARS);
    keptCharsByPart.set(entry.part, keptChars);
    total -= entry.estimate - keptChars / 4;
  }

  return truncateToolResults(
    messages,
    (part) => truncationAnnotation(part.toolCallId, lastResultStreamIndex),
    (part) => keptCharsByPart.get(part),
  );
}
