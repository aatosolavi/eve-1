import type { HarnessSession } from "#core/step-types.js";
import type { WorkflowSandboxContinuationSecurity } from "#core/workflow-sandbox-module.js";

const WORKFLOW_CONTINUATION_SECURITY_KEY = "eve.harness.workflowContinuationSecurity";
const WORKFLOW_CONTINUATION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

interface StoredWorkflowContinuationSecurity {
  readonly signingKey: string;
  readonly version: 1;
}

export function ensureWorkflowContinuationSecurity(session: HarnessSession): HarnessSession {
  if (session.state?.[WORKFLOW_CONTINUATION_SECURITY_KEY] !== undefined) {
    getWorkflowContinuationSecurity(session);
    return session;
  }

  return {
    ...session,
    state: {
      ...session.state,
      [WORKFLOW_CONTINUATION_SECURITY_KEY]: {
        signingKey: createSigningKey(),
        version: 1,
      } satisfies StoredWorkflowContinuationSecurity,
    },
  };
}

function createSigningKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    encoded += alphabet[(value >> 18) & 63];
    encoded += alphabet[(value >> 12) & 63];
    if (second !== undefined) encoded += alphabet[(value >> 6) & 63];
    if (third !== undefined) encoded += alphabet[value & 63];
  }

  return encoded;
}

export function readWorkflowContinuationSecurity(
  session: HarnessSession,
): WorkflowSandboxContinuationSecurity | undefined {
  const stored = session.state?.[WORKFLOW_CONTINUATION_SECURITY_KEY];
  if (
    typeof stored !== "object" ||
    stored === null ||
    (stored as { version?: unknown }).version !== 1 ||
    typeof (stored as { signingKey?: unknown }).signingKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test((stored as { signingKey: string }).signingKey)
  ) {
    return undefined;
  }

  return {
    signingKey: (stored as StoredWorkflowContinuationSecurity).signingKey,
    // A parked workflow can legitimately wait far beyond code mode's one-hour default.
    maxAgeMs: WORKFLOW_CONTINUATION_MAX_AGE_MS,
  };
}

export function getWorkflowContinuationSecurity(
  session: HarnessSession,
): WorkflowSandboxContinuationSecurity {
  const security = readWorkflowContinuationSecurity(session);
  if (security === undefined) {
    throw new Error("Workflow continuation security state is missing or invalid.");
  }
  return security;
}
