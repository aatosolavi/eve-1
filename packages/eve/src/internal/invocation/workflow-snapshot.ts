import type {
  AgentInvocation,
  AgentInvocationInputRequest,
} from "#internal/invocation/agent-invocation-service.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";

export function createWorkingAgentInvocation(invocationId: string): AgentInvocation {
  return { invocationId, status: "working" };
}

export function projectActiveWorkflowInvocation(input: {
  readonly invocationId: string;
  readonly events: readonly HandleMessageStreamEvent[];
}): AgentInvocation {
  let inputRequests: AgentInvocationInputRequest[] | undefined;
  for (const event of input.events) {
    if (event.type === "input.requested") {
      inputRequests = event.data.requests.map(projectInputRequest);
    } else if (event.type === "turn.started") {
      inputRequests = undefined;
    }
  }
  return inputRequests === undefined
    ? { invocationId: input.invocationId, status: "working" }
    : { inputRequests, invocationId: input.invocationId, status: "input_required" };
}

function projectInputRequest(request: InputRequest): AgentInvocationInputRequest {
  const { allowFreeform, prompt, requestId } = request;
  const options = request.options?.map(({ description, id, label }) => ({
    description,
    id,
    label,
  }));
  return { allowFreeform, options, prompt, requestId };
}

export function createCompletedAgentInvocation(input: {
  readonly invocationId: string;
  readonly result: unknown;
}): AgentInvocation {
  return {
    invocationId: input.invocationId,
    result: safeJson(input.result),
    status: "completed",
  };
}

export function createFailedAgentInvocation(input: {
  readonly invocationId: string;
  readonly error: unknown;
}): AgentInvocation {
  return {
    error: {
      message: input.error instanceof Error ? input.error.message : "Session failed.",
    },
    invocationId: input.invocationId,
    status: "failed",
  };
}

function safeJson(value: unknown): JsonValue {
  try {
    return parseJsonValue(value);
  } catch {
    return String(value);
  }
}
