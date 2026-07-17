import { describe, expect, it } from "vitest";

import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CAPABILITY_SUPPORT,
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  deriveExtensionCapabilitySupport,
  findUnsupportedExtensionCapabilities,
  parseExtensionCompatibilityManifest,
  serializeExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

describe("extension compatibility manifest", () => {
  it("round-trips the producer version and only the capabilities in use", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.25.1",
      requires: ["extension", "tool"],
    } as const;

    expect(
      parseExtensionCompatibilityManifest(
        serializeExtensionCompatibilityManifest(manifest),
        "/pkg/dist/extension/_manifest.json",
      ),
    ).toEqual(manifest);
  });

  it("rejects the previous manifest format and invalid producer versions", () => {
    const manifestPath = "/pkg/dist/extension/_manifest.json";

    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({
          kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
          formatVersion: 1,
          builtWithEve: "0.25.1",
          requires: { extension: 1 },
        }),
        manifestPath,
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({
          kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
          formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
          builtWithEve: "development",
          requires: ["extension"],
        }),
        manifestPath,
      ),
    ).toThrow(/valid semantic version/);
  });

  it("rejects duplicate requirements and executable contribution fields", () => {
    const base = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.25.1",
      requires: ["extension"],
    } as const;
    const manifestPath = "/pkg/dist/extension/_manifest.json";

    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({ ...base, requires: ["extension", "extension"] }),
        manifestPath,
      ),
    ).toThrow(/unique/);
    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({ ...base, contributions: { tools: [] } }),
        manifestPath,
      ),
    ).toThrow(/invalid/);
  });

  it("checks only required capabilities against their consumer-owned ranges", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.25.6",
      requires: ["extension", "tool"],
    } as const;

    expect(
      findUnsupportedExtensionCapabilities(manifest, {
        extension: ">=0.25.0 <0.27.0",
        tool: ">=0.24.0 <0.26.0",
        skill: ">=0.26.0 <0.27.0",
      }),
    ).toEqual([]);
    expect(
      findUnsupportedExtensionCapabilities(
        { ...manifest, requires: ["futureCapability", "tool"] },
        { extension: ">=0.25.0 <0.27.0", tool: ">=0.26.0 <0.27.0" },
      ),
    ).toEqual([
      { capability: "futureCapability", builtWithEve: "0.25.6", supportedRange: undefined },
      {
        capability: "tool",
        builtWithEve: "0.25.6",
        supportedRange: ">=0.26.0 <0.27.0",
      },
    ]);
  });

  it("fails closed for capability names that collide with Object.prototype members", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.25.1",
      requires: ["toString", "constructor", "hasOwnProperty"],
    } as const;

    expect(findUnsupportedExtensionCapabilities(manifest)).toEqual([
      { capability: "constructor", builtWithEve: "0.25.1", supportedRange: undefined },
      { capability: "hasOwnProperty", builtWithEve: "0.25.1", supportedRange: undefined },
      { capability: "toString", builtWithEve: "0.25.1", supportedRange: undefined },
    ]);
  });

  it("accepts older producers but does not predict compatibility with newer minors", () => {
    const olderProducer = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.25.4",
      requires: ["extension", "hook"],
    } as const;
    const newerProducer = { ...olderProducer, builtWithEve: "0.26.0" } as const;

    expect(
      findUnsupportedExtensionCapabilities(
        olderProducer,
        deriveExtensionCapabilitySupport("0.26.2"),
      ),
    ).toEqual([]);
    expect(
      findUnsupportedExtensionCapabilities(
        newerProducer,
        deriveExtensionCapabilitySupport("0.25.4"),
      ),
    ).toEqual([
      {
        capability: "extension",
        builtWithEve: "0.26.0",
        supportedRange: ">=0.25.0 <0.26.0-0",
      },
      {
        capability: "hook",
        builtWithEve: "0.26.0",
        supportedRange: ">=0.25.0 <0.26.0-0",
      },
    ]);
  });

  it("supports every capability stamped by its own extension builder", () => {
    const builtWithEve = resolveInstalledPackageInfo().version;
    expect(
      findUnsupportedExtensionCapabilities({
        kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
        formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
        builtWithEve,
        requires: EXTENSION_CAPABILITIES,
      }),
    ).toEqual([]);
    expect(Object.keys(EXTENSION_CAPABILITY_SUPPORT)).toEqual(EXTENSION_CAPABILITIES);
  });
});
