import { describe, expect, it } from "vitest";

import {
  EXTENSION_ARTIFACT_KIND,
  EXTENSION_ARTIFACT_VERSION,
  parseExtensionArtifact,
  serializeExtensionArtifact,
  type ExtensionArtifact,
} from "#compiler/extension-artifact.js";

function sampleArtifact(): ExtensionArtifact {
  return {
    kind: EXTENSION_ARTIFACT_KIND,
    version: EXTENSION_ARTIFACT_VERSION,
    eveVersion: "1.2.3",
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
  };
}

describe("extension artifact serialization", () => {
  it("round-trips a serialized artifact back to a deep-equal value", () => {
    const artifact = sampleArtifact();
    const parsed = parseExtensionArtifact(
      serializeExtensionArtifact(artifact),
      "dist/_ext-manifest.json",
    );
    expect(parsed).toEqual(artifact);
  });

  it("rejects malformed JSON with the artifact path named", () => {
    expect(() => parseExtensionArtifact("{ not json", "dist/_ext-manifest.json")).toThrow(
      /dist\/_ext-manifest\.json/,
    );
  });

  it("rejects an artifact whose kind is wrong", () => {
    const artifact = { ...sampleArtifact(), kind: "not-an-artifact" };
    expect(() =>
      parseExtensionArtifact(JSON.stringify(artifact), "dist/_ext-manifest.json"),
    ).toThrow();
  });
});
