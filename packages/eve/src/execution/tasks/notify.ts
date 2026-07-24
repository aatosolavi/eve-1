/**
 * Guarded task-notification fan-out.
 *
 * One POST per routed endpoint per transition, each endpoint guarded
 * independently: a gone subscriber (HTTP 404 from the callback route)
 * is marked dead and never retried; any other delivery failure is
 * logged and dropped. A notification send never throws — delivery is
 * best-effort and must never fail the task (unlike the terminal
 * session callback, which throws to hand retry to the orchestrator).
 */
import { createLogger } from "#internal/logging.js";
import { DEFAULT_NOTIFICATION_ROUTES, type TaskNotification } from "#runtime/tasks/types.js";
import type { StoredNotificationEndpoint } from "#execution/tasks/store.js";

const TASK_NOTIFY_TIMEOUT_MS = 30_000;
const log = createLogger("execution.task-notify");

/**
 * Delivers one notification to every live, routed endpoint.
 *
 * Returns the endpoint list with delivery state updated (gone
 * subscribers marked `dead`); the caller persists it on the next
 * record snapshot.
 */
export async function notifyTaskEndpoints(input: {
  readonly endpoints: readonly StoredNotificationEndpoint[];
  readonly notification: TaskNotification;
}): Promise<readonly StoredNotificationEndpoint[]> {
  const results: StoredNotificationEndpoint[] = [];

  for (const endpoint of input.endpoints) {
    if (endpoint.dead === true) {
      results.push(endpoint);
      continue;
    }

    const routes = endpoint.routes ?? DEFAULT_NOTIFICATION_ROUTES;
    if (!routes.includes(input.notification.kind)) {
      results.push(endpoint);
      continue;
    }

    results.push(await deliver(endpoint, input.notification));
  }

  return results;
}

async function deliver(
  endpoint: StoredNotificationEndpoint,
  notification: TaskNotification,
): Promise<StoredNotificationEndpoint> {
  try {
    const response = await fetch(endpoint.url, {
      body: JSON.stringify(notification),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      // Do not follow redirects: a callback host could otherwise
      // 3xx-bounce the framework to an internal/metadata address.
      redirect: "error",
      signal: AbortSignal.timeout(TASK_NOTIFY_TIMEOUT_MS),
    });

    if (response.status === 404) {
      // The callback route answers 404 when the hook behind the token is
      // gone — the subscriber no longer exists. Mark dead, never retry.
      log.debug("task notification endpoint gone; marking dead", {
        kind: notification.kind,
        taskId: notification.task.taskId,
      });
      return { ...endpoint, dead: true };
    }

    if (!response.ok) {
      log.warn("task notification delivery failed; dropping", {
        kind: notification.kind,
        status: response.status,
        taskId: notification.task.taskId,
      });
    }

    return endpoint;
  } catch (error) {
    log.warn("task notification delivery failed; dropping", {
      error,
      kind: notification.kind,
      taskId: notification.task.taskId,
    });
    return endpoint;
  }
}
