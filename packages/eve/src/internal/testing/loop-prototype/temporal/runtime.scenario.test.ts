import { describe, expect, it } from "vitest";

import { defineLoopPrototypeConformance } from "../conformance.js";
import { childId, executionId, sessionId } from "../ids.js";
import type { EventRecord, WireValue } from "../types.js";
import {
  TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL,
  TEMPORAL_CHILD_UPDATE_SIGNAL,
  TEMPORAL_DELIVERY_SIGNAL,
} from "./contracts.js";
import { createTemporalPrototypeRuntime, type TemporalPrototypeRun } from "./runtime.js";

defineLoopPrototypeConformance("temporal", createTemporalPrototypeRuntime, {
  automaticRetries: true,
});

describe("Temporal loop mechanisms", () => {
  it("records real Signal, Activity, and Child Workflow history", async () => {
    const runtime = await createTemporalPrototypeRuntime();
    try {
      const id = sessionId("temporal:mechanisms");
      const run = await runtime.start({
        continuationToken: `${id}:input`,
        initialDelivery: {
          deliveryId: `${id}:initial`,
          kind: "message",
          message: "first",
        },
        mode: "conversation",
        scenario: { kind: "echo" },
        sessionId: id,
      });
      void run.result.catch(() => {});

      await waitForEventCount(run, "assistant.reply", 1);
      await run.deliver({
        deliveryId: `${id}:follow-up`,
        kind: "message",
        message: "second",
      });
      await waitForEventCount(run, "assistant.reply", 2);

      const rootHistory = await runtime.inspectHistory(run.workflowId);
      const firstTurnWorkflowId = childId(executionId(run.workflowId), 0, "turn");
      const firstTurnHistory = await runtime.inspectHistory(firstTurnWorkflowId);

      expect(rootHistory.childWorkflowsStarted).toBeGreaterThanOrEqual(2);
      expect(rootHistory.signalNames).toContain(TEMPORAL_DELIVERY_SIGNAL);
      expect(rootHistory.signalNames).toContain(TEMPORAL_CHILD_UPDATE_SIGNAL);
      expect(firstTurnHistory.activityTasksScheduled).toBeGreaterThan(0);
      expect(firstTurnHistory.signalNames).toContain(TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL);
      expect(firstTurnHistory.acknowledgementPrecededCompletion).toBe(true);

      const terminalId = sessionId("temporal:mechanisms-terminal");
      const terminalRun = await runtime.start({
        continuationToken: `${terminalId}:input`,
        initialDelivery: {
          deliveryId: `${terminalId}:initial`,
          kind: "message",
          message: "terminal",
        },
        mode: "task",
        scenario: { kind: "echo" },
        sessionId: terminalId,
      });
      await terminalRun.result;
      await expect(
        terminalRun.deliver({
          deliveryId: `${terminalId}:late`,
          kind: "message",
          message: "too late",
        }),
      ).rejects.toThrow(`Temporal run "${terminalRun.backendRunId}" is terminal.`);
    } finally {
      await runtime.close();
    }
  });
});

async function waitForEventCount(
  run: TemporalPrototypeRun,
  type: string,
  count: number,
): Promise<readonly EventRecord[]> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const matching = (await run.events()).filter((event) => eventType(event) === type);
    if (matching.length >= count) return matching;
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${String(count)} "${type}" events.`);
}

function eventType(event: EventRecord): string | null {
  if (!isWireRecord(event.payload)) return null;
  return typeof event.payload.type === "string" ? event.payload.type : null;
}

function isWireRecord(value: WireValue): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
