import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  AgentInvocationService,
  type AgentInvocation,
  type AgentInvocationBackend,
  type AgentInvocationMutationResult,
} from "#internal/invocation/agent-invocation-service.js";
import type { InputResponse } from "#runtime/input/types.js";

const alice = auth("alice");
const bob = auth("bob");

class MemoryBackend implements AgentInvocationBackend {
  readonly records = new Map<string, AgentInvocation>();
  readonly createAuth: SessionAuthContext[] = [];
  creates = 0;

  async create(input: Parameters<AgentInvocationBackend["create"]>[0]): Promise<AgentInvocation> {
    this.createAuth.push(input.auth);
    this.creates++;
    const invocation = {
      invocationId: `inv_${this.creates}`,
      status: "working" as const,
    };
    this.records.set(invocation.invocationId, invocation);
    return invocation;
  }

  async read(input: { invocationId: string }): Promise<AgentInvocation | undefined> {
    return this.records.get(input.invocationId);
  }

  async update(input: {
    invocationId: string;
    responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = this.records.get(input.invocationId);
    if (!current) return { type: "not_found" };
    if (current.status !== "input_required") {
      return {
        message: `Invocation is ${current.status}, not waiting for input`,
        type: "conflict",
      };
    }
    const updated: AgentInvocation = { invocationId: current.invocationId, status: "working" };
    this.records.set(input.invocationId, updated);
    return { invocation: updated, type: "success" };
  }

  setInvocationState(invocationId: string, state: AgentInvocation) {
    if (this.records.has(invocationId)) this.records.set(invocationId, state);
  }
}

describe("AgentInvocationService", () => {
  it("binds caller auth when creating an invocation", async () => {
    const backend = new MemoryBackend();
    const aliceClient = new AgentInvocationService(backend).forCaller(alice);
    const invocation = await aliceClient.create({ message: "work" });
    await aliceClient.read({ invocationId: invocation.invocationId });

    expect(backend.createAuth).toEqual([alice]);
  });

  it("creates new invocations without idempotency", async () => {
    const backend = new MemoryBackend();
    const client = new AgentInvocationService(backend).forCaller(alice);
    const first = await client.create({ message: "work" });
    const second = await client.create({ message: "work" });
    expect(second.invocationId).not.toBe(first.invocationId);
    expect(backend.creates).toBe(2);
  });

  it("allows another authorized principal to use an invocation handle", async () => {
    const backend = new MemoryBackend();
    const service = new AgentInvocationService(backend);
    const invocation = await service.forCaller(alice).create({ message: "work" });

    await expect(
      service.forCaller(bob).read({ invocationId: invocation.invocationId }),
    ).resolves.toEqual(invocation);
  });

  it("handles input requests and updates", async () => {
    const backend = new MemoryBackend();
    const client = new AgentInvocationService(backend).forCaller(alice);
    const invocation = await client.create({ message: "work" });

    backend.setInvocationState(invocation.invocationId, {
      invocationId: invocation.invocationId,
      inputRequests: [
        {
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Proceed?",
          requestId: "question",
        },
      ],
      status: "input_required",
    });

    await expect(client.read({ invocationId: invocation.invocationId })).resolves.toMatchObject({
      inputRequests: [{ prompt: "Proceed?" }],
      status: "input_required",
    });
    await client.update({
      invocationId: invocation.invocationId,
      responses: [{ optionId: "yes", requestId: "question" }],
    });
    await expect(client.read({ invocationId: invocation.invocationId })).resolves.toMatchObject({
      status: "working",
    });
  });
});

function auth(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}
