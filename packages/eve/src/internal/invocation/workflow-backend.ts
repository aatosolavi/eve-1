import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { RunInput, Runtime, SessionAuthContext } from "#channel/types.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import {
  AgentInvocationService,
  type AgentInvocation,
  type AgentInvocationBackend,
  type AgentInvocationMutationResult,
} from "#internal/invocation/agent-invocation-service.js";
import {
  createCompletedAgentInvocation,
  createFailedAgentInvocation,
  createWorkingAgentInvocation,
  projectActiveWorkflowInvocation,
} from "#internal/invocation/workflow-snapshot.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";

export interface WorkflowAgentInvocationBackendOptions {
  readonly adapter: RunInput["adapter"];
  readonly channelName: string;
  readonly requestId?: string;
  readonly runtime: Runtime;
}

export function createWorkflowAgentInvocationService(
  options: WorkflowAgentInvocationBackendOptions,
): AgentInvocationService {
  return new AgentInvocationService(new WorkflowAgentInvocationBackend(options));
}

export class WorkflowAgentInvocationBackend implements AgentInvocationBackend {
  readonly #options: WorkflowAgentInvocationBackendOptions;

  constructor(options: WorkflowAgentInvocationBackendOptions) {
    this.#options = options;
  }

  async create(input: {
    readonly auth: SessionAuthContext;
    readonly message: string;
    readonly outputSchema?: JsonObject;
  }): Promise<AgentInvocation> {
    const continuationToken = `${this.#options.channelName}:invocation:${crypto.randomUUID()}`;
    const handle = await this.#options.runtime.run({
      adapter: this.#options.adapter,
      auth: input.auth,
      capabilities: { requestInput: true },
      channelName: this.#options.channelName,
      continuationToken,
      input: { message: input.message, outputSchema: input.outputSchema },
      mode: "task",
      requestId: this.#options.requestId,
    });

    return createWorkingAgentInvocation(handle.sessionId);
  }

  async read(input: { readonly invocationId: string }): Promise<AgentInvocation | undefined> {
    const run = await this.#readInvocationRun(input.invocationId);
    if (run === undefined) return undefined;

    if (isTerminalStatus(run.status)) {
      return await terminalInvocation(run);
    }
    const events = await readPersistedEvents(input.invocationId);
    return projectActiveWorkflowInvocation({ events, invocationId: run.runId });
  }

  async update(input: {
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = await this.read(input);
    if (current === undefined) return { type: "not_found" };
    if (current.status !== "input_required") {
      return conflict("Invocation is not waiting for input.");
    }
    const requestIds = new Set(current.inputRequests.map((request) => request.requestId));
    for (const response of input.responses) {
      if (!requestIds.has(response.requestId)) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
    }

    const run = await this.#readInvocationRun(input.invocationId);
    const token =
      run === undefined
        ? undefined
        : readInvocationContinuationToken(run, this.#options.channelName);
    if (token === undefined) return { type: "not_found" };
    try {
      await this.#options.runtime.deliver({
        continuationToken: token,
        payload: { inputResponses: input.responses },
        requestId: this.#options.requestId,
      });
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      throw error;
    }

    const invocation = await this.read(input);
    return invocation === undefined ? { type: "not_found" } : { invocation, type: "success" };
  }

  async #readInvocationRun(invocationId: string) {
    const world = await getWorld();
    try {
      const run = await world.runs.get(invocationId);
      return readInvocationContinuationToken(run, this.#options.channelName) === undefined
        ? undefined
        : run;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
  }
}

function readInvocationContinuationToken(
  run: { readonly input?: unknown },
  channelName: string,
): string | undefined {
  if (!Array.isArray(run.input)) return undefined;
  const entryInput = run.input[0];
  if (typeof entryInput !== "object" || entryInput === null || Array.isArray(entryInput)) {
    return undefined;
  }
  const context = (entryInput as { readonly serializedContext?: unknown }).serializedContext;
  if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined;
  const token = (context as Record<string, unknown>)["eve.continuationToken"];
  return typeof token === "string" && token.startsWith(`${channelName}:invocation:`)
    ? token
    : undefined;
}

async function readPersistedEvents(invocationId: string): Promise<HandleMessageStreamEvent[]> {
  const readable = getRun(invocationId).getReadable<Uint8Array>({ startIndex: 0 });
  const tailIndex = await readable.getTailIndex();
  if (tailIndex < 0) {
    await readable.cancel("invocation event stream is empty").catch(() => {});
    return [];
  }

  const events: HandleMessageStreamEvent[] = [];
  const stream = parseNdjsonStream<HandleMessageStreamEvent>(() => readable);
  for await (const event of stream) {
    events.push(event);
    if (events.length > tailIndex) break;
  }
  return events;
}

async function terminalInvocation(run: {
  readonly error?: unknown;
  readonly runId: string;
  readonly status: string;
}): Promise<AgentInvocation> {
  if (run.status === "cancelled") {
    return { invocationId: run.runId, status: "cancelled" };
  }
  if (run.status === "failed") {
    return createFailedAgentInvocation({ error: run.error, invocationId: run.runId });
  }
  const returned = await getRun<{ readonly output: unknown }>(run.runId).returnValue;
  return createCompletedAgentInvocation({ invocationId: run.runId, result: returned.output });
}

function conflict(message: string): AgentInvocationMutationResult {
  return { message, type: "conflict" };
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
