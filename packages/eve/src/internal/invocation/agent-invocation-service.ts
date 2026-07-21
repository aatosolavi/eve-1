import { z } from "#compiled/zod/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { inputOptionSchema, inputRequestSchema, type InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const jsonValueSchema = z.json() as z.ZodType<JsonValue>;

export const agentInvocationStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

export type AgentInvocationStatus = z.infer<typeof agentInvocationStatusSchema>;

export const agentInvocationInputOptionSchema = inputOptionSchema.omit({ style: true });

export type AgentInvocationInputOption = z.infer<typeof agentInvocationInputOptionSchema>;

export const agentInvocationInputRequestSchema = inputRequestSchema
  .omit({ action: true, display: true, options: true })
  .extend({ options: z.array(agentInvocationInputOptionSchema).optional() });

export type AgentInvocationInputRequest = z.infer<typeof agentInvocationInputRequestSchema>;

const invocationIdSchema = z
  .string()
  .describe("Durable capability handle. Retain it for every later operation.");

export const agentInvocationSchema = z.discriminatedUnion("status", [
  z.object({ invocationId: invocationIdSchema, status: z.literal("working") }).strict(),
  z
    .object({
      inputRequests: z.array(agentInvocationInputRequestSchema),
      invocationId: invocationIdSchema,
      status: z.literal("input_required"),
    })
    .strict(),
  z
    .object({
      invocationId: invocationIdSchema,
      result: jsonValueSchema.describe("Final agent output."),
      status: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      error: z.object({ message: z.string() }).strict(),
      invocationId: invocationIdSchema,
      status: z.literal("failed"),
    })
    .strict(),
  z.object({ invocationId: invocationIdSchema, status: z.literal("cancelled") }).strict(),
]);

export type AgentInvocation = z.infer<typeof agentInvocationSchema>;

export interface CreateAgentInvocationInput {
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export interface ReadAgentInvocationInput {
  readonly invocationId: string;
}

export interface UpdateAgentInvocationInput extends ReadAgentInvocationInput {
  readonly responses: readonly InputResponse[];
}

/** Target-bound, protocol-neutral client for durable agent invocations. */
export interface AgentInvocationClient {
  create(input: CreateAgentInvocationInput): Promise<AgentInvocation>;
  read(input: ReadAgentInvocationInput): Promise<AgentInvocation>;
  update(input: UpdateAgentInvocationInput): Promise<AgentInvocation>;
}

/** Result of attempting to update an invocation in a backend. */
export type AgentInvocationMutationResult =
  | { readonly type: "success"; readonly invocation: AgentInvocation }
  | { readonly type: "conflict"; readonly message: string }
  | { readonly type: "not_found" };

/** Server backend for durable, capability-addressed agent invocations. */
export interface AgentInvocationBackend {
  create(
    input: CreateAgentInvocationInput & { readonly auth: SessionAuthContext },
  ): Promise<AgentInvocation>;
  read(input: ReadAgentInvocationInput): Promise<AgentInvocation | undefined>;
  update(input: UpdateAgentInvocationInput): Promise<AgentInvocationMutationResult>;
}

export class AgentInvocationNotFoundError extends Error {
  constructor() {
    super("Invocation not found.");
    this.name = "AgentInvocationNotFoundError";
  }
}

export class AgentInvocationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInvocationConflictError";
  }
}

/** Binds authenticated callers to an auth-aware invocation backend. */
export class AgentInvocationService {
  readonly #backend: AgentInvocationBackend;

  constructor(backend: AgentInvocationBackend) {
    this.#backend = backend;
  }

  forCaller(auth: SessionAuthContext): AgentInvocationClient {
    return {
      create: async (input) => await this.#backend.create({ ...input, auth }),
      read: async (input) => {
        const invocation = await this.#backend.read(input);
        if (invocation === undefined) throw new AgentInvocationNotFoundError();
        return invocation;
      },
      update: async (input) => {
        const result = await this.#backend.update(input);
        switch (result.type) {
          case "success":
            return result.invocation;
          case "conflict":
            throw new AgentInvocationConflictError(result.message);
          case "not_found":
            throw new AgentInvocationNotFoundError();
        }
      },
    };
  }
}
