import { defineSignal } from "@temporalio/workflow";

import type {
  Delivery,
  EffectCall,
  EffectResult,
  EventLogId,
  ExecutionId,
  SessionCheckpoint,
  SessionId,
  SessionProgramInput,
  StreamEvent,
  TerminalOutcome,
  TurnOutcome,
  TurnProgramInput,
} from "../types.js";

export const TEMPORAL_SESSION_WORKFLOW = "temporalSessionWorkflow";
export const TEMPORAL_TURN_WORKFLOW = "temporalTurnWorkflow";

export const TEMPORAL_DELIVERY_SIGNAL = "eve.loop.delivery";
export const TEMPORAL_CHILD_UPDATE_SIGNAL = "eve.loop.child-update";
export const TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL = "eve.loop.child-acknowledged";

export const temporalDeliverySignal = defineSignal<[Delivery]>(TEMPORAL_DELIVERY_SIGNAL);
export const temporalChildUpdateSignal = defineSignal<
  [{ readonly checkpoint: SessionCheckpoint; readonly childWorkflowId: string }]
>(TEMPORAL_CHILD_UPDATE_SIGNAL);
export const temporalChildAcknowledgedSignal = defineSignal<[number]>(
  TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL,
);

export interface TemporalActivities {
  appendEvent(logId: EventLogId, event: StreamEvent): Promise<void>;
  effect(call: EffectCall): Promise<EffectResult>;
  finish(sessionId: SessionId, outcome: TerminalOutcome): Promise<void>;
}

export interface TemporalSessionWorkflowInput {
  readonly executionId: ExecutionId;
  readonly input: SessionProgramInput;
  readonly kind: "session";
  readonly routingIntent: "pinned";
  readonly taskQueue: string;
  readonly streamLogId: EventLogId;
}

export interface TemporalTurnWorkflowInput {
  readonly executionId: ExecutionId;
  readonly checkpoint: SessionCheckpoint;
  readonly input: TurnProgramInput;
  readonly kind: "turn";
  readonly routingIntent: "latest-compatible";
  readonly taskQueue: string;
  readonly streamLogId: EventLogId;
}

export type TemporalSessionWorkflow = (
  input: TemporalSessionWorkflowInput,
) => Promise<TerminalOutcome>;

export type TemporalTurnWorkflow = (input: TemporalTurnWorkflowInput) => Promise<TurnOutcome>;
