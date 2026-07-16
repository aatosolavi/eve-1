import { describe, expect, it } from "vitest";

import { discoverAgent } from "#discover/discover-agent.js";
import { DISCOVER_EXTENSION_CAPABILITY_INCOMPATIBLE } from "#discover/extensions.js";
import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import {
  EXTENSION_ARTIFACT_KIND,
  EXTENSION_ARTIFACT_VERSION,
  type ExtensionArtifact,
} from "#compiler/extension-artifact.js";

function artifactJson(overrides: Partial<ExtensionArtifact> = {}): string {
  const artifact: ExtensionArtifact = {
    kind: EXTENSION_ARTIFACT_KIND,
    version: EXTENSION_ARTIFACT_VERSION,
    eveVersion: "1.0.0",
    packageName: "@acme/crm",
    packageNamespace: "acme-crm",
    capabilityVersions: { tool: 1, config: 1, state: 1 },
    contributions: {
      tools: [
        {
          description: "Search the CRM.",
          inputSchema: null,
          name: "search",
          logicalPath: "tools/search.mjs",
          sourceId: "tools/search.mjs",
          sourceKind: "module",
        },
      ],
      dynamicTools: [],
      hooks: [],
      skills: [],
      dynamicSkills: [],
      dynamicInstructions: [],
      connections: [],
      instructionFragments: [],
    },
    ...overrides,
  };
  return JSON.stringify(artifact);
}

describe("source-free extension discovery", () => {
  it("attaches the compiled artifact and does not recurse into source", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson(),
        "node_modules/@acme/crm/dist/tools/search.mjs": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
    const mount = result.manifest.resolvedExtensions[0]!;
    expect(mount.namespace).toBe("crm");
    expect(mount.manifest).toBeUndefined();
    expect(mount.artifact?.contributions.tools[0]?.name).toBe("search");
  });

  it("fails with a capability diagnostic when a stamped version is incompatible", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson({
          capabilityVersions: { tool: 999, config: 1, state: 1 },
        }),
        "node_modules/@acme/crm/dist/tools/search.mjs": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === DISCOVER_EXTENSION_CAPABILITY_INCOMPATIBLE,
    );
    expect(diagnostic?.message).toMatch(/tool \(built v999, this eve provides v1\)/);
    expect(result.manifest.resolvedExtensions).toHaveLength(0);
  });
});
