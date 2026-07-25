import type { ToolSet, TypedToolResult } from "ai";
import { isAuthorizationSignal, isPendingAuthorizationToolOutput } from "#core/authorization.js";

/** Returns whether an inline tool result represents a pending authorization interrupt. */
export function isInlineAuthorizationToolResult(
  toolResult: TypedToolResult<ToolSet>,
  readStashedToolInterrupt: (callId: string) => unknown,
): boolean {
  if (isPendingAuthorizationToolOutput(toolResult.output)) {
    return true;
  }
  const stashed = readStashedToolInterrupt(toolResult.toolCallId);
  return stashed !== undefined && isAuthorizationSignal(stashed);
}
