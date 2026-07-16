import { z } from "#compiled/zod/index.js";
import type { Event } from "#compiled/@workflow/world/index.js";

const persistedSessionEventSchema = z
  .object({
    data: z.unknown().optional(),
    meta: z
      .object({
        at: z.iso.datetime(),
      })
      .passthrough(),
    type: z.string().min(1),
  })
  .passthrough();

const stepIdentitySchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    turnId: z.string().min(1),
  })
  .passthrough();

const actionsRequestedDataSchema = stepIdentitySchema.extend({
  actions: z.array(
    z
      .object({
        callId: z.string().min(1),
      })
      .passthrough(),
  ),
});

const actionResultDataSchema = z
  .object({
    result: z
      .object({
        callId: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export type PersistedSessionEvent = z.infer<typeof persistedSessionEventSchema>;

export interface DecodedPersistedSessionEvent {
  readonly error?: unknown;
  readonly event?: PersistedSessionEvent;
  readonly source: string;
}

interface SessionTimingState {
  readonly actionStartedAt: Map<string, number>;
  readonly firstOutputSeen: Set<string>;
  readonly stepStartedAt: Map<string, number>;
}

interface WorkflowTimingState {
  runCreatedAt: number | undefined;
  runStartedAt: number | undefined;
  readonly stepCreatedAt: Map<string, number>;
  readonly stepStartedAt: Map<string, number>;
  readonly waitCreatedAt: Map<string, number>;
}

export class SessionEventTiming {
  readonly #stateByRun = new Map<string, SessionTimingState>();

  observe(runId: string, event: PersistedSessionEvent): Readonly<Record<string, number>> {
    const state = this.#stateByRun.get(runId) ?? createSessionTimingState();
    this.#stateByRun.set(runId, state);
    const at = Date.parse(event.meta.at);
    const metrics: Record<string, number> = {};

    if (event.type === "step.started") {
      const identity = stepIdentitySchema.safeParse(event.data);
      if (identity.success) {
        state.stepStartedAt.set(stepKey(identity.data), at);
      }
      return metrics;
    }

    if (event.type === "actions.requested") {
      const data = actionsRequestedDataSchema.safeParse(event.data);
      if (data.success) {
        observeFirstOutput(state, data.data, at, metrics);
        for (const action of data.data.actions) {
          if (!state.actionStartedAt.has(action.callId)) {
            state.actionStartedAt.set(action.callId, at);
          }
        }
      }
      return metrics;
    }

    if (event.type === "action.result") {
      const data = actionResultDataSchema.safeParse(event.data);
      if (data.success) {
        const startedAt = state.actionStartedAt.get(data.data.result.callId);
        if (startedAt !== undefined) {
          metrics.durationMs = nonNegativeDuration(at, startedAt);
          state.actionStartedAt.delete(data.data.result.callId);
        }
      }
      return metrics;
    }

    if (
      event.type === "message.appended" ||
      event.type === "reasoning.appended" ||
      event.type === "result.completed"
    ) {
      const identity = stepIdentitySchema.safeParse(event.data);
      if (identity.success) {
        observeFirstOutput(state, identity.data, at, metrics);
      }
      return metrics;
    }

    if (event.type === "step.completed" || event.type === "step.failed") {
      const identity = stepIdentitySchema.safeParse(event.data);
      if (identity.success) {
        const key = stepKey(identity.data);
        const startedAt = state.stepStartedAt.get(key);
        if (startedAt !== undefined) {
          metrics.durationMs = nonNegativeDuration(at, startedAt);
          state.stepStartedAt.delete(key);
        }
        state.firstOutputSeen.delete(key);
      }
    }
    return metrics;
  }
}

export class WorkflowEventTiming {
  readonly #stateByRun = new Map<string, WorkflowTimingState>();

  observe(event: Event): Readonly<Record<string, number>> {
    const state = this.#stateByRun.get(event.runId) ?? createWorkflowTimingState();
    this.#stateByRun.set(event.runId, state);
    const occurredAt = (event.occurredAt ?? event.createdAt).getTime();
    const metrics: Record<string, number> = {};
    const correlationId = event.correlationId;

    switch (event.eventType) {
      case "run_created":
        state.runCreatedAt = occurredAt;
        break;
      case "run_started":
        if (state.runCreatedAt !== undefined) {
          metrics.queueMs = nonNegativeDuration(occurredAt, state.runCreatedAt);
        }
        state.runStartedAt = occurredAt;
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
        if (state.runStartedAt !== undefined) {
          metrics.durationMs = nonNegativeDuration(occurredAt, state.runStartedAt);
        }
        break;
      case "step_created":
        if (correlationId !== undefined) state.stepCreatedAt.set(correlationId, occurredAt);
        break;
      case "step_started":
        if (correlationId !== undefined) {
          const createdAt = state.stepCreatedAt.get(correlationId);
          if (createdAt !== undefined) {
            metrics.queueMs = nonNegativeDuration(occurredAt, createdAt);
          }
          state.stepStartedAt.set(correlationId, occurredAt);
        }
        break;
      case "step_completed":
      case "step_failed":
        if (correlationId !== undefined) {
          const startedAt = state.stepStartedAt.get(correlationId);
          if (startedAt !== undefined) {
            metrics.durationMs = nonNegativeDuration(occurredAt, startedAt);
          }
        }
        break;
      case "step_retrying":
        if (correlationId !== undefined) state.stepStartedAt.delete(correlationId);
        break;
      case "wait_created":
        if (correlationId !== undefined) state.waitCreatedAt.set(correlationId, occurredAt);
        break;
      case "wait_completed":
        if (correlationId !== undefined) {
          const createdAt = state.waitCreatedAt.get(correlationId);
          if (createdAt !== undefined) metrics.waitMs = nonNegativeDuration(occurredAt, createdAt);
        }
        break;
      case "attr_set":
      case "hook_created":
      case "hook_received":
      case "hook_disposed":
      case "hook_conflict":
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
    return metrics;
  }
}

export function decodePersistedSessionEvent(source: string): DecodedPersistedSessionEvent {
  try {
    const parsed: unknown = JSON.parse(source);
    const result = persistedSessionEventSchema.safeParse(parsed);
    return result.success
      ? { event: result.data, source }
      : { error: z.treeifyError(result.error), source };
  } catch (error) {
    return { error, source };
  }
}

function createSessionTimingState(): SessionTimingState {
  return {
    actionStartedAt: new Map(),
    firstOutputSeen: new Set(),
    stepStartedAt: new Map(),
  };
}

function createWorkflowTimingState(): WorkflowTimingState {
  return {
    runCreatedAt: undefined,
    runStartedAt: undefined,
    stepCreatedAt: new Map(),
    stepStartedAt: new Map(),
    waitCreatedAt: new Map(),
  };
}

function observeFirstOutput(
  state: SessionTimingState,
  identity: z.infer<typeof stepIdentitySchema>,
  at: number,
  metrics: Record<string, number>,
): void {
  const key = stepKey(identity);
  const startedAt = state.stepStartedAt.get(key);
  if (startedAt !== undefined && !state.firstOutputSeen.has(key)) {
    metrics.timeToFirstOutputMs = nonNegativeDuration(at, startedAt);
    state.firstOutputSeen.add(key);
  }
}

function stepKey(identity: z.infer<typeof stepIdentitySchema>): string {
  return `${identity.turnId}:${String(identity.stepIndex)}`;
}

function nonNegativeDuration(end: number, start: number): number {
  return Math.max(0, end - start);
}
