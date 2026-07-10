import type { HandleMessageStreamEvent } from "eve/client";

export const BENCHMARK_SAMPLE_HEADER = "x-eve-benchmark-sample-id";

export type BenchmarkRuntimeKind = "inline" | "temporal" | "workflow";
export type BenchmarkTargetKind = "local" | "vercel";

export interface RunBenchmarkSampleInput {
  readonly nonce: string;
  readonly runtimeKind: BenchmarkRuntimeKind;
  readonly sampleId: string;
  readonly targetKind: BenchmarkTargetKind;
  readonly targetUrl: string;
}

export interface BenchmarkEventObservation {
  readonly eventIndex: number;
  readonly eventType: HandleMessageStreamEvent["type"];
  readonly receivedAtMs: number;
  readonly reduceDurationMs: number;
  readonly reducedAtMs: number;
  readonly reduceStartedAtMs: number;
  /** Server wall time for correlation only. Never used in client duration arithmetic. */
  readonly serverAt: string | null;
}

export interface CompletedBenchmarkMeasurements {
  readonly events: readonly BenchmarkEventObservation[];
  readonly firstDecodedEventMs: number | null;
  readonly firstTextEventReceivedToStopStepCompletedMs: number | null;
  readonly firstVisibleTextMs: number | null;
  readonly postAckMs: number;
  readonly postAckToSessionStartedEventReceivedMs: number | null;
  readonly reducerTotalMs: number;
  readonly sessionStartedToToolRequestEventReceivedMs: number | null;
  readonly sessionWaitingEventReceivedMs: number | null;
  readonly sessionWaitingReducedMs: number | null;
  readonly stopStepCompletedToSessionWaitingEventReceivedMs: number | null;
  readonly toolRequestToToolStepCompletedEventReceivedMs: number | null;
  readonly toolStepCompletedToFirstTextEventReceivedMs: number | null;
}

export interface PartialBenchmarkMeasurements {
  readonly events: readonly BenchmarkEventObservation[];
  readonly firstDecodedEventMs: number | null;
  readonly firstTextEventReceivedToStopStepCompletedMs: number | null;
  readonly firstVisibleTextMs: number | null;
  readonly postAckMs: number | null;
  readonly postAckToSessionStartedEventReceivedMs: number | null;
  readonly reducerTotalMs: number;
  readonly sessionStartedToToolRequestEventReceivedMs: number | null;
  readonly sessionWaitingEventReceivedMs: number | null;
  readonly sessionWaitingReducedMs: number | null;
  readonly stopStepCompletedToSessionWaitingEventReceivedMs: number | null;
  readonly toolRequestToToolStepCompletedEventReceivedMs: number | null;
  readonly toolStepCompletedToFirstTextEventReceivedMs: number | null;
}

export type BenchmarkCorrectnessIssue =
  | {
      readonly actual: number;
      readonly expected: 1;
      readonly kind: "session-started-count";
    }
  | {
      readonly actual: number;
      readonly expected: 1;
      readonly kind: "message-received-count";
    }
  | {
      readonly actual: string;
      readonly expected: string;
      readonly kind: "message-received-mismatch";
    }
  | {
      readonly actual: number;
      readonly expected: 2;
      readonly kind: "model-step-count";
    }
  | {
      readonly actual: readonly {
        readonly finishReason: string;
        readonly stepIndex: number;
      }[];
      readonly expected: readonly [
        { readonly finishReason: "tool-calls"; readonly stepIndex: 0 },
        { readonly finishReason: "stop"; readonly stepIndex: 1 },
      ];
      readonly kind: "model-step-shape";
    }
  | {
      readonly actual: number;
      readonly expected: 1;
      readonly kind: "tool-request-count";
    }
  | {
      readonly actual: {
        readonly callId: string;
        readonly nonce: string | null;
        readonly stepIndex: number;
        readonly toolName: string;
      };
      readonly expected: {
        readonly nonce: string;
        readonly stepIndex: 0;
        readonly toolName: "benchmark_echo";
      };
      readonly kind: "tool-request-mismatch";
    }
  | {
      readonly actual: string;
      readonly expected: string;
      readonly kind: "final-visible-message";
    }
  | {
      readonly actual: number;
      readonly expected: 1;
      readonly kind: "session-waiting-count";
    }
  | {
      readonly actual: readonly number[];
      readonly expected: "strictly increasing canonical boundary indices";
      readonly kind: "protocol-event-order";
    };

export type BenchmarkCorrectnessAssessment =
  | {
      readonly finalVisibleMessage: string;
      readonly kind: "valid";
    }
  | {
      readonly finalVisibleMessage: string;
      readonly issues: readonly BenchmarkCorrectnessIssue[];
      readonly kind: "invalid";
    };

interface BenchmarkSampleIdentity {
  readonly nonce: string;
  readonly runtimeKind: BenchmarkRuntimeKind;
  readonly sampleId: string;
  readonly targetKind: BenchmarkTargetKind;
  readonly targetUrl: string;
}

export type BenchmarkSampleResult =
  | (BenchmarkSampleIdentity & {
      readonly finalVisibleMessage: string;
      readonly measurements: CompletedBenchmarkMeasurements;
      readonly outcome: "valid";
      readonly sessionId: string;
    })
  | (BenchmarkSampleIdentity & {
      readonly finalVisibleMessage: string;
      readonly issues: readonly BenchmarkCorrectnessIssue[];
      readonly measurements: CompletedBenchmarkMeasurements;
      readonly outcome: "invalid";
      readonly sessionId: string;
    })
  | (BenchmarkSampleIdentity & {
      readonly error: SerializedBenchmarkError;
      readonly measurements: PartialBenchmarkMeasurements;
      readonly outcome: "failed";
      readonly sessionId: string | null;
    });

export interface SerializedBenchmarkError {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}
