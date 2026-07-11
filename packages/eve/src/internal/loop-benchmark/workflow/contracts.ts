import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import type { CreateSessionOperationInput } from "#execution/session-operation.js";
import type { DurableStepResult, TurnStepOperationInput } from "#execution/turn-step-operation.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

export interface WorkflowBenchmarkSessionInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly initialDelivery: DeliverHookPayload;
  readonly nodeId?: string;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
}

export interface WorkflowBenchmarkTurnInput {
  readonly initialInput: HookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly settledToken: string;
  readonly turnOrdinal: number;
}

type ContinueOrDoneResult = Extract<DurableStepResult, { readonly action: "continue" | "done" }>;

export type WorkflowBenchmarkDoneResult = Omit<ContinueOrDoneResult, "action"> & {
  readonly action: "done";
};

export type WorkflowBenchmarkParkResult = Extract<DurableStepResult, { readonly action: "park" }>;

export type WorkflowBenchmarkTurnResult = WorkflowBenchmarkDoneResult | WorkflowBenchmarkParkResult;

export interface WorkflowBenchmarkChildSettled {
  readonly kind: "turn-settled";
  readonly runId: string;
  readonly turnOrdinal: number;
}

export interface CreateWorkflowBenchmarkSessionStepInput extends CreateSessionOperationInput {
  readonly sampleId?: string;
}

export interface ExecuteWorkflowBenchmarkTurnStepInput extends Pick<
  TurnStepOperationInput,
  "input" | "serializedContext" | "sessionState"
> {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sampleId?: string;
  readonly stepOrdinal: number;
  readonly turnOrdinal: number;
}

export interface WorkflowBenchmarkParkAcceptedStepInput {
  readonly sampleId?: string;
  readonly sessionId: string;
  readonly turnOrdinal: number;
}

export interface StartWorkflowBenchmarkTurnStepResult {
  readonly runId: string;
}
