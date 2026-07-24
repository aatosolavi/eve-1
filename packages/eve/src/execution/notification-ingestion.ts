import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext } from "#context/serialize.js";
import { appendSessionStreamEvent } from "#execution/session-stream-append.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SubagentChildEventStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.notification-ingestion");

/**
 * PROTOTYPE (issue #1170): ingests one notification-class event for a
 * session, inline in the caller's already-running compute — no run, no
 * hook, no queue wake.
 *
 * Two effects, both best-effort:
 *
 * 1. Run the channel's existing adapter event handler against the curated
 *    child event — the same handler the local proxy step invokes today, so
 *    channels render with zero changes. The channel context is loaded from
 *    the session entry run's input (`world.runs.get`), read-only.
 * 2. Append the wrapped `subagent.event` to the session's durable stream,
 *    where every follower (TUI, web clients, evals) reads it.
 *
 * Failures log and drop: the lane's contract is fire-once, and a closed
 * stream or finished session means nobody is rendering.
 */
export async function ingestSessionNotification(
  sessionId: string,
  wrapped: SubagentChildEventStreamEvent,
): Promise<void> {
  try {
    const serializedContext = await loadEntrySerializedContext(sessionId);
    if (serializedContext !== undefined) {
      const ctx = await deserializeContext(serializedContext);
      const adapter = ctx.get(ChannelKey);
      if (adapter !== undefined) {
        const adapterCtx = buildAdapterContext(adapter, ctx);
        await callAdapterEventHandler(adapter, wrapped.data.event, adapterCtx);
      }
    }
  } catch (error) {
    logError(log, "notification channel render failed; continuing to stream append", error, {
      sessionId,
    });
  }

  await appendSessionStreamEvent(sessionId, wrapped);
}

/**
 * Loads the session entry run's `serializedContext` from its recorded
 * input. The entry is started with `[{ input, limits, serializedContext }]`,
 * so the channel context is addressable by session id without any
 * dedicated persistence.
 */
async function loadEntrySerializedContext(
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const world = await getWorld();
  const run = await world.runs.get(sessionId, { resolveData: "all" });
  const args = (run as { input?: unknown }).input;
  const first = Array.isArray(args) ? args[0] : args;
  if (first === null || typeof first !== "object") return undefined;
  const serialized = (first as { serializedContext?: unknown }).serializedContext;
  if (serialized === null || typeof serialized !== "object") return undefined;
  return serialized as Record<string, unknown>;
}
