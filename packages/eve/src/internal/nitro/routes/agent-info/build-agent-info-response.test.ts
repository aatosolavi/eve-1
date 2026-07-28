import { describe, expect, it } from "vitest";

import { createCompiledAgentNodeManifest } from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import {
  buildFrameworkToolInfo,
  renderSubagent,
} from "#internal/nitro/routes/agent-info/build-agent-info-response.js";

describe("buildFrameworkToolInfo", () => {
  it("reports the built-in agent action as active and available by default", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.available.map((tool) => tool.name)).toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      status: "active",
    });
  });

  it("reports the built-in agent action as disabled and unavailable", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(["agent"]),
    });

    expect(info.available.map((tool) => tool.name)).not.toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      disabledByAuthor: true,
      status: "disabled",
    });
  });

  it("reports a declared agent delegation tool as replacing the recursive action", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(),
      delegationToolNames: new Set(["agent"]),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.available.map((tool) => tool.name)).not.toContain("agent");
    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      replacedByAuthoredTool: false,
      status: "replaced",
    });
  });

  it("reports an authored agent tool as replacing the recursive action", () => {
    const info = buildFrameworkToolInfo({
      authoredToolNames: new Set(["agent"]),
      delegationToolNames: new Set(),
      disabledFrameworkToolNames: new Set(),
    });

    expect(info.framework.find((tool) => tool.name === "agent")).toMatchObject({
      replacedByAuthoredTool: true,
      status: "replaced",
    });
  });
});

describe("renderSubagent", () => {
  it("reports inherited and owned subagent capabilities", () => {
    const subagent = renderSubagent({
      agent: createCompiledAgentNodeManifest({
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
        config: {
          description: "Research one task.",
          inherit: {
            connections: true,
            sandbox: true,
          },
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "researcher",
        },
        connections: [
          {
            connectionName: "linear",
            description: "Use Linear.",
            logicalPath: "connections/linear.ts",
            protocol: "mcp",
            sourceId: "connections/linear.ts",
            sourceKind: "module",
            url: "https://mcp.linear.example",
          },
        ],
      }),
      description: "Research one task.",
      entryPath: "subagents/researcher/agent.ts",
      logicalPath: "subagents/researcher",
      name: "researcher",
      nodeId: "subagents/researcher",
      rootPath: "/app/agent/subagents/researcher",
      sourceId: "subagents/researcher",
      sourceKind: "module",
    });

    expect(subagent.inherit).toEqual({
      connections: true,
      sandbox: true,
    });
    expect(subagent.effective).toEqual({
      connections: {
        inherited: true,
        owned: 1,
      },
      sandbox: "inherited",
    });
  });
});
