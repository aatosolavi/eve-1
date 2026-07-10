import type { EveMessageData, HandleMessageStreamEvent } from "eve/client";
import { defaultMessageReducer } from "eve/client";

import type { BenchmarkCorrectnessAssessment, BenchmarkCorrectnessIssue } from "./types.js";

const BENCHMARK_TOOL_NAME = "benchmark_echo";

export function assessBenchmarkCorrectness(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly nonce: string;
  readonly projection: EveMessageData;
}): BenchmarkCorrectnessAssessment {
  const expectedVerification = `benchmark-verified:${input.nonce}`;
  const issues: BenchmarkCorrectnessIssue[] = [];

  const sessionStartedIndices = eventIndices(input.events, "session.started");
  if (sessionStartedIndices.length !== 1) {
    issues.push({
      actual: sessionStartedIndices.length,
      expected: 1,
      kind: "session-started-count",
    });
  }

  const receivedMessages = input.events.flatMap((event, eventIndex) =>
    event.type === "message.received" ? [{ eventIndex, message: event.data.message }] : [],
  );
  if (receivedMessages.length !== 1) {
    issues.push({ actual: receivedMessages.length, expected: 1, kind: "message-received-count" });
  } else if (receivedMessages[0]?.message !== input.nonce) {
    issues.push({
      actual: receivedMessages[0]?.message ?? "",
      expected: input.nonce,
      kind: "message-received-mismatch",
    });
  }

  const completedSteps = input.events.flatMap((event, eventIndex) =>
    event.type === "step.completed"
      ? [{ eventIndex, finishReason: event.data.finishReason, stepIndex: event.data.stepIndex }]
      : [],
  );
  if (completedSteps.length !== 2) {
    issues.push({ actual: completedSteps.length, expected: 2, kind: "model-step-count" });
  } else if (!hasExpectedStepShape(completedSteps)) {
    issues.push({
      actual: completedSteps.map(({ finishReason, stepIndex }) => ({ finishReason, stepIndex })),
      expected: [
        { finishReason: "tool-calls", stepIndex: 0 },
        { finishReason: "stop", stepIndex: 1 },
      ],
      kind: "model-step-shape",
    });
  }

  const toolRequests = input.events.flatMap((event, eventIndex) =>
    event.type === "actions.requested"
      ? event.data.actions
          .filter((action) => action.kind === "tool-call")
          .map((action) => ({ action, eventIndex, stepIndex: event.data.stepIndex }))
      : [],
  );
  if (toolRequests.length !== 1) {
    issues.push({ actual: toolRequests.length, expected: 1, kind: "tool-request-count" });
  } else {
    const request = toolRequests[0];
    if (request !== undefined) {
      const requestNonce = request.action.input.nonce;
      if (
        request.action.toolName !== BENCHMARK_TOOL_NAME ||
        requestNonce !== input.nonce ||
        request.stepIndex !== 0
      ) {
        issues.push({
          actual: {
            callId: request.action.callId,
            nonce: typeof requestNonce === "string" ? requestNonce : null,
            stepIndex: request.stepIndex,
            toolName: request.action.toolName,
          },
          expected: { nonce: input.nonce, stepIndex: 0, toolName: BENCHMARK_TOOL_NAME },
          kind: "tool-request-mismatch",
        });
      }
    }
  }

  const finalVisibleMessage = readVisibleAssistantText(input.projection);
  if (finalVisibleMessage !== expectedVerification) {
    issues.push({
      actual: finalVisibleMessage,
      expected: expectedVerification,
      kind: "final-visible-message",
    });
  }

  const sessionWaitingCount = input.events.filter(
    (event) => event.type === "session.waiting",
  ).length;
  if (sessionWaitingCount !== 1) {
    issues.push({
      actual: sessionWaitingCount,
      expected: 1,
      kind: "session-waiting-count",
    });
  }

  const firstVisibleTextEventIndex = findFirstVisibleTextEventIndex(input.events);
  const toolStep = completedSteps.find((step) => step.finishReason === "tool-calls");
  const stopStep = completedSteps.find((step) => step.finishReason === "stop");
  const sessionWaitingIndex = input.events.findIndex((event) => event.type === "session.waiting");
  const boundaryIndices = [
    sessionStartedIndices[0],
    receivedMessages[0]?.eventIndex,
    toolRequests[0]?.eventIndex,
    toolStep?.eventIndex,
    firstVisibleTextEventIndex,
    stopStep?.eventIndex,
    sessionWaitingIndex < 0 ? undefined : sessionWaitingIndex,
  ];
  if (boundaryIndices.every((index): index is number => index !== undefined)) {
    if (!isStrictlyIncreasing(boundaryIndices)) {
      issues.push({
        actual: boundaryIndices,
        expected: "strictly increasing canonical boundary indices",
        kind: "protocol-event-order",
      });
    }
  }

  return issues.length === 0
    ? { finalVisibleMessage, kind: "valid" }
    : { finalVisibleMessage, issues, kind: "invalid" };
}

function eventIndices(
  events: readonly HandleMessageStreamEvent[],
  type: HandleMessageStreamEvent["type"],
): number[] {
  return events.flatMap((event, index) => (event.type === type ? [index] : []));
}

function findFirstVisibleTextEventIndex(
  events: readonly HandleMessageStreamEvent[],
): number | undefined {
  const reducer = defaultMessageReducer();
  let projection = reducer.initial();
  for (const [index, event] of events.entries()) {
    projection = reducer.reduce(projection, event);
    if (hasNonemptyVisibleAssistantText(projection)) return index;
  }
  return undefined;
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

function hasExpectedStepShape(
  steps: readonly { readonly finishReason: string; readonly stepIndex: number }[],
): boolean {
  const first = steps[0];
  const second = steps[1];
  return (
    first?.finishReason === "tool-calls" &&
    first.stepIndex === 0 &&
    second?.finishReason === "stop" &&
    second.stepIndex === 1
  );
}

export function readVisibleAssistantText(projection: EveMessageData): string {
  return projection.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function hasNonemptyVisibleAssistantText(projection: EveMessageData): boolean {
  return projection.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
}
