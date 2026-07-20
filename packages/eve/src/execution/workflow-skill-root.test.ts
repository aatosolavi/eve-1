import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { resolveSessionSkillRoot } from "#execution/workflow-skill-root.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

function createTurnAgent(): RuntimeTurnAgent {
  return {
    availableSkills: [
      { description: "Research a topic systematically", name: "research" },
      { description: "Run the incident response procedure", name: "incident-response" },
    ],
    id: "test-agent",
    instructions: [],
    model: { id: "test-model" },
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
}

describe("resolveSessionSkillRoot", () => {
  it("does not open a sandbox before the model call just because static skills are available", async () => {
    // SandboxAccess is lazy: calling get() is the operation that creates or
    // reattaches the backend sandbox. Returning null keeps this test focused
    // on whether prompt preparation invokes that operation at all.
    const get = vi.fn(async () => null);
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, {
      captureState: vi.fn(async () => ({ initialized: false, session: null })),
      get,
    });

    await expect(
      resolveSessionSkillRoot({
        ctx,
        turnAgent: createTurnAgent(),
      }),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});
