import { describe, expect, it, vi } from "vitest";

import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
  DEFAULT_SUBAGENT_MAX_INPUT_TOKENS_PER_SESSION,
} from "#execution/session.js";
import {
  createSessionOperation,
  type CreateSessionOperationInput,
} from "#execution/session-operation.js";
import { createSessionStep } from "#execution/create-session-step.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

const TestTurnAgent: RuntimeTurnAgent = {
  id: "test-agent",
  instructions: ["You are a test assistant."],
  model: { id: "test-model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

describe("createSessionStep", () => {
  it("returns the same initial durable state as the direct session operation", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          compaction: { thresholdPercent: 0.75 },
          limits: {
            maxInputTokensPerSession: 200_000,
            maxOutputTokensPerSession: 20_000,
            maxSubagentDepth: 4,
          },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const input = {
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      outputSchema: {
        properties: { answer: { type: "string" } },
        required: ["answer"],
        type: "object",
      },
      rootSessionId: "sess-root",
      sessionId: "sess-child",
      subagentDepth: 1,
    } satisfies CreateSessionOperationInput;

    const direct = await createSessionOperation(input);
    const stepped = await createSessionStep(input);

    expect(stepped).toEqual(direct);
  });

  it("defaults root sessions to the root input token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {},
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(
      DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
    );
  });

  it("defaults delegated subagent sessions to the subagent input token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {},
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(
      DEFAULT_SUBAGENT_MAX_INPUT_TOKENS_PER_SESSION,
    );
  });

  it("seeds session token limits from resolved agent config", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: {
            maxInputTokensPerSession: 200_000,
            maxOutputTokensPerSession: 20_000,
          },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.limits).toMatchObject({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
  });

  it("seeds subagent max depth from resolved agent config", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: { maxSubagentDepth: 4 },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.subagentMaxDepth).toBe(4);
  });

  it("keeps inherited subagent max depth when one is provided", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: { maxSubagentDepth: 2 },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      sessionId: "sess-child",
      subagentMaxDepth: 4,
    });

    expect(state.snapshot?.session.subagentMaxDepth).toBe(4);
  });
});
