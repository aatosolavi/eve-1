import { z } from "#compiled/zod/index.js";

import {
  AgentInvocationConflictError,
  AgentInvocationNotFoundError,
  agentInvocationSchema,
  type AgentInvocation,
  type AgentInvocationClient,
} from "#internal/invocation/agent-invocation-service.js";
import { toJsonSchema } from "#internal/mcp/json-schema.js";
import {
  McpServerToolError,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";

import type { JsonObject } from "#shared/json.js";

const AGENT_INVOCATION_JSON_SCHEMA = toJsonSchema(agentInvocationSchema);

const invocationIdSchema = z.string().min(1).describe("Invocation handle returned by agent_start.");

const startInvocationInputSchema = z
  .object({
    message: z.string().min(1).describe("Complete task to delegate to the eve agent."),
  })
  .strict();

const invocationIdInputSchema = z.object({ invocationId: invocationIdSchema }).strict();

const inputRequestIdSchema = z
  .string()
  .describe("The exact requestId from the pending input request.");
const mcpInputResponseSchema = z
  .union([
    z
      .object({
        optionId: z.string().describe("The selected option id. Use this for a listed option."),
        requestId: inputRequestIdSchema,
      })
      .strict(),
    z
      .object({
        requestId: inputRequestIdSchema,
        text: z.string().describe("A freeform answer. Use only when freeform input is allowed."),
      })
      .strict(),
  ])
  .describe("One answer to a pending input request. Provide exactly one of optionId or text.");

const updateInvocationInputSchema = z
  .object({
    invocationId: invocationIdSchema,
    responses: z.array(mcpInputResponseSchema).min(1),
  })
  .strict();

export function createMcpInvocationTools(
  clientForCaller: (auth: Parameters<McpServerTool["call"]>[1]["auth"]) => AgentInvocationClient,
  config: { readonly description: string; readonly outputSchema?: JsonObject },
): readonly McpServerTool[] {
  return [
    {
      definition: {
        description: [
          config.description,
          "Starts exactly one durable invocation and returns immediately.",
          "This operation is non-idempotent: if its outcome is unknown, do not retry automatically.",
          "Retain invocationId, then use agent_get to read its current state.",
        ].join(" "),
        inputSchema: toJsonSchema(startInvocationInputSchema),
        name: "agent_start",
        outputSchema: AGENT_INVOCATION_JSON_SCHEMA,
      },
      async call(value, { auth }) {
        const input = parseToolInput(startInvocationInputSchema, value);
        return await callInvocation(() =>
          clientForCaller(auth).create({
            message: input.message,
            outputSchema: config.outputSchema,
          }),
        );
      },
    },
    {
      definition: {
        description:
          "Reads durable invocation state without starting work or running a model. For input_required, answer with agent_respond. Stop polling at completed, failed, or cancelled.",
        inputSchema: toJsonSchema(invocationIdInputSchema),
        name: "agent_get",
        outputSchema: AGENT_INVOCATION_JSON_SCHEMA,
      },
      async call(value, { auth }) {
        return await callInvocation(() =>
          clientForCaller(auth).read(parseToolInput(invocationIdInputSchema, value)),
        );
      },
    },
    {
      definition: {
        description:
          "Answers pending inputRequests from an input_required invocation. Copy each requestId exactly; use optionId for a listed option or text only when freeform input is allowed. Then resume polling with agent_get.",
        inputSchema: toJsonSchema(updateInvocationInputSchema),
        name: "agent_respond",
        outputSchema: AGENT_INVOCATION_JSON_SCHEMA,
      },
      async call(value, { auth }) {
        return await callInvocation(() =>
          clientForCaller(auth).update(parseToolInput(updateInvocationInputSchema, value)),
        );
      },
    },
  ];
}

function parseToolInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpServerToolError("invalid_arguments", "Invalid tool arguments.", {
      issues: parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.map(String),
      })),
    });
  }
  return parsed.data;
}

async function callInvocation(call: () => Promise<AgentInvocation>): Promise<McpCallToolResult> {
  try {
    return invocationResult(await call());
  } catch (error) {
    if (error instanceof AgentInvocationNotFoundError) {
      throw new McpServerToolError("invocation_not_found", error.message);
    }
    if (error instanceof AgentInvocationConflictError) {
      throw new McpServerToolError("invocation_conflict", error.message);
    }
    throw error;
  }
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  return {
    content: [{ text: JSON.stringify(invocation), type: "text" }],
    structuredContent: { ...invocation },
  };
}
