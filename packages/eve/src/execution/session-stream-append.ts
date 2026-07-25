import { getWorld } from "#internal/workflow/runtime.js";
import {
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";

/**
 * PROTOTYPE (issue #1170): the engine's default run-stream name, derived
 * from the run id. Naming contract of the vendored `@workflow/core`
 * (`strm_<id>_user` for the default namespace); if the engine ever exposes
 * a public name resolver or accepts name-less default writes, use that
 * instead.
 */
export function sessionStreamName(sessionId: string): string {
  return `${sessionId.replace("wrun_", "strm_")}_user`;
}

/**
 * PROTOTYPE (issue #1170): appends one event to a session's durable stream
 * from plain runtime code — the producer side of the event-consumer lane.
 * Throws on a closed or missing stream; callers decide whether that is
 * best-effort (notifications: log and drop) or an error.
 */
export async function appendSessionStreamEvent(
  sessionId: string,
  event: HandleMessageStreamEvent,
): Promise<void> {
  const world = await getWorld();
  await world.streams.write(
    sessionId,
    sessionStreamName(sessionId),
    encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event)),
  );
}
