import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateOperationId } from "./effect-definitions.js";
import { childSessionId, eventLogId, sessionId } from "./ids.js";
import type {
  EventRecord,
  MessageDelivery,
  PrototypeRun,
  PrototypeRuntime,
  PrototypeStartInput,
  WireValue,
} from "./types.js";

export function defineLoopPrototypeConformance(
  name: string,
  createRuntime: () => Promise<PrototypeRuntime>,
  options: { readonly automaticRetries: boolean },
): void {
  describe(`${name} loop prototype`, () => {
    let runtime: PrototypeRuntime;

    beforeAll(async () => {
      runtime = await createRuntime();
    });

    afterAll(async () => {
      await runtime.close();
    });

    it("completes a task from one terminal value", async () => {
      const run = await runtime.start(taskInput(runtime, "task", { kind: "echo" }, "hello"));
      const outcome = await run.result;

      expect(outcome).toEqual({ kind: "completed", output: "echo:hello" });
      expect(await runtime.callback(run.sessionId)).toEqual(outcome);
      const events = await run.events();
      expect(eventTypes(events)).toEqual([
        "model.generated",
        "assistant.reply",
        "session.terminal",
      ]);
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    });

    it("executes a local tool outside generation", async () => {
      const run = await runtime.start(taskInput(runtime, "tool", { kind: "tool" }, "tool-value"));

      expect(await run.result).toEqual({ kind: "completed", output: "tool-value" });
      const events = await run.events();
      expect(eventTypes(events)).toContain("tool.completed");
      const model = events.find((event) => eventType(event) === "model.generated");
      const tool = events.find((event) => eventType(event) === "tool.completed");
      expect(model?.operationId).not.toBe(tool?.operationId);
    });

    it("preserves prior events when a later tool effect exhausts", async () => {
      const run = await runtime.start(
        taskInput(runtime, "tool-failure", { kind: "tool-fail" }, "tool-value"),
      );
      const outcome = await run.result;
      const events = await run.events();

      expect(outcome.kind).toBe("failed");
      expect(await runtime.callback(run.sessionId)).toEqual(outcome);
      expect(eventTypes(events)).toEqual(["model.generated", "turn.failed", "session.terminal"]);
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    });

    it("waits for matching approval and preserves unrelated input for the next turn", async () => {
      const run = await runtime.start(
        conversationInput(runtime, "approval", { kind: "approval" }, "approved-value"),
      );
      void run.result.catch(() => {});
      const requested = await waitForEvent(run, "approval.requested");
      const requestId = stringPayloadField(requested, "requestId");

      await run.deliver({
        deliveryId: `${run.sessionId}:unrelated`,
        kind: "message",
        message: "not an approval",
      });
      await run.deliver({
        approved: true,
        deliveryId: `${run.sessionId}:approval`,
        kind: "approval",
        requestId,
      });

      await waitForEventCount(run, "assistant.reply", 1);
      const approvalRequests = await waitForEventCount(run, "approval.requested", 2);
      const nextRequest = approvalRequests[1];
      if (nextRequest === undefined) throw new Error("Second approval request disappeared.");
      await run.deliver({
        approved: true,
        deliveryId: `${run.sessionId}:next-approval`,
        kind: "approval",
        requestId: stringPayloadField(nextRequest, "requestId"),
      });
      const replies = await waitForEventCount(run, "assistant.reply", 2);

      expect(replies.map((event) => event.payload)).toEqual([
        { output: "approved-value", type: "assistant.reply" },
        { output: "not an approval", type: "assistant.reply" },
      ]);
      expect(await runtime.callback(run.sessionId)).toBeNull();
      await run.stop();
    });

    it("exposes child identity and preserves request-order results", async () => {
      const run = await runtime.start(
        taskInput(
          runtime,
          "children",
          {
            children: [
              { delayMs: 40, message: "first" },
              { delayMs: 0, message: "second" },
            ],
            kind: "children",
          },
          "delegate",
        ),
      );

      const starts = await waitForEventCount(run, "child.started", 2);
      expect(new Set(starts.map((event) => stringPayloadField(event, "childId"))).size).toBe(2);

      expect(await run.result).toEqual({
        kind: "completed",
        output: ["echo:first", "echo:second"],
      });
      const events = await run.events();
      const results = events.filter((event) => eventType(event) === "child.result");
      expect(starts).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(Math.max(...starts.map((event) => event.sequence))).toBeLessThan(
        Math.min(...results.map((event) => event.sequence)),
      );
      expect(results.map((event) => stringPayloadField(event, "requestId"))).toEqual(
        starts.map((event) => stringPayloadField(event, "requestId")),
      );
      expect(new Set(events.map((event) => event.logId))).toEqual(
        new Set([eventLogId(`${run.sessionId}:events`)]),
      );

      for (const start of starts) {
        const requestId = stringPayloadField(start, "requestId");
        const childId = childSessionId(run.sessionId, requestId);
        const childEvents = await runtime.events(eventLogId(`${childId}:events`));
        expect(childEvents.length).toBeGreaterThan(0);
        expect(new Set(childEvents.map((event) => event.logId))).toEqual(
          new Set([eventLogId(`${childId}:events`)]),
        );
      }
    });

    it("reuses a committed retry result without re-executing the effect", async () => {
      const run = await runtime.start(
        taskInput(runtime, "retry", { kind: "retry-once" }, "eventual"),
      );
      const generateId = generateOperationId({
        generationOrdinal: 0,
        sessionId: run.sessionId,
        turnOrdinal: 0,
      });

      if (options.automaticRetries) {
        const outcome = await run.result;
        expect(outcome).toEqual({ kind: "completed", output: "retry:eventual" });
        expect(await runtime.attemptCount(generateId)).toBe(2);
      } else {
        await expect(run.result).rejects.toThrow(
          "Injected failure after the visible generation effect.",
        );
        expect(await runtime.attemptCount(generateId)).toBe(1);
      }
      expect(await runtime.executionCount(generateId)).toBe(1);
      expect(await runtime.visibleEffectCount(generateId)).toBe(1);
    });

    it("keeps exhausted effect infrastructure outside domain outcomes", async () => {
      const run = await runtime.start(
        taskInput(runtime, "infrastructure-failure", { kind: "infrastructure-fail" }, "fail"),
      );

      await expect(run.result).rejects.toThrow();
      expect(await runtime.callback(run.sessionId)).toBeNull();
    });

    it("propagates one typed terminal failure", async () => {
      const run = await runtime.start(taskInput(runtime, "failure", { kind: "fail" }, "fail"));
      const outcome = await run.result;

      expect(outcome.kind).toBe("failed");
      expect(await runtime.callback(run.sessionId)).toEqual(outcome);
      const terminalEvent = (await run.events()).at(-1);
      expect(eventType(terminalEvent)).toBe("session.terminal");
      expect(terminalEvent?.payload).toEqual({ outcome: "failed", type: "session.terminal" });
    });

    it("parks a conversation and resumes it from public delivery", async () => {
      const run = await runtime.start(
        conversationInput(runtime, "conversation", { kind: "echo" }, "first"),
      );
      void run.result.catch(() => {});

      await waitForEventCount(run, "assistant.reply", 1);
      await run.deliver({
        deliveryId: `${run.sessionId}:follow-up`,
        kind: "message",
        message: "second",
      });
      const replies = await waitForEventCount(run, "assistant.reply", 2);

      expect(replies.map((event) => event.payload)).toEqual([
        { output: "echo:first", type: "assistant.reply" },
        { output: "echo:second", type: "assistant.reply" },
      ]);
      expect(await runtime.callback(run.sessionId)).toBeNull();
      await run.stop();
    });
  });
}

