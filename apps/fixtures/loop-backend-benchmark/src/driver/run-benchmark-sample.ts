import type { EveMessageData, HandleMessageStreamEvent, TurnFailureStreamEvent } from "eve/client";
import {
  Client,
  defaultMessageReducer,
  isCurrentTurnBoundaryEvent,
  isTurnFailureEvent,
} from "eve/client";

import { assessBenchmarkCorrectness, hasNonemptyVisibleAssistantText } from "./correctness.js";
import type {
  BenchmarkEventObservation,
  BenchmarkSampleResult,
  CompletedBenchmarkMeasurements,
  PartialBenchmarkMeasurements,
  RunBenchmarkSampleInput,
  SerializedBenchmarkError,
} from "./types.js";
import { BENCHMARK_SAMPLE_HEADER } from "./types.js";

export async function runBenchmarkSample(
  input: RunBenchmarkSampleInput,
): Promise<BenchmarkSampleResult> {
  const client = new Client({
    headers: { [BENCHMARK_SAMPLE_HEADER]: input.sampleId },
    host: input.targetUrl,
  });
  const session = client.session();
  const reducer = defaultMessageReducer();
  const events: HandleMessageStreamEvent[] = [];
  const observations: BenchmarkEventObservation[] = [];
  let projection: EveMessageData = reducer.initial();
  let firstDecodedEventMs: number | null = null;
  let firstVisibleTextEventReceivedMs: number | null = null;
  let firstVisibleTextMs: number | null = null;
  let postAckMs: number | null = null;
  let reducerTotalMs = 0;
  let sessionStartedReceivedMs: number | null = null;
  let sessionId: string | null = null;
  let sessionWaitingReceivedMs: number | null = null;
  let sessionWaitingReducedMs: number | null = null;
  let stopStepCompletedReceivedMs: number | null = null;
  let toolRequestReceivedMs: number | null = null;
  let toolStepCompletedReceivedMs: number | null = null;

  try {
    const startedAt = performance.now();
    const response = await session.send(input.nonce);
    postAckMs = performance.now() - startedAt;
    sessionId = response.sessionId;

    for await (const event of response) {
      const receivedAt = performance.now();
      const receivedAtMs = receivedAt - startedAt;
      firstDecodedEventMs ??= receivedAtMs;
      events.push(event);

      if (event.type === "session.started") sessionStartedReceivedMs ??= receivedAtMs;
      if (
        event.type === "actions.requested" &&
        event.data.actions.some((action) => action.kind === "tool-call")
      ) {
        toolRequestReceivedMs ??= receivedAtMs;
      }
      if (event.type === "step.completed" && event.data.finishReason === "tool-calls") {
        toolStepCompletedReceivedMs ??= receivedAtMs;
      }
      if (event.type === "step.completed" && event.data.finishReason === "stop") {
        stopStepCompletedReceivedMs ??= receivedAtMs;
      }
      if (event.type === "session.waiting") sessionWaitingReceivedMs ??= receivedAtMs;

      const reduceStarted = performance.now();
      const reduceStartedAtMs = reduceStarted - startedAt;
      projection = reducer.reduce(projection, event);
      const reducedAt = performance.now();
      const reduceDurationMs = reducedAt - reduceStarted;
      const reducedAtMs = reducedAt - startedAt;
      reducerTotalMs += reduceDurationMs;

      if (firstVisibleTextMs === null && hasNonemptyVisibleAssistantText(projection)) {
        firstVisibleTextEventReceivedMs = receivedAtMs;
        firstVisibleTextMs = reducedAtMs;
      }
      if (event.type === "session.waiting" && sessionWaitingReducedMs === null) {
        sessionWaitingReducedMs = reducedAtMs;
      }

      observations.push({
        eventIndex: observations.length,
        eventType: event.type,
        receivedAtMs,
        reduceDurationMs,
        reducedAtMs,
        reduceStartedAtMs,
        serverAt: event.meta?.at ?? null,
      });
    }

    const measurements: CompletedBenchmarkMeasurements = {
      events: observations,
      firstDecodedEventMs,
      firstVisibleTextMs,
      ...measureProtocolPhases({
        firstVisibleTextEventReceivedMs,
        postAckMs,
        sessionStartedReceivedMs,
        sessionWaitingReceivedMs,
        stopStepCompletedReceivedMs,
        toolRequestReceivedMs,
        toolStepCompletedReceivedMs,
      }),
      postAckMs,
      reducerTotalMs,
      sessionWaitingReducedMs,
    };
    const identity = sampleIdentity(input);
    const failureEvent = events.find(isTurnFailureEvent);
    if (failureEvent !== undefined) {
      return {
        ...identity,
        error: serializeTurnFailure(failureEvent),
        measurements,
        outcome: "failed",
        sessionId,
      };
    }
    if (!events.some(isCurrentTurnBoundaryEvent)) {
      return {
        ...identity,
        error: {
          message: "The event stream ended before a turn boundary was received.",
          name: "IncompleteBenchmarkStreamError",
        },
        measurements,
        outcome: "failed",
        sessionId,
      };
    }

    const correctness = assessBenchmarkCorrectness({
      events,
      nonce: input.nonce,
      projection,
    });

    if (correctness.kind === "invalid") {
      return {
        ...identity,
        finalVisibleMessage: correctness.finalVisibleMessage,
        issues: correctness.issues,
        measurements,
        outcome: "invalid",
        sessionId,
      };
    }

    assertCompleteProtocolLayercake(measurements);

    return {
      ...identity,
      finalVisibleMessage: correctness.finalVisibleMessage,
      measurements,
      outcome: "valid",
      sessionId,
    };
  } catch (error) {
    const measurements: PartialBenchmarkMeasurements = {
      events: observations,
      firstDecodedEventMs,
      firstVisibleTextMs,
      ...measureProtocolPhases({
        firstVisibleTextEventReceivedMs,
        postAckMs,
        sessionStartedReceivedMs,
        sessionWaitingReceivedMs,
        stopStepCompletedReceivedMs,
        toolRequestReceivedMs,
        toolStepCompletedReceivedMs,
      }),
      postAckMs,
      reducerTotalMs,
      sessionWaitingReducedMs,
    };
    return {
      ...input,
      error: serializeError(error),
      measurements,
      outcome: "failed",
      sessionId,
    };
  }
}

