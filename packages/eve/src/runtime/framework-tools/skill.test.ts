import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";
import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

function createBundle(skills: readonly ResolvedSkillDefinition[]): CompiledBundle {
  const agent = {
    config: { name: "test-agent" },
    skills,
  } as CompiledBundle["resolvedAgent"];

  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: {
      nodesByNodeId: new Map(),
      root: { agent } as CompiledBundle["graph"]["root"],
    },
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    resolvedAgent: agent,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function createSandboxAccessThatMustNotBeUsed() {
  return {
    captureState: vi.fn(async () => ({ initialized: false, session: null })),
    get: vi.fn(async () => {
      throw new Error("Static skill loading must not open a sandbox");
    }),
  };
}

describe("SKILL_TOOL_DEFINITION", () => {
  it("describes when skill loading should be used", () => {
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "request clearly matches a listed skill description",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "Loading adds the skill instructions to the current turn.",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain("Available skills block");
    expect(SKILL_TOOL_DEFINITION.description).toContain("not for MCP connections");
    expect(SKILL_TOOL_DEFINITION.description).toContain("connection_search");
  });
});

describe("load_skill executor", () => {
  it("loads an authored markdown skill when no sandbox context is available", async () => {
    const ctx = new ContextContainer();
    ctx.set(
      BundleKey,
      createBundle([
        {
          description: "Research a topic systematically",
          logicalPath: "skills/research.md",
          markdown: "# Research\n\nFollow the evidence.\n",
          name: "research",
          sourceId: "skills/research.md",
          sourceKind: "markdown",
        },
        {
          description: "Write a concise summary",
          logicalPath: "skills/summarize.md",
          markdown: "# Summarize\n",
          name: "summarize",
          sourceId: "skills/summarize.md",
          sourceKind: "markdown",
        },
      ]),
    );

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "research" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).resolves.toBe("# Research\n\nFollow the evidence.\n");
  });

  it("loads packaged skill instructions without materializing their nested files in a sandbox", async () => {
    const sandbox = createSandboxAccessThatMustNotBeUsed();
    const ctx = new ContextContainer();
    ctx.set(
      BundleKey,
      createBundle([
        {
          description: "Run the full incident response procedure",
          files: {
            "references/services/api/owners.md": "# API owners\n",
            "references/services/web/owners.md": "# Web owners\n",
            "scripts/diagnostics/collect.sh": "#!/bin/sh\n",
          },
          logicalPath: "skills/incident-response/SKILL.md",
          markdown:
            "# Incident response\n\nConsult `references/services/api/owners.md` when needed.\n",
          name: "incident-response",
          rootPath: "/authored/skills/incident-response",
          skillFilePath: "/authored/skills/incident-response/SKILL.md",
          skillId: "incident-response",
          sourceId: "skills/incident-response/SKILL.md",
          sourceKind: "skill-package",
        },
      ]),
    );
    ctx.set(SandboxKey, sandbox);

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "incident-response" }, { messages: [], toolCallId: "call_2" }),
      ),
    ).resolves.toBe(
      "# Incident response\n\nConsult `references/services/api/owners.md` when needed.\n",
    );
    expect(sandbox.get).not.toHaveBeenCalled();
    expect(sandbox.captureState).not.toHaveBeenCalled();
  });

  it("loads an active dynamic skill from the sandbox instead of a same-named authored skill", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/policy/SKILL.md": "# Dynamic policy\n",
      },
    });
    const ctx = new ContextContainer();
    ctx.set(
      BundleKey,
      createBundle([
        {
          description: "Apply the static policy",
          logicalPath: "skills/policy.md",
          markdown: "# Static policy\n",
          name: "policy",
          sourceId: "skills/policy.md",
          sourceKind: "markdown",
        },
      ]),
    );
    ctx.set(SandboxKey, sandbox.access);
    ctx.set(DynamicSkillManifestKey, {
      policy: [{ description: "Apply the dynamic policy", name: "policy" }],
    });

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "policy" }, { messages: [], toolCallId: "call_dynamic" }),
      ),
    ).resolves.toBe("# Dynamic policy\n");
  });

  it("surfaces dynamic skill names when the requested id is missing", async () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([]));
    ctx.set(SandboxKey, mockSandbox().access);
    ctx.set(DynamicSkillManifestKey, {
      custom: [
        { description: "Talk like a dog", name: "custom__talk-like-a-dog" },
        { description: "Bark", name: "custom__bark" },
      ],
    });

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "talk-like-a-dog" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).rejects.toThrow("Available skills: custom__bark, custom__talk-like-a-dog.");
  });

  it("redirects an installed connection mistakenly passed as a skill", async () => {
    const registry = {
      dispose: async () => {},
      getClient: () => {
        throw new Error("Not used by load_skill");
      },
      getConnectionApproval: () => undefined,
      getConnectionNames: () => ["linear"],
      getConnections: () => [],
    } satisfies ConnectionRegistry;
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle([]));
    ctx.set(SandboxKey, mockSandbox().access);
    ctx.set(ConnectionRegistryKey, registry);

    const execute = SKILL_TOOL_DEFINITION.execute;
    if (execute === undefined) throw new Error("load_skill tool is missing an execute function");

    await expect(
      contextStorage.run(ctx, () =>
        execute({ skill: "linear" }, { messages: [], toolCallId: "call_1" }),
      ),
    ).rejects.toThrow(
      '"linear" is an installed connection, not a skill. Use connection_search with connection "linear" to find its tools.',
    );
  });
});
