import { describe, expect, it } from "vitest";

import {
  EXTENSION_CAPABILITY_VERSIONS,
  validateExtensionCapabilities,
} from "#compiler/extension-capabilities.js";

describe("validateExtensionCapabilities", () => {
  it("returns no mismatches when every stamped version matches the current eve", () => {
    expect(
      validateExtensionCapabilities({
        tool: EXTENSION_CAPABILITY_VERSIONS.tool,
        config: EXTENSION_CAPABILITY_VERSIONS.config,
        state: EXTENSION_CAPABILITY_VERSIONS.state,
      }),
    ).toEqual([]);
  });

  it("reports a mismatch when a stamped capability version differs", () => {
    expect(
      validateExtensionCapabilities({
        tool: EXTENSION_CAPABILITY_VERSIONS.tool + 1,
        state: EXTENSION_CAPABILITY_VERSIONS.state,
      }),
    ).toEqual([
      {
        kind: "tool",
        built: EXTENSION_CAPABILITY_VERSIONS.tool + 1,
        current: EXTENSION_CAPABILITY_VERSIONS.tool,
      },
    ]);
  });

  it("reports an unknown capability as current version 0 so the consumer fails", () => {
    expect(validateExtensionCapabilities({ ["future-capability" as never]: 1 })).toEqual([
      { kind: "future-capability", built: 1, current: 0 },
    ]);
  });

  it("ignores capabilities the extension did not stamp", () => {
    expect(validateExtensionCapabilities({})).toEqual([]);
  });
});
