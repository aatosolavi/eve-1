/**
 * Routing-step discrimination for task-notification deliver payloads.
 *
 * A notification never wakes the model directly; the two arms mirror
 * the driver's existing routing outcomes:
 *
 * - **terminal** (`completed` | `failed` | `cancelled`) — kept on the
 *   remainder, so the caller runs a turn with the outcome as input.
 * - **`input_required`** — consumed here: the record's live requests
 *   are re-emitted on the parent stream as `input.requested` without
 *   running a turn (the driver-level analog of the turn-level subagent
 *   HITL proxy). The eventual answer routes back through the step-0
 *   late-response check (`tasks/update` semantics).
 *
 * Everything else (`task.created`, `task.progress`, non-wake status
 * changes) is consumed silently. Notifications for unknown tasks — not
 * on the session's live-task index — are dropped, as are deliveries
 * whose authenticated principal mismatches the task's creator.
 */
import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import {
  splitTaskNotifications,
  TASK_NOTIFICATIONS_PAYLOAD_KEY,
} from "#execution/tasks/delivery.js";
import { updateTask, type TaskHandle } from "#execution/tasks/service.js";
import { readTaskRecord } from "#execution/tasks/store.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { getLiveTasks } from "#harness/task-state.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import { createLogger } from "#internal/logging.js";
import {
  createInputRequestedEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { isTerminalStatus, type TaskNotification } from "#runtime/tasks/types.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.task-routing");

/**
 * Discriminates the task notifications on a payload and returns the
 * parent-local remainder (`undefined` when nothing actionable is left —
 * the caller's existing no-turn arm).
 */
export async function routeTaskNotifications(input: {
  readonly auth?: SessionAuthContext | null;
  readonly durableSession: DurableSession;
  readonly emissionState: HarnessEmissionState;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly serializedContext?: Record<string, unknown>;
}): Promise<DeliverPayload | undefined> {
  const { notifications, rest } = splitTaskNotifications(input.payload);
  const liveTasks = getLiveTasks(input.durableSession.state);
  const kept: TaskNotification[] = [];

  for (const notification of notifications) {
    const taskRunId = liveTasks.get(notification.task.taskId);
    if (taskRunId === undefined) {
      log.debug("dropping notification for unknown task", {
        kind: notification.kind,
        taskId: notification.task.taskId,
      });
      continue;
    }

    if (!(await deliveryPrincipalMatches({ auth: input.auth, taskRunId }))) {
      log.warn("dropping cross-principal task delivery", {
        kind: notification.kind,
        taskId: notification.task.taskId,
      });
      continue;
    }

    if (isTerminalStatus(notification.task.status)) {
      kept.push(notification);
      continue;
    }

    if (notification.task.status === "input_required") {
      await emitTaskInputRequested({
        emissionState: input.emissionState,
        notification,
        parentWritable: input.parentWritable,
        serializedContext: input.serializedContext,
      });
      continue;
    }

    // task.created / task.progress / non-wake status changes carry no
    // parent-local action; the record already holds the state.
  }

  if (kept.length === 0) {
    return rest;
  }
  return { ...rest, [TASK_NOTIFICATIONS_PAYLOAD_KEY]: kept };
}

/**
 * Step-0 late-response routing (`tasks/update` semantics): responses
 * whose `requestId` matches a live `input_required` task's inline
 * requests route to `updateTask` and never reach the model step — so
 * they run before stale conversion by construction, and a late answer
 * executes instead of degrading to advisory text. Everything else is
 * returned for today's paths unchanged.
 */
export async function routeLateResponsesToLiveTasks(input: {
  readonly inputResponses: readonly InputResponse[];
  readonly state: SessionStateMap | undefined;
}): Promise<{ readonly remaining: readonly InputResponse[] }> {
  const liveTasks = getLiveTasks(input.state);
  if (liveTasks.size === 0 || input.inputResponses.length === 0) {
    return { remaining: input.inputResponses };
  }

  const handleByRequestId = new Map<string, TaskHandle>();
  for (const [taskId, taskRunId] of liveTasks) {
    const record = await readTaskRecord({ taskRunId });
    if (record.task.status !== "input_required") {
      continue;
    }
    for (const request of record.task.inputRequests) {
      handleByRequestId.set(request.requestId, { taskId, taskRunId });
    }
  }

  const remaining: InputResponse[] = [];
  const routed = new Map<string, { handle: TaskHandle; responses: InputResponse[] }>();
  for (const response of input.inputResponses) {
    const handle = handleByRequestId.get(response.requestId);
    if (handle === undefined) {
      remaining.push(response);
      continue;
    }
    const group = routed.get(handle.taskId);
    if (group === undefined) {
      routed.set(handle.taskId, { handle, responses: [response] });
    } else {
      group.responses.push(response);
    }
  }

  for (const group of routed.values()) {
    try {
      await updateTask(group.handle, group.responses);
    } catch (error) {
      // The task settled or left input_required between read and send;
      // fall back to today's stale path for these responses.
      log.warn("late response routing failed; falling back to stale path", {
        error,
        taskId: group.handle.taskId,
      });
      remaining.push(...group.responses);
    }
  }

  return { remaining };
}

/**
 * Tasks are bound to the auth context that created them: an
 * authenticated delivery must match the creator's principal. Loopback
 * notification POSTs carry no auth and pass — forgery through public
 * channels is blocked upstream by ingress sanitization.
 */
async function deliveryPrincipalMatches(input: {
  readonly auth?: SessionAuthContext | null;
  readonly taskRunId: string;
}): Promise<boolean> {
  if (input.auth === undefined || input.auth === null) {
    return true;
  }
  const record = await readTaskRecord({ taskRunId: input.taskRunId });
  if (record.createdBy === undefined || record.createdBy === null) {
    return true;
  }
  return record.createdBy.principalId === input.auth.principalId;
}

/**
 * Re-emits an `input_required` task's live requests on the parent
 * stream as the session's own `input.requested`, through the channel
 * adapter when a context is available. Coordinates come from the
 * session's emission state — no turn runs and no state advances.
 */
async function emitTaskInputRequested(input: {
  readonly emissionState: HarnessEmissionState;
  readonly notification: TaskNotification;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext?: Record<string, unknown>;
}): Promise<void> {
  const task = input.notification.task;
  if (task.status !== "input_required" || task.inputRequests.length === 0) {
    return;
  }

  const event = createInputRequestedEvent({
    requests: task.inputRequests,
    sequence: input.emissionState.sequence,
    stepIndex: input.emissionState.stepIndex,
    turnId: input.emissionState.turnId,
  });

  const writer = input.parentWritable.getWriter();
  try {
    if (input.serializedContext === undefined) {
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event)));
      return;
    }
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.require(ChannelKey);
    const adapterCtx = buildAdapterContext(adapter, ctx);
    const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
    await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
  } finally {
    writer.releaseLock();
  }
}
