import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "../../src/internal/nitro/host/build-extension.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";

const scenarioApp = useScenarioApp();
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })),
  );
});

const PACKAGE_NAME = "@acme/prebuilt-crm";
const EXT_TREE: Readonly<Record<string, string>> = {
  "extension/extension.ts": [
    'import { defineExtension } from "eve/extension";',
    "",
    "interface CrmConfig {",
    "  apiKey: string;",
    "}",
    "",
    "const config = {",
    '  "~standard": {',
    "    version: 1,",
    '    vendor: "scenario",',
    "    validate: (value: unknown) => ({ value: value as CrmConfig }),",
    "    types: undefined as { input: CrmConfig; output: CrmConfig } | undefined,",
    "  },",
    "} as const;",
    "",
    "export default defineExtension({ config });",
    "",
  ].join("\n"),
  // Both tools import the extension handle, so the graph build emits it as one
  // shared chunk instead of a per-tool inlined copy.
  "extension/tools/echo.ts": [
    'import { defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineTool({",
    '  description: "Echo the configured API key.",',
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() {",
    "    return { apiKey: extension.config.apiKey };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/tools/shout.ts": [
    'import { defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineTool({",
    '  description: "Shout the configured API key.",',
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() {",
    "    return { apiKey: String(extension.config.apiKey).toUpperCase() };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/tools/dynamic.ts": [
    'import { defineDynamic, defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () => ({',
    "      quote: defineTool({",
    '        description: "Quote the configured API key.",',
    '        inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "        async execute() {",
    "          return { apiKey: extension.config.apiKey };",
    "        },",
    "      }),",
    "    }),",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/skills/notes.ts": [
    'import { defineSkill } from "eve/skills";',
    "export default defineSkill({",
    '  description: "Take structured notes.",',
    '  markdown: "# Notes\\nRecord decisions as bullet points.",',
    "});",
    "",
  ].join("\n"),
  "extension/skills/research.ts": [
    'import { defineSkill } from "eve/skills";',
    "export default defineSkill({",
    '  description: "Research an account.",',
    '  markdown: "# Research\\nUse the checklist.",',
    '  files: { "references/checklist.md": "# Checklist\\n" },',
    "});",
    "",
  ].join("\n"),
  "extension/skills/guide/SKILL.md": [
    "---",
    "description: How to triage with the CRM.",
    "---",
    "",
    "# Guide",
    "",
    "Follow references/steps.md.",
    "",
  ].join("\n"),
  "extension/skills/guide/references/steps.md": "# Steps\n",
  "extension/skills/oncall.ts": [
    'import { defineDynamic, defineSkill } from "eve/skills";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () => ({',
    "      escalation: defineSkill({",
    '        description: "Escalate an incident.",',
    '        markdown: "# Escalation\\nPage the on-call.",',
    "      }),",
    "    }),",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/instructions/dynamic.ts": [
    'import { defineDynamic, defineInstructions } from "eve/instructions";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () =>',
    '      defineInstructions({ markdown: "Prefer the CRM tools for account questions." }),',
    "  },",
    "});",
    "",
  ].join("\n"),
};

/**
 * Builds the extension package, then returns ONLY what a published source-free
 * package ships — `package.json` and the complete `dist/` tree (compiled
 * entries, shared chunks, artifact manifest, declarations). No `.ts` source is
 * placed under the consumer's `node_modules`, so discovery must compose from
 * `dist/_ext-manifest.json`.
 */
async function buildSourceFreeExtensionFiles(): Promise<Record<string, string>> {
  const extRoot = await mkdtemp(join(tmpdir(), "eve-ext-prebuilt-"));
  tempRoots.push(extRoot);
  await writeFile(
    join(extRoot, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, type: "module", eve: { extension: "./extension" }, files: ["dist"], peerDependencies: { eve: ">=0.1.0 <1" } }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(extRoot, "node_modules"), { recursive: true });
  await symlink(
    dirname(createRequire(import.meta.url).resolve("eve/package.json")),
    join(extRoot, "node_modules", "eve"),
    "dir",
  );
  for (const [path, contents] of Object.entries(EXT_TREE)) {
    await mkdir(dirname(join(extRoot, path)), { recursive: true });
    await writeFile(join(extRoot, path), contents, "utf8");
  }

  const config = await tryReadExtensionBuildConfig(extRoot);
  const distDir = await buildExtensionPackage(extRoot, config!);

  const files: Record<string, string> = {
    [`node_modules/${PACKAGE_NAME}/package.json`]: await readFile(
      join(extRoot, "package.json"),
      "utf8",
    ),
  };
  for (const entry of await readdir(distDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const absolutePath = join(entry.parentPath, entry.name);
    const distRelativePath = relative(distDir, absolutePath).replaceAll("\\", "/");
    files[`node_modules/${PACKAGE_NAME}/dist/${distRelativePath}`] = await readFile(
      absolutePath,
      "utf8",
    );
  }
  return files;
}

describe("mounted source-free extension", () => {
  it("composes, binds config, and executes tools from the dist-only artifact", async () => {
    const extensionFiles = await buildSourceFreeExtensionFiles();
    expect(
      Object.keys(extensionFiles).some((path) => path.includes(`${PACKAGE_NAME}/extension/`)),
    ).toBe(false);
    // The shared extension handle ships as one chunk both tools import.
    expect(Object.keys(extensionFiles).some((path) => path.includes("/dist/_chunks/"))).toBe(true);

    const app = await scenarioApp({
      name: "mounted-extension-source-free",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          `import crm from "${PACKAGE_NAME}";`,
          'export default crm({ apiKey: "sk-prebuilt" });',
          "",
        ].join("\n"),
        ...extensionFiles,
      },
    });

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const echo = graph.root.agent.tools.find((entry) => entry.name === "crm__echo");
    expect(echo).toBeDefined();
    await expect(echo?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-prebuilt",
    });

    const shout = graph.root.agent.tools.find((entry) => entry.name === "crm__shout");
    expect(shout).toBeDefined();
    await expect(shout?.execute?.({}, { messages: [], toolCallId: "call_2" })).resolves.toEqual({
      apiKey: "SK-PREBUILT",
    });

    // Static skills in all three authoring forms, namespaced by the mount.
    const skillNames = graph.root.agent.skills.map((skill) => skill.name);
    expect(skillNames).toEqual(
      expect.arrayContaining(["crm__notes", "crm__research", "crm__guide"]),
    );
    const notes = graph.root.agent.skills.find((skill) => skill.name === "crm__notes");
    expect(notes?.markdown).toContain("Record decisions as bullet points.");
    const research = graph.root.agent.skills.find((skill) => skill.name === "crm__research");
    expect(research?.sourceKind).toBe("skill-package");
    const guide = graph.root.agent.skills.find((skill) => skill.name === "crm__guide");
    expect(guide?.sourceKind).toBe("skill-package");

    // Skill-package files (markdown-authored and defineSkill `files`) are
    // materialized into the consumer's workspace resources under the
    // namespaced skill directory.
    const skillsResourceRoot = join(
      app.appRoot,
      ".eve",
      "compile",
      "workspace-resources",
      "__root__",
      "skills",
    );
    expect(await readFile(join(skillsResourceRoot, "crm__guide", "SKILL.md"), "utf8")).toContain(
      "Follow references/steps.md.",
    );
    expect(
      await readFile(join(skillsResourceRoot, "crm__guide", "references", "steps.md"), "utf8"),
    ).toBe("# Steps\n");
    expect(
      await readFile(
        join(skillsResourceRoot, "crm__research", "references", "checklist.md"),
        "utf8",
      ),
    ).toBe("# Checklist\n");

    // Dynamic tool resolver from the artifact: the produced tool reads the
    // mount-bound config through the shared handle chunk.
    const dynamicTools = graph.root.agent.dynamicToolResolvers.find(
      (resolver) => resolver.slug === "crm__dynamic",
    );
    expect(dynamicTools?.extensionNamespace).toBe("crm");
    const producedTools = (await dynamicTools?.events["session.started"]?.({}, {})) as {
      quote: { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
    };
    await expect(producedTools.quote.execute({}, {})).resolves.toEqual({ apiKey: "sk-prebuilt" });

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
