import {
  Client,
  ClientError,
  type ClientSession,
  type HandleMessageStreamEvent,
  type SendTurnPayload,
  type SessionState,
} from "#client/index.js";
import { collectTurnEvents, summarizeTurnEvents } from "#client/session-utils.js";
import { resolveLocalDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { resolveLinkedDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import type { DevelopmentTarget } from "#services/dev-client/target.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import { resolveVerifiedRemoteDevelopmentClient } from "#setup/verified-remote-client.js";

import { type InvokeResult, type InvokeResume, type InvokeSessionCursor } from "./result.js";

export type InvokeOperation =
  | { readonly kind: "send"; readonly payload: SendTurnPayload; readonly resume?: InvokeResume }
  | { readonly kind: "follow"; readonly resume: InvokeResume };

export interface RunInvokeInput {
  readonly headers?: Readonly<Record<string, string>>;
  readonly operation: InvokeOperation;
  readonly signal?: AbortSignal;
  readonly target: DevelopmentTarget;
  readonly wait: boolean;
}

/** Runs one non-interactive eve invocation. */
export async function runInvoke(input: RunInvokeInput): Promise<InvokeResult> {
  const client = await createInvokeClient(input);
  const resume = input.operation.resume;
  const session = client.session(resume?.session);

  if (input.operation.kind === "follow") {
    return input.wait
      ? observeSafely(input, session, session.stream({ signal: input.signal }))
      : runningResult(input.target, session.state);
  }

  let response: Awaited<ReturnType<ClientSession["send"]>>;
  try {
    response = await session.send({ ...input.operation.payload, signal: input.signal });
  } catch (error) {
    const authentication = authenticationFailure(error);
    if (authentication !== undefined) return authentication;
    throw error;
  }

  if (!input.wait) {
    const state = { ...session.state };
    if (response.continuationToken !== undefined) {
      state.continuationToken = response.continuationToken;
    }
    return runningResult(input.target, state);
  }
  return observeSafely(input, session, response);
}

/** Converts a prompt and optional previous result into one valid invoke operation. */
export function resolveInvokeOperation(input: {
  readonly prompt?: string;
  readonly previous?: InvokeResult & { resume: InvokeResume };
}): InvokeOperation {
  const prompt = input.prompt?.trim();
  const previous = input.previous;
  if (previous === undefined) {
    if (!prompt) throw new Error("eve invoke requires a prompt unless --resume is provided.");
    return { kind: "send", payload: { message: prompt } };
  }

  if (previous.status === "input-required") {
    if (!prompt) throw new Error("This invocation is waiting for an input response.");
    return { kind: "send", payload: { message: prompt }, resume: previous.resume };
  }

  if (
    previous.status === "running" ||
    previous.status === "authorization-required" ||
    previous.status === "authentication-required"
  ) {
    if (prompt) {
      throw new Error(
        previous.status === "running"
          ? "A running invocation cannot accept a follow-up prompt."
          : "Complete the requested authorization, then resume without a prompt.",
      );
    }
    return { kind: "follow", resume: previous.resume };
  }

  if (!prompt) throw new Error("A completed invocation requires a follow-up prompt.");
  return { kind: "send", payload: { message: prompt }, resume: previous.resume };
}

async function createInvokeClient(input: RunInvokeInput): Promise<Client> {
  if (input.target.kind === "local") {
    return new Client({
      ...resolveLocalDevelopmentClientOptions({
        headers: input.headers,
        serverUrl: input.target.serverUrl,
        token: () => resolveLinkedDevelopmentOidcToken(input.target.workspaceRoot),
      }),
      preserveCompletedSessions: true,
    });
  }

  const { options } = await resolveVerifiedRemoteDevelopmentClient({
    headers: input.headers,
    serverUrl: input.target.serverUrl,
    signal: input.signal,
    workspaceRoot: input.target.workspaceRoot,
  });
  return new Client({ ...options, preserveCompletedSessions: true });
}

async function observeSafely(
  input: RunInvokeInput,
  session: ClientSession,
  response: AsyncIterable<HandleMessageStreamEvent>,
): Promise<InvokeResult> {
  try {
    return await observeInvocation(input.target, session, response);
  } catch (error) {
    if (input.signal?.aborted === true) return runningResult(input.target, session.state);
    const authentication = authenticationFailure(error, createResume(input.target, session.state));
    if (authentication !== undefined) return authentication;
    throw error;
  }
}

async function observeInvocation(
  target: DevelopmentTarget,
  session: ClientSession,
  response: AsyncIterable<HandleMessageStreamEvent>,
): Promise<InvokeResult> {
  const summary = summarizeTurnEvents(await collectTurnEvents(response));
  if (summary.boundary === undefined) return runningResult(target, session.state);
  if (summary.boundary.type === "session.failed") {
    return { status: "failed", message: summary.boundary.data.message };
  }

  const resume = createResume(target, session.state);
  if (summary.failure?.type === "turn.failed") {
    return { status: "failed", message: summary.failure.data.message, resume };
  }
  if (summary.inputRequests.length > 0) {
    return { status: "input-required", requests: summary.inputRequests, resume };
  }

  const authorizations = summary.pendingAuthorizations;
  if (authorizations.length > 0) {
    if (
      target.kind === "local" &&
      authorizations.some((authorization) => authorization.webhookUrl !== undefined)
    ) {
      return {
        status: "failed",
        message:
          "Local eve invoke cannot pause for connection authorization because its temporary server must remain available for the callback. Run eve dev, then invoke its URL with --url.",
      };
    }
    return { status: "authorization-required", authorizations, resume };
  }

  const result: Writable<Extract<InvokeResult, { status: "completed" }>> = {
    status: "completed",
    resume,
  };
  if (summary.message !== undefined) result.message = summary.message;
  return result;
}

function runningResult(target: DevelopmentTarget, state: SessionState): InvokeResult {
  return { status: "running", resume: createResume(target, state) };
}

function createResume(target: DevelopmentTarget, session: SessionState): InvokeResume {
  if (session.sessionId === undefined) throw new Error("Invocation has no resumable session ID.");
  const cursor: Writable<InvokeSessionCursor> = {
    sessionId: session.sessionId,
    streamIndex: session.streamIndex,
  };
  if (session.continuationToken !== undefined) cursor.continuationToken = session.continuationToken;
  return {
    session: cursor,
    target:
      target.kind === "local" ? { kind: "local" } : { kind: "remote", serverUrl: target.serverUrl },
  };
}

function authenticationFailure(error: unknown, resume?: InvokeResume): InvokeResult | undefined {
  let message: string | undefined;
  let code: string | undefined;
  if (isVercelAuthChallenge(error)) {
    message =
      "Vercel Deployment Protection rejected the available credentials. Configure Trusted Sources or set VERCEL_AUTOMATION_BYPASS_SECRET, then retry.";
  } else if (error instanceof ClientError) {
    code = vercelTrustedSourcesErrorCode(error.message);
    if (error.status === 403 && code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH") {
      message = formatVercelTrustedSourcesFailure(error.message);
    } else if (isEveAuthorizationError(error)) {
      message =
        "The deployment rejected the available credentials. Confirm its eve channel authorization and that your account can access the owning project.";
    }
  }
  if (message === undefined) return undefined;
  const result: Writable<Extract<InvokeResult, { status: "authentication-required" }>> = {
    status: "authentication-required",
    message,
  };
  if (code !== undefined) result.code = code;
  if (resume !== undefined) result.resume = resume;
  return result;
}

function isEveAuthorizationError(error: ClientError): boolean {
  if (error.status !== 401) return false;
  try {
    const payload = JSON.parse(error.body) as Record<string, unknown>;
    return (
      payload.ok === false &&
      payload.code === "unauthorized" &&
      payload.error === "Authorization is required for this route."
    );
  } catch {
    return false;
  }
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