function assertCompleteProtocolLayercake(measurements: CompletedBenchmarkMeasurements): void {
  const phases = {
    firstTextEventReceivedToStopStepCompletedMs:
      measurements.firstTextEventReceivedToStopStepCompletedMs,
    postAckToSessionStartedEventReceivedMs: measurements.postAckToSessionStartedEventReceivedMs,
    sessionStartedToToolRequestEventReceivedMs:
      measurements.sessionStartedToToolRequestEventReceivedMs,
    stopStepCompletedToSessionWaitingEventReceivedMs:
      measurements.stopStepCompletedToSessionWaitingEventReceivedMs,
    toolRequestToToolStepCompletedEventReceivedMs:
      measurements.toolRequestToToolStepCompletedEventReceivedMs,
    toolStepCompletedToFirstTextEventReceivedMs:
      measurements.toolStepCompletedToFirstTextEventReceivedMs,
  };
  const missing = Object.entries(phases).flatMap(([name, value]) => (value === null ? [name] : []));
  if (missing.length > 0) {
    const error = new Error(`Canonical protocol layercake is incomplete: ${missing.join(", ")}.`);
    error.name = "IncompleteBenchmarkMeasurementError";
    throw error;
  }
}

interface ProtocolPhaseBoundaries {
  readonly firstVisibleTextEventReceivedMs: number | null;
  readonly postAckMs: number | null;
  readonly sessionStartedReceivedMs: number | null;
  readonly sessionWaitingReceivedMs: number | null;
  readonly stopStepCompletedReceivedMs: number | null;
  readonly toolRequestReceivedMs: number | null;
  readonly toolStepCompletedReceivedMs: number | null;
}

function measureProtocolPhases(input: ProtocolPhaseBoundaries) {
  return {
    firstTextEventReceivedToStopStepCompletedMs: elapsed(
      input.firstVisibleTextEventReceivedMs,
      input.stopStepCompletedReceivedMs,
    ),
    postAckToSessionStartedEventReceivedMs: elapsed(
      input.postAckMs,
      input.sessionStartedReceivedMs,
    ),
    sessionStartedToToolRequestEventReceivedMs: elapsed(
      input.sessionStartedReceivedMs,
      input.toolRequestReceivedMs,
    ),
    sessionWaitingEventReceivedMs: input.sessionWaitingReceivedMs,
    stopStepCompletedToSessionWaitingEventReceivedMs: elapsed(
      input.stopStepCompletedReceivedMs,
      input.sessionWaitingReceivedMs,
    ),
    toolRequestToToolStepCompletedEventReceivedMs: elapsed(
      input.toolRequestReceivedMs,
      input.toolStepCompletedReceivedMs,
    ),
    toolStepCompletedToFirstTextEventReceivedMs: elapsed(
      input.toolStepCompletedReceivedMs,
      input.firstVisibleTextEventReceivedMs,
    ),
  };
}

function elapsed(start: number | null, end: number | null): number | null {
  return start === null || end === null || end < start ? null : end - start;
}

function serializeTurnFailure(event: TurnFailureStreamEvent): SerializedBenchmarkError {
  return {
    message: event.data.message,
    name: event.data.code,
  };
}

function sampleIdentity(input: RunBenchmarkSampleInput): RunBenchmarkSampleInput {
  return {
    nonce: input.nonce,
    runtimeKind: input.runtimeKind,
    sampleId: input.sampleId,
    targetKind: input.targetKind,
    targetUrl: input.targetUrl,
  };
}

function serializeError(error: unknown): SerializedBenchmarkError {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "NonErrorThrown" };
  }

  const serialized = {
    message: error.message,
    name: error.name,
  };
  return error.stack === undefined ? serialized : { ...serialized, stack: error.stack };
}
