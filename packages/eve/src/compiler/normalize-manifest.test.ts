import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  createAgentSourceManifest,
  createConnectionSourceRef,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { experimental_workflow } from "#public/definitions/tool.js";

const mocks = vi.hoisted(() => ({
  compileAgentConfig: vi.fn(),
  compileConnectionDefinition: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-agent-config.js", () => ({
  compileAgentConfig: mocks.compileAgentConfig,
}));

vi.mock("#compiler/normalize-helpers.js", () => ({
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

vi.mock("#compiler/normalize-connection.js", () => ({
  compileConnectionDefinition: mocks.compileConnectionDefinition,
}));

describe("compileAgentManifest", () => {
  beforeEach(() => {
    mocks.compileAgentConfig.mockReset();
    mocks.compileConnectionDefinition.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("rejects Workflow runtime configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        return createConfig({
          description: "Research subagent",
          name: "research",
          experimental: {
            workflow: {
              world: "@workflow/world-postgres",
            },
          },
        });
      }

      return createConfig({ name: "root" });
    });
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.workflow" from "research"',
    );
  });

  it("compiles experimental Workflow tool configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/workflow.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(experimental_workflow({ maxSubagents: 6 }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.workflowTool).toEqual({ maxSubagents: 6 });
  });

  it("rejects capability inheritance on root agent configs", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
    });

    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({
        inherit: {
          connections: true,
        },
        name: "root",
      }),
    );

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Capability inheritance is only supported on declared subagent configs. Remove "inherit" from "root".',
    );
  });

  it("preserves capability inheritance on declared subagent configs", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "research"
        ? createConfig({
            description: "Research subagent",
            inherit: {
              connections: true,
              sandbox: true,
            },
            name: "research",
          })
        : createConfig({ name: "root" }),
    );
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.agent.config.inherit).toEqual({
      connections: true,
      sandbox: true,
    });
  });

  it("rejects subagents that inherit and own a sandbox", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
      sandbox: createModuleSourceRef({
        logicalPath: "sandbox/sandbox.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "research"
        ? createConfig({
            description: "Research subagent",
            inherit: {
              sandbox: true,
            },
            name: "research",
          })
        : createConfig({ name: "root" }),
    );
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Subagent "research" cannot both inherit the parent sandbox and define its own sandbox.',
    );
  });

  it("rejects subagents that inherit connections and own a colliding connection name", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "reviewer",
      agentRoot: "/app/agent/subagents/reviewer",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
      connections: [
        createConnectionSourceRef({
          connectionName: "github",
          logicalPath: "connections/github.ts",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      connections: [
        createConnectionSourceRef({
          connectionName: "github",
          logicalPath: "connections/github.ts",
        }),
      ],
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/reviewer/agent.ts",
          logicalPath: "subagents/reviewer",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/reviewer",
          subagentId: "reviewer",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "reviewer"
        ? createConfig({
            description: "Reviewer subagent",
            inherit: {
              connections: true,
            },
            name: "reviewer",
          })
        : createConfig({ name: "root" }),
    );
    mocks.compileConnectionDefinition.mockImplementation(
      async (_agentRoot: string, source: { readonly connectionName: string }) => ({
        connectionName: source.connectionName,
        description: `${source.connectionName} connection`,
        logicalPath: `connections/${source.connectionName}.ts`,
        protocol: "mcp",
        sourceId: `connections/${source.connectionName}`,
        sourceKind: "module",
        url: "https://example.com",
      }),
    );
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Reviewer subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Subagent "reviewer" inherits connection "github" but also defines a connection with that name.',
    );
  });
});

function createConfig(
  input: Pick<CompiledAgentDefinition, "name"> &
    Partial<Pick<CompiledAgentDefinition, "description" | "experimental" | "inherit">>,
): CompiledAgentDefinition {
  const config: CompiledAgentDefinition = {
    model: {
      id: "openai/gpt-5.5",
      routing: classifyModelRouting("openai/gpt-5.5"),
    },
    name: input.name,
  };

  if (input.description !== undefined) {
    config.description = input.description;
  }
  if (input.experimental !== undefined) {
    config.experimental = input.experimental;
  }
  if (input.inherit !== undefined) {
    config.inherit = input.inherit;
  }

  return config;
}
