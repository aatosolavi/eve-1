import { describe, expect, it } from "vitest";

import {
  createSessionStartedEvent,
  createSessionWaitingEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";
import { withTerminalFraming } from "#execution/terminal-framing.js";

function streamOf(
  events: readonly HandleMessageStreamEvent[],
): ReadableStream<HandleMessageStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<HandleMessageStreamEvent>,
): Promise<HandleMessageStreamEvent[]> {
  const events: HandleMessageStreamEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(value);
  }
  return events;
}

const textEvent: HandleMessageStreamEvent = createSessionStartedEvent();
const waitingEvent: HandleMessageStreamEvent = createSessionWaitingEvent("tok");

describe("withTerminalFraming", () => {
  it("passes a boundary-terminated stream through unchanged", async () => {
    const framed = withTerminalFraming(streamOf([textEvent, waitingEvent]), {
      getRunStatus: () => Promise.reject(new Error("must not be called")),
      sessionId: "wrun_1",
    });

    await expect(collect(framed)).resolves.toEqual([textEvent, waitingEvent]);
  });

  it("synthesizes session.failed when a cancelled run's log ends without a boundary", async () => {
    const framed = withTerminalFraming(streamOf([textEvent]), {
      getRunStatus: () => Promise.resolve("cancelled"),
      sessionId: "wrun_1",
    });

    const events = await collect(framed);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(textEvent);
    expect(events[1]).toMatchObject({
      data: { code: "RUN_CANCELLED", sessionId: "wrun_1" },
      type: "session.failed",
    });
  });

  it("synthesizes session.failed when a failed run's log ends without a boundary", async () => {
    const framed = withTerminalFraming(streamOf([textEvent]), {
      getRunStatus: () => Promise.resolve("failed"),
      sessionId: "wrun_1",
    });

    const events = await collect(framed);
    expect(events.at(-1)).toMatchObject({
      data: { code: "WORKFLOW_RUN_FAILED", sessionId: "wrun_1" },
      type: "session.failed",
    });
  });

  it("synthesizes session.completed for an empty slice of a completed run", async () => {
    // A client reconnecting at the tail of a completed run reads zero events;
    // the synthesized boundary is what stops it from reconnecting forever.
    const framed = withTerminalFraming(streamOf([]), {
      getRunStatus: () => Promise.resolve("completed"),
      sessionId: "wrun_1",
    });

    const events = await collect(framed);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.completed" });
  });

  it("synthesizes nothing while the run is still live", async () => {
    const framed = withTerminalFraming(streamOf([textEvent]), {
      getRunStatus: () => Promise.resolve("running"),
      sessionId: "wrun_1",
    });

    await expect(collect(framed)).resolves.toEqual([textEvent]);
  });

  it("ends cleanly when the status probe fails", async () => {
    const framed = withTerminalFraming(streamOf([textEvent]), {
      getRunStatus: () => Promise.reject(new Error("world unavailable")),
      sessionId: "wrun_1",
    });

    await expect(collect(framed)).resolves.toEqual([textEvent]);
  });

  it("stamps the synthesized event with durable timing metadata", async () => {
    const framed = withTerminalFraming(streamOf([]), {
      getRunStatus: () => Promise.resolve("cancelled"),
      sessionId: "wrun_1",
    });

    const [event] = await collect(framed);
    expect((event as { meta?: { at?: string } }).meta?.at).toBeTypeOf("string");
  });

  it("forwards cancellation to the source stream", async () => {
    let sourceCancelled = false;
    const source = new ReadableStream<HandleMessageStreamEvent>({
      cancel() {
        sourceCancelled = true;
      },
    });

    const framed = withTerminalFraming(source, {
      getRunStatus: () => Promise.resolve("running"),
      sessionId: "wrun_1",
    });

    await framed.cancel();
    // pipeThrough propagates cancellation to its source asynchronously.
    await expect.poll(() => sourceCancelled).toBe(true);
  });
});
