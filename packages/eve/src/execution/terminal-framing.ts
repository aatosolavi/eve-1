import {
  createSessionCompletedEvent,
  createSessionFailedEvent,
  isCurrentTurnBoundaryEvent,
  timestampHandleMessageStreamEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

/**
 * Guarantees a served session event stream ends in a turn-boundary event.
 *
 * The durable event log reaches EOF only once its workflow run settles, and
 * every eve-owned settle path already writes a boundary event
 * (`session.waiting` / `session.completed` / `session.failed`) as its last
 * entry. The log can still end without one when the run is terminated from
 * outside eve's code — a platform-level cancellation, run expiry, or a crash
 * that also killed the failure emitter. In that case a boundary event is
 * synthesized from the run's terminal status, so consumers can rely on a
 * single rule: follow the stream until a boundary event.
 *
 * A stream that ends while the run is still live (which the durable log
 * contract does not produce, but a defect might) is passed through untouched —
 * synthesizing a terminal event for a live run would falsely end the session.
 */
export function withTerminalFraming(
  events: ReadableStream<HandleMessageStreamEvent>,
  input: {
    /** Resolves the run's current status, e.g. `getRun(sessionId).status`. */
    readonly getRunStatus: () => Promise<string>;
    readonly sessionId: string;
  },
): ReadableStream<HandleMessageStreamEvent> {
  let lastEvent: HandleMessageStreamEvent | undefined;

  return events.pipeThrough(
    new TransformStream<HandleMessageStreamEvent, HandleMessageStreamEvent>({
      transform(event, controller) {
        lastEvent = event;
        controller.enqueue(event);
      },
      async flush(controller) {
        if (lastEvent !== undefined && isCurrentTurnBoundaryEvent(lastEvent)) {
          return;
        }

        const synthesized = await synthesizeTerminalBoundaryEvent(input);
        if (synthesized !== undefined) {
          controller.enqueue(timestampHandleMessageStreamEvent(synthesized));
        }
      },
    }),
  );
}

async function synthesizeTerminalBoundaryEvent(input: {
  readonly getRunStatus: () => Promise<string>;
  readonly sessionId: string;
}): Promise<HandleMessageStreamEvent | undefined> {
  let status: string;
  try {
    status = await input.getRunStatus();
  } catch {
    // The status probe failing must not poison the events already served;
    // the stream simply ends and the client's reconnect asks again.
    return undefined;
  }

  switch (status) {
    case "completed":
      return createSessionCompletedEvent();
    case "failed":
      return createSessionFailedEvent({
        code: "WORKFLOW_RUN_FAILED",
        message: "The session's workflow run failed before a terminal session event was recorded.",
        sessionId: input.sessionId,
      });
    case "cancelled":
      return createSessionFailedEvent({
        code: "RUN_CANCELLED",
        message: "The session's workflow run was cancelled.",
        sessionId: input.sessionId,
      });
    default:
      return undefined;
  }
}
