import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import { resolveToolCallInputObject } from "#harness/runtime-actions.js";

/**
 * Returns true when the AI SDK marked the tool call `invalid` (typically
 * because the model emitted unparsable JSON or targeted an unknown tool).
 *
 * Invalid calls have a raw-string or partial `input` payload that cannot
 * satisfy the runtime-action contract. The AI SDK synthesizes a tool-error
 * result for the next model step automatically; callers must skip invalid
 * calls when projecting to `RuntimeActionRequest` values or the harness
 * will throw on the JSON-object invariant.
 */
export function isInvalidToolCall(toolCall: TypedToolCall<ToolSet>): boolean {
  return toolCall.invalid === true;
}

/**
 * Classifies the tool calls whose input cannot satisfy the runtime-action
 * JSON-object contract.
 *
 * Two flavors join `callIds`:
 *
 * - AI-SDK-invalid calls ({@link isInvalidToolCall}). The AI SDK synthesizes
 *   their tool-error result itself, so they contribute no entry to
 *   `toolErrors`. Invalid calls are classified regardless of tool name: their
 *   raw-string input can never satisfy any input contract.
 * - Calls whose input parsed to a non-object (array, string, ...). eve
 *   synthesizes a tool-error for each of these (`toolErrors`) so the model
 *   learns why the call was dropped. `excludedToolNames` exempts tools from
 *   only this check — their well-formed input is validated elsewhere (e.g.
 *   `final_output` against the turn's output schema). Provider-executed calls
 *   are also exempt: their outcome lives in the assistant message, and a
 *   locally synthesized tool result would answer a server-side tool_use.
 *
 * Callers must exclude every id in `callIds` from runtime-action projection
 * (input requests, pending runtime actions) — projecting them would throw on
 * the JSON-object invariant.
 */
export function getInvalidToolCallInputs(input: {
  readonly excludedToolNames?: ReadonlySet<string>;
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
}): {
  readonly callIds: ReadonlySet<string>;
  readonly toolErrors: readonly TypedToolError<ToolSet>[];
} {
  const callIds = new Set<string>();
  const toolErrors: TypedToolError<ToolSet>[] = [];

  for (const toolCall of input.toolCalls) {
    if (isInvalidToolCall(toolCall)) {
      callIds.add(toolCall.toolCallId);
      continue;
    }

    if (toolCall.providerExecuted === true || input.excludedToolNames?.has(toolCall.toolName)) {
      continue;
    }

    try {
      resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      callIds.add(toolCall.toolCallId);
      toolErrors.push(createInvalidToolCallInputError({ error, toolCall }));
    }
  }

  return { callIds, toolErrors };
}

/**
 * Synthesizes the model-facing tool-error for a tool call whose input could
 * not be projected to the runtime-action contract.
 */
export function createInvalidToolCallInputError(input: {
  readonly error: unknown;
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> {
  const { toolCall } = input;

  const toolError: {
    dynamic?: true;
    error: unknown;
    input: unknown;
    providerExecuted?: true;
    providerMetadata?: TypedToolCall<ToolSet>["providerMetadata"];
    toolCallId: string;
    toolMetadata?: TypedToolCall<ToolSet>["toolMetadata"];
    toolName: string;
    type: "tool-error";
  } = {
    type: "tool-error",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
    error: input.error,
  };

  if (toolCall.dynamic === true) {
    toolError.dynamic = true;
  }
  if (toolCall.providerExecuted === true) {
    toolError.providerExecuted = true;
  }
  if (toolCall.providerMetadata !== undefined) {
    toolError.providerMetadata = toolCall.providerMetadata;
  }
  if (toolCall.toolMetadata !== undefined) {
    toolError.toolMetadata = toolCall.toolMetadata;
  }

  return toolError as TypedToolError<ToolSet>;
}
