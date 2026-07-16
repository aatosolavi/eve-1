import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

const MALFORMED_ARGUMENTS = '{"prompt": "Continue?';

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "invalid-tool-call-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Ask the user a question.",
          inputSchema: { type: "object" },
          name: ASK_QUESTION_TOOL_NAME,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:invalid-tool-call-session",
    history: [],
    sessionId: "invalid-tool-call-session",
  };
}

function createEventCollector(): {
  readonly emit: HarnessEmitFn;
  readonly events: HandleMessageStreamEvent[];
} {
  const events: HandleMessageStreamEvent[] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function createConfig(model: LanguageModel, emit: HarnessEmitFn): ToolLoopHarnessConfig {
  return {
    capabilities: { requestInput: true },
    handleEvent: emit,
    mode: "conversation",
    resolveModel: vi.fn().mockResolvedValue(model),
    tools: new Map([
      [
        ASK_QUESTION_TOOL_NAME,
        {
          description: "Ask the user a question.",
          inputSchema: jsonSchema({
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
            type: "object",
          }),
          name: ASK_QUESTION_TOOL_NAME,
        },
      ],
    ]),
  };
}

/**
 * Streams an `ask_question` tool call whose argument text is not valid
 * JSON, mirroring a model that truncates or garbles its tool arguments.
 * The AI SDK cannot parse the input, so it marks the parsed tool call
 * `invalid: true` and leaves `input` as the raw string.
 */
function enqueueMalformedAskQuestionCall(
  controller: ReadableStreamDefaultController<StreamPart>,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "call-1", toolName: ASK_QUESTION_TOOL_NAME, type: "tool-input-start" });
  controller.enqueue({ delta: MALFORMED_ARGUMENTS, id: "call-1", type: "tool-input-delta" });
  controller.enqueue({ id: "call-1", type: "tool-input-end" });
  controller.enqueue({
    input: MALFORMED_ARGUMENTS,
    toolCallId: "call-1",
    toolName: ASK_QUESTION_TOOL_NAME,
    type: "tool-call",
  });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "tool-calls" },
    type: "finish",
    usage,
  });
  controller.close();
}

function enqueueTextSuccess(
  controller: ReadableStreamDefaultController<StreamPart>,
  text: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "answer", type: "text-start" });
  controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
  controller.enqueue({ id: "answer", type: "text-end" });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage,
  });
  controller.close();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool loop invalid tool-call arguments", () => {
  it("recovers when the model emits unparsable ask_question arguments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          if (attempt === 1) {
            enqueueMalformedAskQuestionCall(controller);
            return;
          }
          enqueueTextSuccess(controller, "Recovered answer.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "invalid-tool-call-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    // Drive the harness the way the production turn driver does: a StepFn
    // `next` means "continue the loop with the updated session".
    let result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });
    while (typeof result.next === "function") {
      result = await result.next(result.session);
    }

    // The AI SDK synthesizes a tool-error result for the invalid call, so
    // the loop must feed it back to the model and complete the turn instead
    // of crashing on the JSON-object invariant.
    expect(doStream).toHaveBeenCalledTimes(2);
    // `next: null` is the conversation-mode terminal: the turn completed and
    // the session parks awaiting the next user message.
    expect(result.next).toBeNull();
    expect(result.session.history.at(-1)).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(result.session.history)).toContain("Recovered answer.");
    // The synthesized error feedback for the malformed call stays in history
    // so the model can self-correct.
    expect(JSON.stringify(result.session.history)).toContain("AI_InvalidToolInputError");

    // The invalid call must not park the session waiting on user input, and
    // nothing may fail.
    expect(events.filter((event) => event.type === "input.requested")).toHaveLength(0);
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});
