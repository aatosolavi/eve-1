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

const PACKAGE_NAME = "@acme/installed-crm";
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
};

/**
 * Runs the extension package build over a `.ts`-authored extension and returns the built package
 * (compiled `dist/` + source `extension/`) as files to place under the consumer's real
 * `node_modules/`. Placing it there — rather than a workspace symlink — means the
 * mount's `.` entrypoint resolves under `node_modules` and is externalized, so
 * Node loads the emitted `dist/index.mjs` directly. The `.ts` source is
 * load-bearing: only TypeScript under `node_modules` triggers the type-stripping
 * refusal a `.mjs`-authored extension would never hit.
 */
async function buildInstalledExtensionFiles(): Promise<Record<string, string>> {
  const extRoot = await mkdtemp(join(tmpdir(), "eve-ext-src-"));
  tempRoots.push(extRoot);
  await writeFile(
    join(extRoot, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, type: "module", eve: { extension: "./extension" }, peerDependencies: { eve: ">=0.1.0 <1" } }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(extRoot, "node_modules"), { recursive: true });
  await symlink(
    dirname(createRequire(import.meta.url).resolve("eve/package.json")),
    join(extRoot, "node_modules", "eve"),
    "dir",
  );
  await mkdir(join(extRoot, "extension", "tools"), { recursive: true });
  for (const [path, contents] of Object.entries(EXT_TREE)) {
    await writeFile(join(extRoot, path), contents, "utf8");
  }

  const config = await tryReadExtensionBuildConfig(extRoot);
  const distDir = await buildExtensionPackage(extRoot, config!);

  // package.json is read after the build because the build rewrites its
  // `exports` map; the consumer resolves the mount entry through it.
  const files: Record<string, string> = {
    [`node_modules/${PACKAGE_NAME}/package.json`]: await readFile(
      join(extRoot, "package.json"),
      "utf8",
    ),
  };
  for (const path of Object.keys(EXT_TREE)) {
    files[`node_modules/${PACKAGE_NAME}/${path}`] = await readFile(join(extRoot, path), "utf8");
  }
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

describe("mounted extension installed under node_modules", () => {
  it("loads the compiled entrypoint and binds config from a built package", async () => {
    const extensionFiles = await buildInstalledExtensionFiles();
    const app = await scenarioApp({
      name: "mounted-extension-installed",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          `import crm from "${PACKAGE_NAME}";`,
          'export default crm({ apiKey: "sk-installed" });',
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
      apiKey: "sk-installed",
    });
  });
});
