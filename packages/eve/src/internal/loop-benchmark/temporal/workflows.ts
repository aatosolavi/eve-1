import {
  condition,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

import type { HookPayload, SessionAuthContext } from "#channel/types.js";
import {
  temporalBenchmarkDeliverySignal,
  TEMPORAL_BENCHMARK_TURN_WORKFLOW,
  type TemporalBenchmarkActivities,
  type TemporalBenchmarkDelivery,
  type TemporalBenchmarkTurnWorkflow,
  type TemporalBenchmarkTurnWorkflowInput,
  type TemporalBenchmarkWorkflowInput,
} from "./contracts.js";

const activities = proxyActivities<TemporalBenchmarkActivities>({
  // Repeating a live model or authored-tool call would change the workload.
  // Failed attempts remain visible in telemetry instead of retrying side effects.
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: "5 minutes",
});

/** Deterministic Temporal driver for the fixed loop benchmark workload. */
export async function temporalBenchmarkWorkflow(rawInput: unknown): Promise<void> {
  const input = parseWorkflowInput(rawInput);
  if (workflowInfo().workflowId !== input.sessionId) {
    throw new Error(
      `Temporal Workflow "${workflowInfo().workflowId}" does not match session "${input.sessionId}".`,
    );
  }

  const deliveries: HookPayload[] = [];
  setHandler(temporalBenchmarkDeliverySignal, (rawDelivery) => {
    deliveries.push(toHookPayload(parseDelivery(rawDelivery)));
  });

  const created = await activities.createSession({
    continuationToken: input.continuationToken,
    sampleId: input.sampleId,
    sessionId: input.sessionId,
  });

  let sessionState = created.state;
  let serializedContext = input.serializedContext;
  let turnInput: HookPayload = {
    kind: "deliver",
    payloads: [{ message: input.initialMessage }],
    requestId: input.requestId,
  };
  let turnOrdinal = 0;

  while (true) {
    const turn = await startChild<TemporalBenchmarkTurnWorkflow>(TEMPORAL_BENCHMARK_TURN_WORKFLOW, {
      args: [
        {
          input: turnInput,
          sampleId: input.sampleId,
          serializedContext,
          sessionId: input.sessionId,
          sessionState,
          turnOrdinal,
        },
      ],
      workflowId: `${input.sessionId}:turn:${String(turnOrdinal)}`,
    });
    const result = await turn.result();
    sessionState = result.sessionState;
    serializedContext = result.serializedContext;

    switch (result.action) {
      case "done":
        await activities.settleSession({
          sampleId: input.sampleId,
          sessionId: input.sessionId,
        });
        return;
      case "park": {
        await activities.rekeySession({
          continuationToken: result.sessionState.continuationToken,
          sampleId: input.sampleId,
          sessionId: input.sessionId,
        });
        await condition(() => deliveries.length > 0);
        const delivery = deliveries.shift();
        if (delivery === undefined) {
          throw new Error("Temporal benchmark delivery disappeared after its wait resolved.");
        }
        turnInput = delivery;
        turnOrdinal += 1;
        break;
      }
      case "continue":
        throw new Error('Temporal benchmark turn child returned unexpected action "continue".');
      case "dispatch-workflow-runtime-actions":
        throw new Error(
          'Temporal benchmark turn child returned unexpected action "dispatch-workflow-runtime-actions".',
        );
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
}

/** Child Workflow that owns all production step operations for one logical turn. */
export async function temporalBenchmarkTurnWorkflow(
  input: TemporalBenchmarkTurnWorkflowInput,
): Promise<import("#execution/turn-step-operation.js").DurableStepResult> {
  const info = workflowInfo();
  if (info.parent?.workflowId !== input.sessionId) {
    throw new Error(
      `Temporal turn parent "${info.parent?.workflowId ?? "none"}" does not match session "${input.sessionId}".`,
    );
  }

  let sessionState = input.sessionState;
  let serializedContext = input.serializedContext;
  let stepInput: HookPayload | undefined = input.input;
  let stepOrdinal = 0;

  while (true) {
    const result = await activities.executeTurnStep({
      input: stepInput,
      sampleId: input.sampleId,
      serializedContext,
      sessionId: input.sessionId,
      sessionState,
      stepOrdinal,
      turnOrdinal: input.turnOrdinal,
    });
    sessionState = result.sessionState;
    serializedContext = result.serializedContext;

    switch (result.action) {
      case "continue":
        stepInput = undefined;
        stepOrdinal += 1;
        break;
      case "done":
        return result;
      case "park":
        if (result.hasPendingAuthorization) {
          throw new Error("Temporal benchmark does not support authorization waits.");
        }
        if (result.hasPendingInputBatch) {
          throw new Error("Temporal benchmark does not support input-request waits.");
        }
        if (result.pendingRuntimeActionKeys !== undefined) {
          throw new Error("Temporal benchmark does not support runtime actions.");
        }
        return result;
      case "dispatch-workflow-runtime-actions":
        throw new Error(
          'Temporal benchmark does not support action "dispatch-workflow-runtime-actions".',
        );
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
}

function parseWorkflowInput(value: unknown): TemporalBenchmarkWorkflowInput {
  const record = requireRecord(value, "Temporal benchmark Workflow input");
  return {
    continuationToken: requireString(record["continuationToken"], "continuationToken"),
    initialMessage: requireString(record["initialMessage"], "initialMessage"),
    requestId: optionalString(record["requestId"], "requestId"),
    sampleId: optionalString(record["sampleId"], "sampleId"),
    serializedContext: requireRecord(record["serializedContext"], "serializedContext"),
    sessionId: requireString(record["sessionId"], "sessionId"),
  };
}

function parseDelivery(value: unknown): TemporalBenchmarkDelivery {
  const record = requireRecord(value, "Temporal benchmark delivery");
  return {
    auth: parseAuth(record["auth"]),
    message: requireString(record["message"], "message"),
    requestId: optionalString(record["requestId"], "requestId"),
  };
}

function parseAuth(value: unknown): SessionAuthContext | null | undefined {
  if (value === undefined || value === null) return value;
  const record = requireRecord(value, "delivery auth");
  const attributes = requireRecord(record["attributes"], "delivery auth attributes");
  const parsedAttributes: Record<string, string | readonly string[]> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    if (typeof attribute === "string") {
      parsedAttributes[name] = attribute;
      continue;
    }
    if (Array.isArray(attribute) && attribute.every((item) => typeof item === "string")) {
      parsedAttributes[name] = attribute;
      continue;
    }
    throw new TypeError(`Delivery auth attribute "${name}" must be a string or string array.`);
  }
  return {
    attributes: parsedAttributes,
    authenticator: requireString(record["authenticator"], "authenticator"),
    issuer: optionalString(record["issuer"], "issuer"),
    principalId: requireString(record["principalId"], "principalId"),
    principalType: requireString(record["principalType"], "principalType"),
    subject: optionalString(record["subject"], "subject"),
  };
}

function toHookPayload(delivery: TemporalBenchmarkDelivery): HookPayload {
  return {
    auth: delivery.auth,
    kind: "deliver",
    payloads: [{ message: delivery.message }],
    requestId: delivery.requestId,
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireString(value, name);
}
