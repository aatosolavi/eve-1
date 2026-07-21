import { getRun } from "#internal/workflow/runtime.js";
import { z } from "#compiled/zod/index.js";

import { getContext } from "#context/accessors.js";
import { SessionIdKey } from "#context/keys.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

export const EXPAND_TOOL_RESULT_INPUT_SCHEMA = z.strictObject({
  toolCallId: z
    .string()
    .min(1)
    .describe("The tool call id named in a [Truncated by eve: …] annotation."),
  offsetChars: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset into the serialized output. Defaults to 0."),
  limitChars: z
    .number()
    .int()
    .min(1)
    .max(30_000)
    .optional()
    .describe("Maximum characters to return. Defaults to 6000."),
});

export const EXPAND_TOOL_RESULT_OUTPUT_SCHEMA = z.strictObject({
  found: z.boolean(),
  content: z.string().optional(),
  moreAfter: z.boolean().optional(),
  offsetChars: z.number().optional(),
  reason: z.string().optional(),
  toolName: z.string().optional(),
  totalChars: z.number().optional(),
});

const DEFAULT_LIMIT_CHARS = 6_000;

// Backward scan windows over the session stream, in chunks (one chunk is one
// event). Truncated results the model asks about are usually recent; the
// final pass covers the whole stream for results capped by compaction long
// after they ran.
const SCAN_WINDOWS = [512, 4_096, Number.POSITIVE_INFINITY];

// The stream tails while the session is live, so a reader that has consumed
// everything stored simply waits. Reads stop at the recorded tail index; the
// idle race is a backstop so a stalled read can never hang the turn.
const READ_IDLE_TIMEOUT_MS = 2_000;

interface StoredActionResult {
  readonly output: unknown;
  readonly toolName?: string;
}

/**
 * Retrieves the full output of a tool result that eve truncated, by reading
 * the session's own durable event stream. Full outputs are always emitted to
 * the stream before truncation touches history, so nothing needs to be
 * stored separately.
 */
async function expandToolResult(input: unknown): Promise<unknown> {
  const { limitChars, offsetChars, toolCallId } = EXPAND_TOOL_RESULT_INPUT_SCHEMA.parse(input);

  const sessionRunId = getContext(SessionIdKey);
  if (sessionRunId === undefined) {
    return miss("This session does not expose a durable event stream.");
  }

  let stored: StoredActionResult | undefined;
  try {
    stored = await findActionResult(sessionRunId, toolCallId);
  } catch (error) {
    return miss(
      `Reading the session stream failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stored === undefined) {
    return miss(
      `No recorded result for tool call "${toolCallId}". Re-run the tool if the output is still needed.`,
    );
  }

  const serialized = JSON.stringify(stored.output) ?? "";
  const offset = Math.min(offsetChars ?? 0, serialized.length);
  const limit = limitChars ?? DEFAULT_LIMIT_CHARS;
  const content = serialized.slice(offset, offset + limit);

  return {
    content,
    found: true,
    moreAfter: offset + content.length < serialized.length,
    offsetChars: offset,
    toolName: stored.toolName,
    totalChars: serialized.length,
  };
}

function miss(reason: string): { found: false; reason: string } {
  return { found: false, reason };
}

/**
 * Scans the session run's `"user"` stream backwards in widening windows for
 * the `action.result` event carrying `toolCallId`. One stored chunk is one
 * NDJSON event, so negative start indexes land on clean event boundaries.
 */
async function findActionResult(
  sessionRunId: string,
  toolCallId: string,
): Promise<StoredActionResult | undefined> {
  for (const window of SCAN_WINDOWS) {
    const startIndex = Number.isFinite(window) ? -window : 0;
    const readable = getRun(sessionRunId).getReadable<string | Uint8Array>({ startIndex });
    const tailIndex = await readable.getTailIndex();
    const chunksToRead = Number.isFinite(window) ? Math.min(window, tailIndex) : tailIndex;

    const found = await scanChunks(readable, chunksToRead, toolCallId);
    if (found !== undefined) {
      return found;
    }
    if (!Number.isFinite(window) || tailIndex <= window) {
      return undefined;
    }
  }

  return undefined;
}

async function scanChunks(
  readable: ReadableStream<string | Uint8Array>,
  chunksToRead: number,
  toolCallId: string,
): Promise<StoredActionResult | undefined> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let consumed = 0;
  let found: StoredActionResult | undefined;

  try {
    while (consumed < chunksToRead && found === undefined) {
      const winner = await Promise.race([
        reader.read(),
        new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), READ_IDLE_TIMEOUT_MS)),
      ]);
      if (winner === "idle" || winner.done) {
        break;
      }

      buffered +=
        typeof winner.value === "string"
          ? winner.value
          : decoder.decode(winner.value, { stream: true });

      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        consumed += 1;
        found ??= matchActionResult(line, toolCallId);
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return found;
}

function matchActionResult(line: string, toolCallId: string): StoredActionResult | undefined {
  if (!line.includes(toolCallId) || !line.includes('"action.result"')) {
    return undefined;
  }

  try {
    const event = JSON.parse(line) as {
      type?: string;
      data?: { result?: { callId?: string; output?: unknown; toolName?: string } };
    };
    if (event.type !== "action.result" || event.data?.result?.callId !== toolCallId) {
      return undefined;
    }
    return { output: event.data.result.output, toolName: event.data.result.toolName };
  } catch {
    return undefined;
  }
}

export const EXPAND_TOOL_RESULT_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Retrieve the full output of a previous tool call that eve truncated.",
    'Only useful when a tool result carries a "[Truncated by eve: …]" annotation naming a tool call id.',
    "Returns a page of the serialized output; pass offsetChars to continue where a page ended.",
  ].join("\n"),
  execute: expandToolResult,
  inputSchema: EXPAND_TOOL_RESULT_INPUT_SCHEMA,
  logicalPath: "eve:framework/expand-tool-result",
  name: "expand_tool_result",
  outputSchema: EXPAND_TOOL_RESULT_OUTPUT_SCHEMA,
  sourceId: "eve:expand-tool-result-tool",
  sourceKind: "module",
};
