import { describe, expect, it, vi } from "vitest";

import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
} from "#execution/session.js";
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
  it("applies the root session defaults", async () => {
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

    expect(state.snapshot?.session.limits?.maxConsecutiveToolErrors).toBe(
      DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    );
    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(
      DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
    );
  });

  it("limits delegated subagent sessions to the inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {},
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 3_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits).toEqual({
      maxConsecutiveToolErrors: DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
      maxInputTokensPerSession: 3_000_000,
    });
  });

  it("leaves delegated token axes uncapped with uncapped inherited axes", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {},
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: false, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits).toEqual({
      maxConsecutiveToolErrors: DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    });
  });

  it("caps configured child token limits at the inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: { maxInputTokensPerSession: 10_000_000 },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 2_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(2_000_000);
  });

  it("keeps tighter configured child token limits under inherited token budget", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: { maxInputTokensPerSession: 1_000_000 },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 2_000_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(1_000_000);
  });

  it("still applies inherited token budget when configured child limit is false", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: { maxInputTokensPerSession: false },
        },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "subagent:test",
      inheritedLimits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
    });

    expect(state.snapshot?.session.limits?.maxInputTokensPerSession).toBe(500_000);
  });

  it("seeds session limits from resolved agent config", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {
          limits: {
            maxConsecutiveToolErrors: 4,
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
      maxConsecutiveToolErrors: 4,
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
  });

  it("seeds workflow max subagents from the authored Workflow tool", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      resolvedAgent: {
        config: {},
        workflowTool: { maxSubagents: 5 },
      },
      turnAgent: TestTurnAgent,
    } as never);

    const { state } = await createSessionStep({
      compiledArtifactsSource: { kind: "bundled" },
      continuationToken: "http:test",
      sessionId: "sess-root",
    });

    expect(state.snapshot?.session.workflowMaxSubagents).toBe(5);
  });
});
