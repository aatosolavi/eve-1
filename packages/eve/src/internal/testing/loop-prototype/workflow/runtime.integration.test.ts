import { describe, expect, it } from "vitest";

import { getRun, getWorld } from "#internal/workflow/runtime.js";

import { defineLoopPrototypeConformance } from "../conformance.js";
import { eventLogId, sessionId } from "../ids.js";
import type { EventRecord, WireValue } from "../types.js";
import { createWorkflowPrototypeRuntime, type WorkflowEventEnvelope } from "./runtime.js";

defineLoopPrototypeConformance("workflow", createWorkflowPrototypeRuntime, {
  automaticRetries: true,
});

describe("workflow loop prototype mechanics", () => {
  it("uses separate child runs, acknowledged turn checkpoints, and session-owned streams", async () => {
    const runtime = await createWorkflowPrototypeRuntime();
    const world = await getWorld();
    const runsBefore = new Set(
      (await world.runs.list({ resolveData: "none" })).data.map((run) => run.runId),
    );
    const rootSessionId = sessionId("workflow:mechanics");

    try {
      const run = await runtime.start({
        continuationToken: `${rootSessionId}:input`,
        initialDelivery: {
          deliveryId: `${rootSessionId}:initial`,
          kind: "message",
          message: "delegate",
        },
        mode: "task",
        scenario: {
          children: [
            { delayMs: 20, message: "first" },
            { delayMs: 0, message: "second" },
          ],
          kind: "children",
        },
        sessionId: rootSessionId,
      });

      await expect(run.result).resolves.toEqual({
        kind: "completed",
        output: ["echo:first", "echo:second"],
      });
      await expect(
        run.deliver({
          deliveryId: `${rootSessionId}:late`,
          kind: "message",
          message: "too late",
        }),
      ).rejects.toThrow("terminal");

      const rootEvents = await run.events();
      const rootReadable = getRun(run.backendRunId).getReadable<WorkflowEventEnvelope>();
      expect(await rootReadable.getTailIndex()).toBe(rootEvents.length - 1);
      const rootStream = await readEnvelopes(rootReadable, rootEvents.length);
      expect(rootStream.map((envelope) => envelope.event)).toEqual(rootEvents);

      const allRuns = await world.runs.list({ resolveData: "none" });
      const createdRuns = allRuns.data.filter((candidate) => !runsBefore.has(candidate.runId));
      await Promise.all(createdRuns.map(async (candidate) => waitForRunCompleted(candidate.runId)));
      const logicalChildIds = rootEvents
        .filter((event) => payloadType(event.payload) === "child.started")
        .map((event) => stringPayloadField(event, "childId"));

      expect(logicalChildIds).toHaveLength(2);
      const backendRunIds = createdRuns.map((candidate) => candidate.runId);
      for (const logicalChildId of logicalChildIds) {
        expect(backendRunIds).not.toContain(logicalChildId);
      }

      const turnRuns = createdRuns.filter((candidate) =>
        candidate.workflowName.includes("workflowTurn"),
      );
      const childSessionRuns = createdRuns.filter(
        (candidate) =>
          candidate.runId !== run.backendRunId &&
          candidate.workflowName.includes("workflowSession"),
      );

      expect(turnRuns.length).toBeGreaterThan(0);
      expect(childSessionRuns).toHaveLength(2);

      for (const turn of turnRuns) {
        expect(await getRun(turn.runId).getReadable().getTailIndex()).toBe(-1);
        const workflowEvents = await world.events.list({
          pagination: { limit: 1000 },
          resolveData: "none",
          runId: turn.runId,
        });
        const eventTypes = workflowEvents.data.map((event) => event.eventType);
        expect(eventTypes).toContain("hook_received");
        expect(eventTypes.indexOf("hook_received")).toBeLessThan(
          eventTypes.indexOf("run_completed"),
        );
      }

      for (const child of childSessionRuns) {
        const readable = getRun(child.runId).getReadable<WorkflowEventEnvelope>();
        const tailIndex = await readable.getTailIndex();
        const envelopes = await readEnvelopes(readable, tailIndex + 1);
        expect(envelopes.length).toBeGreaterThan(0);
        expect(new Set(envelopes.map((envelope) => envelope.event.logId))).not.toContain(
          eventLogId(`${rootSessionId}:events`),
        );
      }
    } finally {
      await runtime.close();
    }
  });
});

async function readEnvelopes(
  readable: ReadableStream<WorkflowEventEnvelope>,
  count: number,
): Promise<readonly WorkflowEventEnvelope[]> {
  const envelopes: WorkflowEventEnvelope[] = [];
  const reader = readable.getReader();

  try {
    for (let index = 0; index < count; index++) {
      const next = await reader.read();
      if (next.done) throw new Error(`Workflow stream closed after ${String(index)} envelopes.`);
      envelopes.push(next.value);
    }
    return envelopes;
  } finally {
    await reader.cancel();
  }
}

async function waitForRunCompleted(runId: string): Promise<void> {
  const run = getRun(runId);
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const status = await run.status;
    if (status === "completed") return;
    if (status === "cancelled" || status === "failed") {
      let failure: unknown;
      try {
        await run.returnValue;
      } catch (error) {
        failure = error;
      }
      throw new Error(`Workflow child run "${runId}" ended with status "${status}".`, {
        cause: failure,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Workflow child run "${runId}" did not complete.`);
}

function payloadType(payload: WireValue): string | null {
  if (!isWireRecord(payload)) return null;
  return typeof payload.type === "string" ? payload.type : null;
}

function stringPayloadField(event: EventRecord, field: string): string {
  if (!isWireRecord(event.payload) || typeof event.payload[field] !== "string") {
    throw new Error(`Event "${event.id}" has no string field "${field}".`);
  }

  return event.payload[field];
}

function isWireRecord(value: WireValue): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
