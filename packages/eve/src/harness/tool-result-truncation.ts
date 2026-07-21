import type { ModelMessage } from "ai";

type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

/** Tool-result content part of a `role: "tool"` message. */
export type ToolResultPart = Extract<ModelMessageContentPart, { type: "tool-result" }>;

/** Canonical serialization used for measuring and truncating tool outputs. */
export function serializeToolResultOutput(part: ToolResultPart): string {
  return JSON.stringify(part.output) ?? "";
}

/**
 * Rewrites tool-result outputs to an annotated truncated text form.
 *
 * `decideKeptChars` inspects each tool-result part (with its canonical
 * serialization) and returns how many characters to keep, or `undefined` to
 * leave the part untouched. Messages and untouched parts keep their identity,
 * and the input array is returned reference-equal when nothing was truncated.
 * Results are never dropped, so every tool_use keeps its paired tool_result.
 *
 * The annotation leads the value so the model reads the caveat before the
 * content and so it survives prefix-capped renderings.
 */
export function truncateToolResults(
  messages: readonly ModelMessage[],
  annotation: string,
  decideKeptChars: (part: ToolResultPart, serialized: string) => number | undefined,
): readonly ModelMessage[] {
  let anyTruncated = false;

  const rewritten = messages.map((message) => {
    if (message.role !== "tool" || typeof message.content === "string") {
      return message;
    }

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }

      const serialized = serializeToolResultOutput(part);
      const keptChars = decideKeptChars(part, serialized);
      if (keptChars === undefined || serialized.length <= keptChars) {
        return part;
      }

      changed = true;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${annotation}\n\n${serialized.slice(0, keptChars)}`,
        },
      };
    });

    if (!changed) {
      return message;
    }
    anyTruncated = true;
    return { ...message, content };
  });

  return anyTruncated ? rewritten : messages;
}
