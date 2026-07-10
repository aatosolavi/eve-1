import type { EveMessageData, HandleMessageStreamEvent } from "eve/client";
import { defaultMessageReducer } from "eve/client";

export const TEST_NONCE = "nonce-7f3";
export const TEST_VERIFICATION = `benchmark-verified:${TEST_NONCE}`;

export function createValidEvents(): readonly HandleMessageStreamEvent[] {
  return [
    {
      data: {},
      meta: { at: "2026-07-10T12:00:00.000Z" },
      type: "session.started",
    },
    {
      data: { message: TEST_NONCE, sequence: 0, turnId: "turn-0" },
      type: "message.received",
    },
    {
      data: {
        actions: [
          {
            callId: "call-0",
            input: { nonce: TEST_NONCE },
            kind: "tool-call",
            toolName: "benchmark_echo",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-0",
      },
      type: "actions.requested",
    },
    {
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-0",
      },
      type: "step.completed",
    },
    {
      data: {
        messageDelta: TEST_VERIFICATION,
        messageSoFar: TEST_VERIFICATION,
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-0",
      },
      type: "message.appended",
    },
    {
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-0",
      },
      type: "step.completed",
    },
    {
      data: { wait: "next-user-message" },
      type: "session.waiting",
    },
  ];
}

export function createInvalidEvents(): readonly HandleMessageStreamEvent[] {
  return [
    {
      data: {
        actions: [
          {
            callId: "call-0",
            input: { nonce: "wrong-nonce" },
            kind: "tool-call",
            toolName: "benchmark_echo",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-0",
      },
      type: "actions.requested",
    },
    {
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-0",
      },
      type: "step.completed",
    },
    {
      data: {
        messageDelta: "wrong response",
        messageSoFar: "wrong response",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-0",
      },
      type: "message.appended",
    },
  ];
}

export function reduceEvents(events: readonly HandleMessageStreamEvent[]): EveMessageData {
  const reducer = defaultMessageReducer();
  return events.reduce((data, event) => reducer.reduce(data, event), reducer.initial());
}
