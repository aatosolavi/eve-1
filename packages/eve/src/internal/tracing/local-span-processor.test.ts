import { describe, expect, it } from "vitest";

import type { ReadableSpan } from "#compiled/@opentelemetry/sdk-trace-base/index.js";
import type { CapturedAttributeValue, CapturedSpan } from "#internal/tracing/captured-span.js";
import { LocalSpanProcessor, type TracePersister } from "#internal/tracing/local-span-processor.js";
import { TraceRingBuffer } from "#internal/tracing/ring-buffer.js";

interface FakeSpanInit {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId?: string;
  attributes?: Record<string, CapturedAttributeValue>;
}

function fakeSpan(init: FakeSpanInit): ReadableSpan {
  const traceId = init.traceId ?? "trace-1";
  return {
    name: init.name,
    kind: 0,
    spanContext: () => ({ traceId, spanId: init.spanId, traceFlags: 1 }),
    parentSpanContext:
      init.parentSpanId === undefined
        ? undefined
        : { traceId, spanId: init.parentSpanId, traceFlags: 1 },
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: 1 },
    attributes: init.attributes ?? {},
    events: [],
    duration: [1, 0],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as ReadableSpan;
}

class FakePersister implements TracePersister {
  readonly writes: { runId: string; spans: CapturedSpan[] }[] = [];
  async write(runId: string, spans: readonly CapturedSpan[]): Promise<void> {
    this.writes.push({ runId, spans: [...spans] });
  }
}

function makeProcessor() {
  const store = new FakePersister();
  const processor = new LocalSpanProcessor({
    ringBuffer: new TraceRingBuffer({ maxTraces: 10 }),
    store,
    payload: { recordInputs: true, recordOutputs: true },
  });
  return { store, processor };
}

describe("LocalSpanProcessor", () => {
  it("ignores workflow-plumbing traces that contain no turn span", async () => {
    const { store, processor } = makeProcessor();
    processor.onEnd(
      fakeSpan({ name: "workflow.stream.flush", spanId: "w-child", parentSpanId: "w-root" }),
    );
    processor.onEnd(fakeSpan({ name: "workflow.route.flow", spanId: "w-root" }));
    await processor.forceFlush();
    expect(store.writes).toHaveLength(0);
  });

  it("persists only the turn subtree, keyed by session id, re-rooted", async () => {
    const { store, processor } = makeProcessor();
    // Workflow ancestors and turn descendants share one trace; children end first.
    processor.onEnd(
      fakeSpan({ name: "ai.streamText.doStream", spanId: "model", parentSpanId: "turn" }),
    );
    processor.onEnd(
      fakeSpan({
        name: "ai.eve.turn",
        spanId: "turn",
        parentSpanId: "wf", // real parent is a workflow span we drop
        attributes: { "eve.session.id": "sess-1" },
      }),
    );
    await processor.forceFlush();

    expect(store.writes).toHaveLength(1);
    const write = store.writes[0]!;
    expect(write.runId).toBe("sess-1");
    expect(write.spans.map((s) => s.spanId).sort()).toEqual(["model", "turn"]);
    // The dropped workflow ancestor is not carried into the run; the turn keeps
    // its (now-absent) parent link and renders as a root on read.
    expect(write.spans.some((s) => s.name.startsWith("workflow."))).toBe(false);
  });

  it("persists a continuation step's invoke_agent when its turn parent is absent", async () => {
    const { store, processor } = makeProcessor();
    // A later step runs in its own process: only its spans are buffered here,
    // and the turn span it nests under lives in another process.
    processor.onEnd(fakeSpan({ name: "chat", spanId: "chat2", parentSpanId: "agent2" }));
    processor.onEnd(
      fakeSpan({
        name: "execute_tool get_weather",
        spanId: "tool2",
        parentSpanId: "agent2",
      }),
    );
    processor.onEnd(
      fakeSpan({
        name: "invoke_agent anthropic/claude-sonnet-5",
        spanId: "agent2",
        parentSpanId: "turn-from-step-1", // absent in this process's buffer
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "ai.settings.context.eve.session.id": "sess-1",
        },
      }),
    );
    await processor.forceFlush();

    expect(store.writes).toHaveLength(1);
    const write = store.writes[0]!;
    expect(write.runId).toBe("sess-1"); // read from the AI-SDK-prefixed context
    expect(write.spans.map((s) => s.spanId).sort()).toEqual(["agent2", "chat2", "tool2"]);
    // Keeps its link to the turn so it reunites under it once merged on read.
    expect(write.spans.find((s) => s.spanId === "agent2")!.parentSpanId).toBe("turn-from-step-1");
  });

  it("persists the turn and its first-step invoke_agent under one run (deduped on read)", async () => {
    const { store, processor } = makeProcessor();
    processor.onEnd(
      fakeSpan({
        name: "invoke_agent x",
        spanId: "agent1",
        parentSpanId: "turn",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "ai.settings.context.eve.session.id": "sess-1",
        },
      }),
    );
    processor.onEnd(
      fakeSpan({ name: "ai.eve.turn", spanId: "turn", attributes: { "eve.session.id": "sess-1" } }),
    );
    await processor.forceFlush();

    // Both roots are written under the same run; the store deduplicates the
    // overlapping invoke_agent by span id on read.
    expect(store.writes.map((w) => w.runId)).toEqual(["sess-1", "sess-1"]);
    const allSpanIds = new Set(store.writes.flatMap((w) => w.spans.map((s) => s.spanId)));
    expect([...allSpanIds].sort()).toEqual(["agent1", "turn"]);
  });

  it("captures the full trace including workflow plumbing when it has agent work", async () => {
    const { store, processor } = makeProcessor();
    // Children end before their parents; the workflow root ends last.
    processor.onEnd(fakeSpan({ name: "chat", spanId: "chat", parentSpanId: "turn" }));
    processor.onEnd(
      fakeSpan({
        name: "ai.eve.turn",
        spanId: "turn",
        parentSpanId: "wf",
        attributes: { "eve.session.id": "sess-1" },
      }),
    );
    processor.onEnd(fakeSpan({ name: "workflow.route.flow", spanId: "wf" }));
    await processor.forceFlush();

    const captured = new Set(store.writes.flatMap((w) => w.spans.map((s) => s.spanId)));
    expect(captured.has("wf")).toBe(true); // plumbing captured for verbose view
    expect(captured.has("turn")).toBe(true);
    expect(captured.has("chat")).toBe(true);
    expect(store.writes.every((w) => w.runId === "sess-1")).toBe(true);
  });

  it("falls back to the trace id when the turn has no session id", async () => {
    const { store, processor } = makeProcessor();
    processor.onEnd(fakeSpan({ name: "ai.eve.turn", spanId: "turn", traceId: "trace-xyz" }));
    await processor.forceFlush();
    expect(store.writes[0]!.runId).toBe("trace-xyz");
  });

  it("writes each turn of a session under the same run id", async () => {
    const { store, processor } = makeProcessor();
    processor.onEnd(
      fakeSpan({
        name: "ai.eve.turn",
        spanId: "turn-1",
        traceId: "t1",
        attributes: { "eve.session.id": "sess-1" },
      }),
    );
    processor.onEnd(
      fakeSpan({
        name: "ai.eve.turn",
        spanId: "turn-2",
        traceId: "t2",
        attributes: { "eve.session.id": "sess-1" },
      }),
    );
    await processor.forceFlush();
    expect(store.writes.map((w) => w.runId)).toEqual(["sess-1", "sess-1"]);
  });
});
