import { contextStorage } from "#context/container.js";
import { SessionLogIdKey } from "#context/keys.js";
import {
  areSessionLogsEnabled,
  DEVELOPMENT_SESSION_LOG_ROUTE,
  type DevelopmentSessionLogEvent,
} from "#internal/session-logs/protocol.js";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";
import { encodeDevelopmentWorldValue } from "#internal/workflow/development-world-codec.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
const MAX_BATCH_SIZE = 256;

let pendingEvents: DevelopmentSessionLogEvent[] = [];
let pendingWrite: Promise<void> | undefined;

export function readActiveSessionLogId(): string | undefined {
  return contextStorage.getStore()?.get(SessionLogIdKey);
}

/**
 * Queues one best-effort event for the parent-owned development log writer.
 * Diagnostics must never make the behavior being diagnosed fail.
 */
export function writeDevelopmentSessionLog(event: DevelopmentSessionLogEvent): Promise<void> {
  if (!canWriteDevelopmentSessionLogs()) {
    return Promise.resolve();
  }

  pendingEvents.push(event);
  return scheduleDrain();
}

export function flushDevelopmentSessionLogs(): Promise<void> {
  return pendingWrite ?? (pendingEvents.length === 0 ? Promise.resolve() : scheduleDrain());
}

export function canWriteDevelopmentSessionLogs(): boolean {
  return (
    areSessionLogsEnabled() &&
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
        // A recorder failure must not alter model, tool, or sandbox behavior.
      }
    }
  } finally {
    pendingWrite = undefined;
    if (pendingEvents.length > 0) void scheduleDrain();
  }
}

async function postEvents(events: readonly DevelopmentSessionLogEvent[]): Promise<void> {
  const baseUrl = process.env[WORKFLOW_LOCAL_BASE_URL_ENV];
  const secret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  if (baseUrl === undefined || secret === undefined) {
    return;
  }

  const url = new URL(DEVELOPMENT_SESSION_LOG_ROUTE, baseUrl);
  const response = await fetch(url, {
    body: encodeDevelopmentWorldValue({ events }),
    headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: secret },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Development session log write failed (${String(response.status)}).`);
  }
}
