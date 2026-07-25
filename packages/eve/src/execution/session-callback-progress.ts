import { isProgressEventType, parseCallbackMetadata } from "#channel/session-callback.js";
import type { ContextReader } from "#context/key.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { postSessionCallback } from "#execution/session-callback-post.js";
import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const log = createLogger("execution.session-callback-progress");

/**
 * Forwards one non-terminal progress event to the caller's `:events`
 * ingestion URL as a `status: "working"` callback event (issue #1170).
 *
 * The best-effort progress lane: unlike authorization (a low-frequency
 * control event that rides the durable `resumeHook` path), progress is
 * high-frequency rendering-only telemetry, so it must never wake or
 * inflate the caller's main run. It is POSTed to `callback.notifyUrl`,
 * where the caller appends it to its stream wrapped as `subagent.event`.
 *
 * No-op for sessions without callback metadata, callers that advertised no
 * `notifyUrl`, and every non-progress event type. Delivery is best-effort:
 * a failed POST is logged and swallowed.
 */
export async function forwardSessionCallbackProgress(input: {
  readonly ctx: ContextReader;
  readonly event: HandleMessageStreamEvent;
}): Promise<void> {
  const { event } = input;
  if (!isProgressEventType(event.type)) {
    return;
  }

  const value = input.ctx.get(SessionCallbackKey);
  if (value === undefined) {
    return;
  }

  const parsed = parseCallbackMetadata(value);
  if (!parsed.ok || parsed.callback.notifyUrl === undefined) {
    return;
  }

  const sessionId = input.ctx.get(SessionIdKey) ?? "";
  try {
    await postSessionCallback({
      payload: {
        callId: parsed.callback.callId,
        event: { ...event, status: "working" },
        sessionId,
        subagentName: parsed.callback.subagentName,
      },
      url: parsed.callback.notifyUrl,
    });
  } catch (error) {
    log.warn("failed to post session callback progress", {
      error,
      eventType: event.type,
      sessionId,
    });
  }
}
