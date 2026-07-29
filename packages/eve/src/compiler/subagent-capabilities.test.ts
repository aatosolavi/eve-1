import { describe, expect, it } from "vitest";

import {
  type ProjectableSubagentCapabilities,
  projectSubagentCapabilities,
} from "#compiler/subagent-capabilities.js";

function createSubagent(
  input: {
    readonly connections?: number;
    readonly inherit?: { readonly connections?: boolean; readonly sandbox?: boolean };
    readonly sandbox?: unknown | null;
    readonly sandboxWorkspaces?: number;
  } = {},
): ProjectableSubagentCapabilities {
  const config: {
    inherit?: { readonly connections?: boolean; readonly sandbox?: boolean };
  } = {};
  if (input.inherit !== undefined) {
    config.inherit = input.inherit;
  }

  return {
    agent: {
      config,
      connections: Array.from({ length: input.connections ?? 0 }, () => ({})),
      sandbox: input.sandbox === undefined ? null : input.sandbox,
      sandboxWorkspaces: Array.from({ length: input.sandboxWorkspaces ?? 0 }, () => ({})),
    },
  };
}

describe("projectSubagentCapabilities", () => {
  it("projects isolated defaults when inherit is unset", () => {
    expect(projectSubagentCapabilities(createSubagent())).toEqual({
      effective: {
        connections: { inherited: false, owned: 0 },
        sandbox: "default",
      },
      inherit: { connections: false, sandbox: false },
    });
  });

  it("projects inherited sandbox and connections", () => {
    expect(
      projectSubagentCapabilities(
        createSubagent({
          connections: 1,
          inherit: { connections: true, sandbox: true },
        }),
      ),
    ).toEqual({
      effective: {
        connections: { inherited: true, owned: 1 },
        sandbox: "inherited",
      },
      inherit: { connections: true, sandbox: true },
    });
  });

  it("projects owned sandbox when the subagent defines one", () => {
    expect(
      projectSubagentCapabilities(
        createSubagent({
          sandbox: {
            logicalPath: "sandbox/sandbox.ts",
            sourceId: "sandbox/sandbox",
            sourceKind: "module",
          },
        }),
      ),
    ).toMatchObject({
      effective: { sandbox: "owned" },
      inherit: { sandbox: false },
    });
  });
});
