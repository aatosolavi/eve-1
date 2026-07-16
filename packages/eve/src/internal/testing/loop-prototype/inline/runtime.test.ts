import { describe, expect, it } from "vitest";

import { defineLoopPrototypeConformance } from "../conformance.js";
import { eventLogId, sessionId } from "../ids.js";
import type { EventRecord, PrototypeRun, WireValue } from "../types.js";
import {
  createInlinePrototypeRuntime,
  InlinePrototypeRuntime,
  InlineRunStoppedError,
} from "./runtime.js";

defineLoopPrototypeConformance("inline", createInlinePrototypeRuntime, {
  automaticRetries: false,
});

describe("inline loop prototype boundaries", () => {
  it("hard-stops a parked run", async () => {
    const runtime = new InlinePrototypeRuntime();
    try {
      const run = await runtime.start({
        continuationToken: "parked:input",
        initialDelivery: {
          deliveryId: "parked:initial",
          kind: "message",
          message: "first",
        },
        mode: "conversation",
        scenario: { kind: "echo" },
        sessionId: sessionId("parked"),
      });
      const stoppedResult = run.result.catch((error: unknown) => error);
      await waitForEvent(run, "assistant.reply");

      await run.stop();

      expect(await stoppedResult).toBeInstanceOf(InlineRunStoppedError);
      await expect(
        run.deliver({
          deliveryId: "parked:late",
          kind: "message",
          message: "too late",
        }),
      ).rejects.toBeInstanceOf(InlineRunStoppedError);
    } finally {
      await runtime.close();
    }
  });

  it("loses parked checkpoints and events with the runtime instance", async () => {
    const id = sessionId("volatile");
    const logId = eventLogId("volatile:events");
    const first = new InlinePrototypeRuntime();
    const run = await first.start({
      continuationToken: "volatile:input",
      initialDelivery: {
        deliveryId: "volatile:initial",
        kind: "message",
        message: "remember me",
      },
      mode: "conversation",
      scenario: { kind: "echo" },
      sessionId: id,
    });
    void run.result.catch(() => {});
    await waitForEvent(run, "assistant.reply");
    expect(await first.events(logId)).not.toHaveLength(0);
    await first.close();

    const replacement = new InlinePrototypeRuntime();
    try {
      expect(await replacement.events(logId)).toEqual([]);
      expect(await replacement.callback(id)).toBeNull();
    } finally {
      await replacement.close();
    }
  });

  it("rejects delivery after a task reaches terminal state", async () => {
    const runtime = new InlinePrototypeRuntime();
    try {
      const run = await runtime.start({
        continuationToken: "terminal:input",
        initialDelivery: {
          deliveryId: "terminal:initial",
          kind: "message",
          message: "done",
        },
        mode: "task",
        scenario: { kind: "echo" },
        sessionId: sessionId("terminal"),
      });
      await run.result;

      await expect(
        run.deliver({ deliveryId: "terminal:late", kind: "message", message: "late" }),
      ).rejects.toThrow("terminal");
    } finally {
      await runtime.close();
    }
  });
});

async function waitForEvent(run: PrototypeRun, type: string): Promise<EventRecord> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const event = (await run.events()).find(
      (candidate) => isWireRecord(candidate.payload) && candidate.payload.type === type,
    );
    if (event !== undefined) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for event "${type}".`);
}

function isWireRecord(value: WireValue): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
