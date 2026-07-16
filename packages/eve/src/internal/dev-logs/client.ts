import {
  areDevelopmentLogsEnabled,
  DEVELOPMENT_LOG_ROUTE,
  type DevelopmentLogEvent,
} from "#internal/dev-logs/protocol.js";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";
import { encodeDevelopmentWorldValue } from "#internal/workflow/development-world-codec.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const MAX_BATCH_SIZE = 256;

let pendingEvents: DevelopmentLogEvent[] = [];
let pendingWrite: Promise<void> | undefined;

/** Queues one best-effort event for the parent-owned development log. */
export function writeDevelopmentLog(event: DevelopmentLogEvent): Promise<void> {
  if (!canWriteDevelopmentLogs()) return Promise.resolve();
  pendingEvents.push(event);
  return scheduleDrain();
}

export function flushDevelopmentLogs(): Promise<void> {
  return pendingWrite ?? (pendingEvents.length === 0 ? Promise.resolve() : scheduleDrain());
}

export function canWriteDevelopmentLogs(): boolean {
  return (
    areDevelopmentLogsEnabled() &&
    typeof process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] === "string" &&
    typeof process.env[WORKFLOW_LOCAL_BASE_URL_ENV] === "string"
  );
}

function scheduleDrain(): Promise<void> {
  pendingWrite ??= Promise.resolve().then(drainPendingEvents);
  return pendingWrite;
}

async function drainPendingEvents(): Promise<void> {
  try {
    while (pendingEvents.length > 0) {
      const events = pendingEvents.splice(0, MAX_BATCH_SIZE);
      try {
        await postEvents(events);
      } catch {
        // Diagnostics must not alter the behavior being diagnosed.
      }
    }
  } finally {
    pendingWrite = undefined;
    if (pendingEvents.length > 0) void scheduleDrain();
  }
}

async function postEvents(events: readonly DevelopmentLogEvent[]): Promise<void> {
  const baseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
  const secret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  if (baseUrl === undefined || secret === undefined) return;

  const response = await fetch(new URL(DEVELOPMENT_LOG_ROUTE, baseUrl), {
    body: encodeDevelopmentWorldValue({ events }),
    headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: secret },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Development log write failed (${String(response.status)}).`);
  }
}