function taskInput(
  runtime: PrototypeRuntime,
  suffix: string,
  scenario: PrototypeStartInput["scenario"],
  message: string,
): PrototypeStartInput {
  return input(runtime, suffix, "task", scenario, message);
}

function conversationInput(
  runtime: PrototypeRuntime,
  suffix: string,
  scenario: PrototypeStartInput["scenario"],
  message: string,
): PrototypeStartInput {
  return input(runtime, suffix, "conversation", scenario, message);
}

function input(
  runtime: PrototypeRuntime,
  suffix: string,
  mode: "conversation" | "task",
  scenario: PrototypeStartInput["scenario"],
  message: string,
): PrototypeStartInput {
  const id = sessionId(`${runtime.kind}:${suffix}`);
  const initialDelivery: MessageDelivery = {
    deliveryId: `${id}:initial`,
    kind: "message",
    message,
  };
  return {
    continuationToken: `${id}:input`,
    initialDelivery,
    mode,
    scenario,
    sessionId: id,
  };
}

async function waitForEvent(run: PrototypeRun, type: string): Promise<EventRecord> {
  const events = await waitForEventCount(run, type, 1);
  const event = events[0];
  if (event === undefined) throw new Error(`Event "${type}" disappeared.`);
  return event;
}

async function waitForEventCount(
  run: PrototypeRun,
  type: string,
  count: number,
): Promise<readonly EventRecord[]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const matching = (await run.events()).filter((event) => eventType(event) === type);
    if (matching.length >= count) return matching;
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${String(count)} "${type}" events.`);
}

function eventTypes(events: readonly EventRecord[]): readonly (string | null)[] {
  return events.map(eventType);
}

function eventType(event: EventRecord | undefined): string | null {
  if (event === undefined) return null;
  if (!isWireRecord(event.payload)) return null;
  return typeof event.payload.type === "string" ? event.payload.type : null;
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
