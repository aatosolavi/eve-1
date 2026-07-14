import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { experimental_chatgpt } from "#public/models/openai/index.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";

const mocks = vi.hoisted(() => ({
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiler/normalize-helpers.js")>()),
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentConfig", () => {
  beforeEach(() => {
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("compiles a dynamic model fallback and preserves the resolver source", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: defineDynamic({
        fallback: "openai/gpt-5.5",
        events: {
          "session.started": () => "openai/gpt-5.5-mini",
          "step.started": () => null,
        },
      }),
    });

    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });

    const compiled = await compileAgentConfig(manifest, {
      modelCatalog: createModelCatalog(),
    });

    expect(compiled.model).toEqual({
      contextWindowTokens: 256_000,
      id: "openai/gpt-5.5",
      routing: { kind: "gateway", target: "openai" },
    });
    expect(compiled.dynamicModel).toEqual({
      eventNames: ["session.started", "step.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
  });

  it("uses the experimental_chatgpt context window without catalog metadata", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_chatgpt(),
    });
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(createAgentManifest(), { modelCatalog });

    expect(compiled.model.contextWindowTokens).toBe(200_000);
    expect(modelCatalog.getByProviderModelId).not.toHaveBeenCalled();
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("lets an authored context window override the experimental_chatgpt default", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_chatgpt(),
      modelContextWindowTokens: 128_000,
    });
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(createAgentManifest(), { modelCatalog });

    expect(compiled.model.contextWindowTokens).toBe(128_000);
    expect(modelCatalog.getByProviderModelId).not.toHaveBeenCalled();
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });
});

function createAgentManifest() {
  return createAgentSourceManifest({
    agentId: "app",
    agentRoot: "/app/agent",
    appRoot: "/app",
    configModule: createModuleSourceRef({
      logicalPath: "agent.ts",
      sourceId: "agent-config",
    }),
  });
}

function createModelCatalog(): ManifestCompileContext["modelCatalog"] {
  return {
    getByProviderModelId: vi.fn(),
    getModelLimits: vi.fn(async () => ({ contextWindowTokens: 256_000 })),
  };
}
