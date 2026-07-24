import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { getPendingInputRequestIds } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  ASK_QUESTION_INPUT_SCHEMA,
  ASK_QUESTION_TOOL_DEFINITION,
} from "#runtime/framework-tools/ask-question.js";
import { serializeInputSchema, toInputSchema } from "#shared/tool-schema.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

function findToolResult(messages: readonly ModelMessage[], toolCallId: string): unknown {
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const result = message.content.find(
      (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

describe("framework tool input validation (real AI SDK)", () => {
  it("stops a turn after the configured number of consecutive invalid tool calls", async () => {
    const inputSchema = toInputSchema({
      additionalProperties: false,
      properties: {
        ds_id: { type: "string" },
        fields: { items: { type: "string" }, type: "array" },
      },
      required: ["ds_id", "fields"],
      type: "object",
    });
    const invalidCalls = ["query-invalid-1", "query-invalid-2", "query-invalid-3"];
    const model = new MockLanguageModelV4({
      doGenerate: invalidCalls.map((toolCallId) => ({
        content: [
          {
            input: JSON.stringify({ ds_id: "dataset-1" }),
            toolCallId,
            toolName: "query_dataset",
            type: "tool-call" as const,
          },
        ],
        finishReason: { raw: undefined, unified: "tool-calls" as const },
        usage,
        warnings: [],
      })),
      modelId: "tool-error-loop-model",
      provider: "eve-integration-mock",
    });
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "query_dataset",
        {
          description: "Query selected fields from a dataset.",
          execute: async () => ({ rows: [] }),
          inputSchema,
          name: "query_dataset",
        },
      ],
    ]);
    const runStep = createToolLoopHarness({
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools,
    });
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "tool-error-loop-model" },
        system: "Query the dataset.",
        tools: [
          {
            description: "Query selected fields from a dataset.",
            inputSchema: serializeInputSchema(inputSchema),
            name: "query_dataset",
          },
        ],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:tool-error-loop-session",
      history: [],
      limits: {
        maxConsecutiveToolErrors: 2,
      },
      sessionId: "tool-error-loop-session",
    };

    const firstStep = await runStep(session, { message: "Query dataset-1." });

    expect(typeof firstStep.next).toBe("function");
    expect(findToolResult(firstStep.session.history, invalidCalls[0] ?? "")).toMatchObject({
      output: expect.objectContaining({
        type: "error-text",
        value: expect.stringContaining("fields"),
      }),
    });

    if (typeof firstStep.next !== "function") {
      throw new TypeError("Expected the first invalid tool call to continue the tool loop.");
    }
    const secondStep = await firstStep.next(firstStep.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(
      findToolResult(model.doGenerateCalls[1]?.prompt ?? [], invalidCalls[0] ?? ""),
    ).toBeDefined();
    expect(findToolResult(secondStep.session.history, invalidCalls[1] ?? "")).toMatchObject({
      output: expect.objectContaining({
        type: "error-text",
        value: expect.stringContaining("fields"),
      }),
    });
    expect(typeof secondStep.next).toBe("function");

    if (typeof secondStep.next !== "function") {
      throw new TypeError("Expected the tool error limit to run before the next model call.");
    }
    const stoppedStep = await secondStep.next(secondStep.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(stoppedStep.next).toBeNull();
  });

  it("accepts a corrected array field after returning the missing-field error", async () => {
    const inputSchema = toInputSchema({
      additionalProperties: false,
      properties: {
        ds_id: { type: "string" },
        fields: { items: { type: "string" }, type: "array" },
      },
      required: ["ds_id", "fields"],
      type: "object",
    });
    const invalidCallId = "query-missing-fields";
    const validCallId = "query-with-fields";
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ ds_id: "dataset-1" }),
              toolCallId: invalidCallId,
              toolName: "query_dataset",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ ds_id: "dataset-1", fields: ["name"] }),
              toolCallId: validCallId,
              toolName: "query_dataset",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
      modelId: "tool-input-recovery-model",
      provider: "eve-integration-mock",
    });
    let executedInput: unknown;
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "query_dataset",
        {
          description: "Query selected fields from a dataset.",
          execute: async (input) => {
            executedInput = input;
            return { rows: [] };
          },
          inputSchema,
          name: "query_dataset",
        },
      ],
    ]);
    const runStep = createToolLoopHarness({
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools,
    });
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "tool-input-recovery-model" },
        system: "Query the dataset.",
        tools: [
          {
            description: "Query selected fields from a dataset.",
            inputSchema: serializeInputSchema(inputSchema),
            name: "query_dataset",
          },
        ],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:tool-input-recovery-session",
      history: [],
      sessionId: "tool-input-recovery-session",
    };

    const invalidStep = await runStep(session, { message: "Query dataset-1." });

    expect(findToolResult(invalidStep.session.history, invalidCallId)).toMatchObject({
      output: expect.objectContaining({
        type: "error-text",
        value: expect.stringContaining("fields"),
      }),
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected the invalid tool call to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(executedInput).toEqual({ ds_id: "dataset-1", fields: ["name"] });
    expect(typeof validStep.next).toBe("function");
  });

  it("returns malformed and schema-invalid ask_question input to the model before accepting a retry", async () => {
    const malformedCallId = "question-malformed";
    const invalidCallId = "question-invalid";
    const validCallId = "question-valid";
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: '{"prompt":',
              toolCallId: malformedCallId,
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ prompt: 42 }),
              toolCallId: invalidCallId,
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ prompt: "Which option should I use?" }),
              toolCallId: validCallId,
              toolName: "ask_question",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
      modelId: "tool-validation-model",
      provider: "eve-integration-mock",
    });
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "ask_question",
        {
          description: ASK_QUESTION_TOOL_DEFINITION.description,
          inputSchema: ASK_QUESTION_INPUT_SCHEMA,
          name: "ask_question",
        },
      ],
    ]);
    const config: ToolLoopHarnessConfig = {
      capabilities: { requestInput: true },
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools,
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "tool-validation-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: ASK_QUESTION_TOOL_DEFINITION.description,
            inputSchema: serializeInputSchema(ASK_QUESTION_INPUT_SCHEMA),
            name: "ask_question",
          },
        ],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:tool-validation-session",
      history: [],
      sessionId: "tool-validation-session",
    };
    const runStep = createToolLoopHarness(config);

    const malformedStep = await runStep(session, { message: "Ask me which option to use." });

    expect(typeof malformedStep.next).toBe("function");
    expect(getPendingInputRequestIds(malformedStep.session.state)).toEqual(new Set());
    expect(findToolResult(malformedStep.session.history, malformedCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "ask_question",
    });

    if (typeof malformedStep.next !== "function") {
      throw new TypeError("Expected the malformed tool call to continue the tool loop.");
    }
    const invalidStep = await malformedStep.next(malformedStep.session);

    expect(typeof invalidStep.next).toBe("function");
    expect(getPendingInputRequestIds(invalidStep.session.state)).toEqual(new Set());
    expect(findToolResult(invalidStep.session.history, invalidCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "ask_question",
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected the invalid tool call to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doGenerateCalls).toHaveLength(3);
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [], malformedCallId)).toBeDefined();
    expect(findToolResult(model.doGenerateCalls[2]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(validStep.next).toBeNull();
    expect(getPendingInputRequestIds(validStep.session.state)).toEqual(new Set([validCallId]));
  });

  it("rejects invalid final_output input instead of terminating the task", async () => {
    const invalidCallId = "final-invalid";
    const validCallId = "final-valid";
    const outputSchema = {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ answer: 42 }),
              toolCallId: invalidCallId,
              toolName: "final_output",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ answer: "done" }),
              toolCallId: validCallId,
              toolName: "final_output",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
      modelId: "final-output-validation-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "task",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "final-output-validation-model" },
        system: "Return structured output.",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "task:final-output-validation-session",
      history: [],
      outputSchema,
      sessionId: "final-output-validation-session",
    };
    const runStep = createToolLoopHarness(config);

    const invalidStep = await runStep(session, { message: "Finish the task." });

    expect(typeof invalidStep.next).toBe("function");
    expect(findToolResult(invalidStep.session.history, invalidCallId)).toMatchObject({
      output: expect.objectContaining({ type: "error-text" }),
      toolName: "final_output",
    });

    if (typeof invalidStep.next !== "function") {
      throw new TypeError("Expected invalid final output to continue the tool loop.");
    }
    const validStep = await invalidStep.next(invalidStep.session);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [], invalidCallId)).toBeDefined();
    expect(validStep.next).toEqual({ done: true, output: { answer: "done" } });
  });
});
