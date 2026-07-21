import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import type { CreateSessionOperationInput } from "#execution/session-operation.js";
import type { DurableStepResult, TurnStepOperationInput } from "#execution/turn-step-operation.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

export interface WorkflowLoopSessionInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly initialDelivery: DeliverHookPayload;
  readonly nodeId?: string;
  readonly serializedContext: Record<string, unknown>;
}

export interface WorkflowLoopTurnInput {
  readonly initialInput: HookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly settledToken: string;
  readonly turnOrdinal: number;
}

type ContinueOrDoneResult = Extract<DurableStepResult, { readonly action: "continue" | "done" }>;

export type WorkflowLoopDoneResult = Omit<ContinueOrDoneResult, "action"> & {
  readonly action: "done";
};

export type WorkflowLoopParkResult = Extract<DurableStepResult, { readonly action: "park" }>;

export type WorkflowLoopTurnResult = WorkflowLoopDoneResult | WorkflowLoopParkResult;

export interface WorkflowLoopChildSettled {
  readonly kind: "turn-settled";
  readonly runId: string;
  readonly turnOrdinal: number;
}

export interface CreateWorkflowLoopSessionStepInput extends CreateSessionOperationInput {}

export interface ExecuteWorkflowLoopTurnStepInput extends Pick<
  TurnStepOperationInput,
  "input" | "serializedContext" | "sessionState"
> {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly stepOrdinal: number;
  readonly turnOrdinal: number;
}

export interface StartWorkflowLoopTurnStepResult {
  readonly runId: string;
}
