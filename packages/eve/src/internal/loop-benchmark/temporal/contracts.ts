import { defineSignal } from "@temporalio/workflow";

import type { HookPayload, SessionAuthContext } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import type { DurableStepResult } from "#execution/turn-step-operation.js";

export const TEMPORAL_BENCHMARK_WORKFLOW = "temporalBenchmarkWorkflow";
export const TEMPORAL_BENCHMARK_TURN_WORKFLOW = "temporalBenchmarkTurnWorkflow";
export const TEMPORAL_BENCHMARK_DELIVERY_SIGNAL = "eve.benchmark.delivery";

export const temporalBenchmarkDeliverySignal = defineSignal<[unknown]>(
  TEMPORAL_BENCHMARK_DELIVERY_SIGNAL,
);

export interface TemporalBenchmarkDelivery {
  readonly auth?: SessionAuthContext | null;
  readonly message: string;
  readonly requestId?: string;
}

export interface TemporalBenchmarkWorkflowInput {
  readonly continuationToken: string;
  readonly initialMessage: string;
  readonly requestId?: string;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}

export interface TemporalBenchmarkCreateSessionInput {
  readonly continuationToken: string;
  readonly sampleId?: string;
  readonly sessionId: string;
}

export interface TemporalBenchmarkTurnStepInput {
  readonly input: HookPayload | undefined;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly stepOrdinal: number;
  readonly turnOrdinal: number;
}

export interface TemporalBenchmarkTurnWorkflowInput {
  readonly input: HookPayload;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly turnOrdinal: number;
}

export interface TemporalBenchmarkActivities {
  createSession(
    input: TemporalBenchmarkCreateSessionInput,
  ): Promise<{ readonly state: DurableSessionState }>;
  executeTurnStep(input: TemporalBenchmarkTurnStepInput): Promise<DurableStepResult>;
  rekeySession(input: {
    readonly continuationToken: string;
    readonly sampleId?: string;
    readonly sessionId: string;
  }): Promise<void>;
  settleSession(input: { readonly sampleId?: string; readonly sessionId: string }): Promise<void>;
}

export type TemporalBenchmarkWorkflow = (input: TemporalBenchmarkWorkflowInput) => Promise<void>;

export type TemporalBenchmarkTurnWorkflow = (
  input: TemporalBenchmarkTurnWorkflowInput,
) => Promise<DurableStepResult>;
