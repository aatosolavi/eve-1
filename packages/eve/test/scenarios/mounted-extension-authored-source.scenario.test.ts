import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

/**
 * Runs the `eve eval` / `eve dev` path: the module map is hydrated from authored
 * source, so the extension-scope plugin must bind config across separately-bundled
 * mount and tool modules. Deterministic guard for the config-binding regression.
 */
describe("mounted extension via authored-source loader", () => {
  it("binds mounted config so a composed tool reads it", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-authored-source",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-authored" });',
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: "extension" },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          // Minimal pass-through Standard Schema — this scenario tests binding, not validation.
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_echo.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Echo the configured API key.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { apiKey: extension.config.apiKey };",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/dynamic.mjs": [
          'import { defineDynamic, defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineDynamic({",
          "  events: {",
          "    'session.started': async () => ({",
          "      quote: defineTool({",
          '        description: "Quote the configured API key.",',
          "        inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "        async execute() {",
          "          return { apiKey: extension.config.apiKey };",
          "        },",
          "      }),",
          "    }),",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/skills/notes.mjs": [
          'import { defineSkill } from "eve/skills";',
          "export default defineSkill({",
          '  description: "Take structured notes.",',
          '  markdown: "# Notes\\nRecord decisions as bullet points.",',
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/skills/research.mjs": [
          'import { defineSkill } from "eve/skills";',
          "export default defineSkill({",
          '  description: "Research an account.",',
          '  markdown: "# Research\\nUse the checklist.",',
          "  files: { 'references/checklist.md': '# Checklist\\n' },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/skills/guide/SKILL.md": [
          "---",
          "description: How to triage with the CRM.",
          "---",
          "",
          "# Guide",
          "",
          "Follow references/steps.md.",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/skills/guide/references/steps.md": "# Steps\n",
        "node_modules/@acme/crm/extension/skills/oncall.mjs": [
          'import { defineDynamic, defineSkill } from "eve/skills";',
          "export default defineDynamic({",
          "  events: {",
          "    'session.started': async () => ({",
          "      escalation: defineSkill({",
          '        description: "Escalate an incident.",',
          '        markdown: "# Escalation\\nPage the on-call.",',
          "      }),",
          "    }),",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/instructions/dynamic.mjs": [
          'import { defineDynamic, defineInstructions } from "eve/instructions";',
          "export default defineDynamic({",
          "  events: {",
          "    'session.started': async () =>",
          "      defineInstructions({ markdown: 'Prefer the CRM tools for account questions.' }),",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const tool = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-authored",
    });

    // The same skill and dynamic authoring forms the source-free scenario
    // asserts, through the recompile-from-source path.
    const skillNames = graph.root.agent.skills.map((skill) => skill.name);
    expect(skillNames).toEqual(
      expect.arrayContaining(["crm__notes", "crm__research", "crm__guide"]),
    );
    const notes = graph.root.agent.skills.find((skill) => skill.name === "crm__notes");
    expect(notes?.markdown).toContain("Record decisions as bullet points.");
    const guide = graph.root.agent.skills.find((skill) => skill.name === "crm__guide");
    expect(guide?.sourceKind).toBe("skill-package");

    const dynamicTools = graph.root.agent.dynamicToolResolvers.find(
      (resolver) => resolver.slug === "crm__dynamic",
    );
    expect(dynamicTools?.extensionNamespace).toBe("crm");
    const producedTools = (await dynamicTools?.events["session.started"]?.({}, {})) as {
      quote: { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
    };
    await expect(producedTools.quote.execute({}, {})).resolves.toEqual({ apiKey: "sk-authored" });

    const dynamicSkills = graph.root.agent.dynamicSkillResolvers.find(
      (resolver) => resolver.slug === "crm__oncall",
    );
    expect(dynamicSkills?.extensionNamespace).toBe("crm");
    const producedSkills = (await dynamicSkills?.events["session.started"]?.({}, {})) as {
      escalation: { markdown: string };
    };
    expect(producedSkills.escalation.markdown).toContain("Page the on-call.");

    const dynamicInstructions = graph.root.agent.dynamicInstructionsResolvers.find(
      (resolver) => resolver.slug === "crm__dynamic",
    );
    expect(dynamicInstructions).toBeDefined();
    const producedInstructions = (await dynamicInstructions?.events["session.started"]?.(
      {},
      {},
    )) as { markdown: string };
    expect(producedInstructions.markdown).toBe("Prefer the CRM tools for account questions.");
  });
});
