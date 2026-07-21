import { defineSignal } from "@temporalio/workflow";

import type { HookPayload, SessionAuthContext } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import type { DurableStepResult } from "#execution/turn-step-operation.js";

export const TEMPORAL_SESSION_WORKFLOW = "temporalSessionWorkflow";
export const TEMPORAL_TURN_WORKFLOW = "temporalTurnWorkflow";
export const TEMPORAL_LOOP_DELIVERY_SIGNAL = "eve.loop.delivery";

export const temporalLoopDeliverySignal = defineSignal<[unknown]>(TEMPORAL_LOOP_DELIVERY_SIGNAL);

export interface TemporalLoopDelivery {
  readonly auth?: SessionAuthContext | null;
  readonly message: string;
  readonly requestId?: string;
}

export interface TemporalLoopWorkflowInput {
  readonly continuationToken: string;
  readonly initialMessage: string;
  readonly requestId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}

export interface TemporalLoopCreateSessionInput {
  readonly continuationToken: string;
  readonly sessionId: string;
}

export interface TemporalLoopTurnStepInput {
  readonly input: HookPayload | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly stepOrdinal: number;
  readonly turnOrdinal: number;
}

export interface TemporalLoopTurnWorkflowInput {
  readonly input: HookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly turnOrdinal: number;
}

export interface TemporalLoopActivities {
  createSession(
    input: TemporalLoopCreateSessionInput,
  ): Promise<{ readonly state: DurableSessionState }>;
  executeTurnStep(input: TemporalLoopTurnStepInput): Promise<DurableStepResult>;
  rekeySession(input: {
    readonly continuationToken: string;
    readonly sessionId: string;
  }): Promise<void>;
  settleSession(input: { readonly sessionId: string }): Promise<void>;
}

export type TemporalLoopWorkflow = (input: TemporalLoopWorkflowInput) => Promise<void>;

export type TemporalLoopTurnWorkflow = (
  input: TemporalLoopTurnWorkflowInput,
) => Promise<DurableStepResult>;
