import { describe, expect, it } from "vitest";

import { discoverAgent } from "#discover/discover-agent.js";
import {
  DISCOVER_EXTENSION_CAPABILITY_INCOMPATIBLE,
  DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
  DISCOVER_EXTENSION_PACKAGE_INVALID,
} from "#discover/extensions.js";
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
    // Below any real consumer eve so the build-eve floor passes by default.
    eveVersion: "0.0.1",
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
  it("prefers live workspace source when source and a built artifact both exist", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/extension/extension.ts":
          'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
        "node_modules/@acme/crm/extension/tools/live.ts": "export default {};\n",
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson(),
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
    const mount = result.manifest.resolvedExtensions[0]!;
    expect(mount.artifact).toBeUndefined();
    expect(mount.manifest?.tools[0]?.logicalPath).toBe("tools/live.ts");
  });

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

  it("fails when the artifact was built with a newer eve than the consumer runs", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson({ eveVersion: "999.0.0" }),
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
      (entry) => entry.code === DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
    );
    expect(diagnostic?.message).toMatch(/built and typechecked against eve 999\.0\.0/);
    expect(diagnostic?.message).toMatch(/Upgrade this app's eve to >=999\.0\.0/);
    expect(result.manifest.resolvedExtensions).toHaveLength(0);
  });

  it("accepts an artifact built with the consumer's own eve", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson({ eveVersion: "0.30.0" }),
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
      eveVersion: "0.30.0",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
  });

  it("skips the build-eve floor for a non-semver eveVersion stamp", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson({
          eveVersion: "workspace-dev",
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

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
  });

  it("rejects an artifact whose package identity does not match package.json", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "extension" },
        }),
        "node_modules/@acme/crm/dist/_ext-manifest.json": artifactJson({
          packageName: "@other/crm",
          packageNamespace: "other-crm",
        }),
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
      (entry) => entry.code === DISCOVER_EXTENSION_PACKAGE_INVALID,
    );
    expect(diagnostic?.message).toMatch(/artifact built for "@other\/crm"/);
    expect(result.manifest.resolvedExtensions).toHaveLength(0);
  });
});
