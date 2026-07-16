import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseExtensionArtifact } from "#compiler/extension-artifact.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";

// `buildExtensionPackage` bundles the entrypoints with rolldown, so these live in
// the scenario tier. They guard the publishing contract: the Node-facing exports
// must be self-contained runnable JS (no `.ts`/`../extension` source reachable, or an
// installed package fails under node_modules type-stripping), with the extension
// namespace baked in and declarations emitted.
async function createExtensionPackage(pkg?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-ext-scenario-"));
  const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/crm",
      version: "0.0.0",
      type: "module",
      eve: { extension: "extension" },
      files: ["dist"],
      peerDependencies: { eve: ">=0.1.0 <1" },
      ...pkg,
    }),
    "utf8",
  );
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(evePackageRoot, join(root, "node_modules", "eve"), "dir");
  await mkdir(join(root, "extension", "tools"), { recursive: true });
  await writeFile(
    join(root, "extension", "extension.ts"),
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
    "utf8",
  );
  await writeFile(
    join(root, "extension", "tools", "crm_search.ts"),
    'export default { description: "Search the CRM.", async execute() { return {}; } };\n',
    "utf8",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        types: [],
      },
      include: ["extension/**/*.ts"],
    }),
    "utf8",
  );
  return root;
}

async function installWorkspaceDependency(input: {
  readonly extensionRoot: string;
  readonly packageName: string;
  readonly source: string;
  readonly types: string;
}): Promise<void> {
  const dependencyRoot = await mkdtemp(join(tmpdir(), "eve-ext-workspace-dependency-"));
  await writeFile(
    join(dependencyRoot, "package.json"),
    JSON.stringify({
      name: input.packageName,
      version: "1.0.0",
      type: "module",
      exports: { "./subpath": { types: "./subpath.d.ts", default: "./subpath.js" } },
    }),
    "utf8",
  );
  await writeFile(join(dependencyRoot, "subpath.js"), input.source, "utf8");
  await writeFile(join(dependencyRoot, "subpath.d.ts"), input.types, "utf8");
  await symlink(
    dependencyRoot,
    join(input.extensionRoot, "node_modules", input.packageName),
    "dir",
  );
}

describe("extension build output", () => {
  it("emits self-contained, namespace-scoped runnable entrypoints", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const index = await readFile(join(outDir, "index.mjs"), "utf8");
    // Bundled from source: no `.ts`/`../extension` re-export Node would follow natively.
    expect(index).not.toMatch(/from\s+["']\.\.\/ext\//);
    // `eve/*` stays external (resolves to the consumer's eve); namespace baked in.
    expect(index).toMatch(/from\s+["']eve\/extension["']/);
    expect(index).toContain("acme-crm");

    const toolsIndex = await readFile(join(outDir, "tools", "index.mjs"), "utf8");
    expect(toolsIndex).not.toMatch(/from\s+["']\.\.\/\.\.\/ext\//);
    // The barrel shares the tool's own entry chunk instead of inlining a copy,
    // so `@acme/crm/tools` and the runtime contribution load one module.
    expect(toolsIndex).toMatch(/from\s+["']\.\/crm_search\.mjs["']/);
    expect(await readFile(join(outDir, "tools", "crm_search.mjs"), "utf8")).toContain(
      "Search the CRM",
    );
  });

  it("shares module-level state between contributions through emitted chunks", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "lib.ts"),
      "let counter = 0;\nexport function nextCount(): number {\n  counter += 1;\n  return counter;\n}\n",
      "utf8",
    );
    for (const tool of ["first", "second"]) {
      await writeFile(
        join(root, "extension", "tools", `${tool}.ts`),
        [
          'import { nextCount } from "../lib";',
          `export default { description: "Count (${tool}).", async execute() { return { count: nextCount() }; } };`,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    // The shared source is emitted once as a chunk both entries import — not
    // inlined per contribution.
    const chunkFiles = await readdir(join(outDir, "_chunks"));
    expect(chunkFiles.some((file) => file.startsWith("lib-"))).toBe(true);
    const first = await readFile(join(outDir, "tools", "first.mjs"), "utf8");
    const second = await readFile(join(outDir, "tools", "second.mjs"), "utf8");
    expect(first).toMatch(/from\s+["']\.\.\/_chunks\/lib-/);
    expect(second).toMatch(/from\s+["']\.\.\/_chunks\/lib-/);
    expect(first).not.toContain("counter");
    expect(second).not.toContain("counter");

    // Module identity holds at runtime: both tools observe one counter.
    const firstTool = await import(pathToFileURL(join(outDir, "tools", "first.mjs")).href);
    const secondTool = await import(pathToFileURL(join(outDir, "tools", "second.mjs")).href);
    expect(await firstTool.default.execute()).toEqual({ count: 1 });
    expect(await secondTool.default.execute()).toEqual({ count: 2 });
  });

  it("emits self-contained declaration barrels resolving into dist (no shipped source)", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const indexDts = await readFile(join(outDir, "index.d.ts"), "utf8");
    expect(indexDts).toContain('export { default } from "./_types/extension/extension.js"');
    expect(indexDts).toContain('export { default as crm } from "./_types/extension/extension.js"');

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain(
      'export { default as crm_search } from "../_types/extension/tools/crm_search.js"',
    );

    // The referenced declarations ship inside dist, so no `.ts` source is needed.
    expect(await readFile(join(outDir, "_types", "extension", "extension.d.ts"), "utf8")).toContain(
      "export default",
    );
  });

  it("sanitizes kebab-case tool names into valid export bindings", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "get-weather.ts"),
      'export default { description: "Get the weather.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain("as get_weather ");
    expect(toolsDts).not.toContain("as get-weather ");
  });

  it("emits a source-free artifact describing every contribution", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const artifactPath = join(outDir, "_ext-manifest.json");
    const artifact = parseExtensionArtifact(await readFile(artifactPath, "utf8"), artifactPath);

    expect(artifact.packageName).toBe("@acme/crm");
    expect(artifact.packageNamespace).toBe("acme-crm");
    // config + state are always stamped; tool is stamped because one is shipped.
    expect(artifact.capabilityVersions).toMatchObject({ tool: 1, config: 1, state: 1 });
    expect(artifact.contributions.tools).toEqual([
      expect.objectContaining({
        name: "crm_search",
        logicalPath: "tools/crm_search.mjs",
        sourceId: "tools/crm_search.mjs",
        sourceKind: "module",
      }),
    ]);

    const emitted = await readFile(join(outDir, "tools", "crm_search.mjs"), "utf8");
    expect(emitted).toContain("Search the CRM");
  });

  it("fills the exports map with runnable + types conditions", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
      "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
    });
  });

  it("upgrades a stale bare-string export entry to the runnable + types shape", async () => {
    const root = await createExtensionPackage({ exports: { ".": "./dist/index.mjs" } });
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports?.["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.mjs" });
  });

  it("emits declarations without an authored tsconfig", async () => {
    const root = await createExtensionPackage();
    await rm(join(root, "tsconfig.json"));
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    expect(await readFile(join(outDir, "_types", "extension", "extension.d.ts"), "utf8")).toContain(
      "export default",
    );
    expect(
      await readFile(join(outDir, "_types", "extension", "tools", "crm_search.d.ts"), "utf8"),
    ).toContain("export default");
  });

  it("fails declaration errors and preserves the last successful dist", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const previousArtifact = await readFile(join(outDir, "_ext-manifest.json"), "utf8");
    await writeFile(join(outDir, "last-success.txt"), "keep", "utf8");
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      'const invalid: "Expected literal" = "Search the CRM.";\nexport default { description: invalid, async execute() { return {}; } };\n',
      "utf8",
    );

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(/TS2322/);
    expect(await readFile(join(outDir, "last-success.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(outDir, "_ext-manifest.json"), "utf8")).toBe(previousArtifact);
  });

  it("externalizes declared workspace dependencies and keeps their subpath imports", async () => {
    const root = await createExtensionPackage({
      dependencies: { "runtime-helper": "workspace:*" },
    });
    await installWorkspaceDependency({
      extensionRoot: root,
      packageName: "runtime-helper",
      source: 'export const helper = "workspace-secret-implementation";\n',
      types: "export declare const helper: string;\n",
    });
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      'import { helper } from "runtime-helper/subpath";\nexport default { description: helper, async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const emitted = await readFile(join(outDir, "tools", "crm_search.mjs"), "utf8");
    expect(emitted).toMatch(/from\s+["']runtime-helper\/subpath["']/);
    expect(emitted).not.toContain("workspace-secret-implementation");
  });

  it("rejects a tool at tools/index.* that would collide with the re-export barrel", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "index.ts"),
      'export default { description: "Collides.", async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /"tools\/index\.ts" collides with the generated tool re-export barrel/,
    );
  });

  it("rejects a package-import alias that resolves to an undeclared package", async () => {
    const root = await createExtensionPackage({
      imports: { "#helper": "runtime-helper/subpath" },
    });
    await installWorkspaceDependency({
      extensionRoot: root,
      packageName: "runtime-helper",
      source: 'export const helper = "aliased-but-undeclared";\n',
      types: "export declare const helper: string;\n",
    });
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      'import { helper } from "#helper";\nexport default { description: helper, async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /"#helper".*resolves to the package "runtime-helper", which is not declared/,
    );
  });

  it("rejects installed but undeclared runtime dependencies", async () => {
    const root = await createExtensionPackage();
    await installWorkspaceDependency({
      extensionRoot: root,
      packageName: "runtime-helper",
      source: 'export const helper = "available-but-undeclared";\n',
      types: "export declare const helper: string;\n",
    });
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      'import { helper } from "runtime-helper/subpath";\nexport default { description: helper, async execute() { return {}; } };\n',
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /Add "runtime-helper" to dependencies, optionalDependencies, or peerDependencies/,
    );
  });

  it("materializes inline skill files into the source-free artifact", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "extension", "skills"), { recursive: true });
    await writeFile(
      join(root, "extension", "skills", "research.ts"),
      [
        'import { defineSkill } from "eve/skills";',
        "export default defineSkill({",
        '  description: "Research carefully.",',
        '  markdown: "# Research\\nUse the checklist.",',
        '  files: { "references/checklist.md": "# Checklist\\n" },',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const artifact = parseExtensionArtifact(
      await readFile(join(outDir, "_ext-manifest.json"), "utf8"),
      join(outDir, "_ext-manifest.json"),
    );
    const skill = artifact.contributions.skills[0]!;

    expect(skill.sourceKind).toBe("skill-package");
    if (skill.sourceKind !== "skill-package") {
      throw new Error("Expected the inline skill to be materialized as a skill package.");
    }
    expect(await readFile(join(outDir, skill.skillFilePath), "utf8")).toContain("# Research");
    expect(await readFile(join(outDir, skill.rootPath, "references", "checklist.md"), "utf8")).toBe(
      "# Checklist\n",
    );
  });

  it("packs and installs a runnable dist-only package", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);
    const tarballsRoot = await mkdtemp(join(tmpdir(), "eve-ext-tarballs-"));
    await runPnpmCommand({
      args: ["pack", "--pack-destination", tarballsRoot],
      cwd: root,
    });
    const tarballName = (await readdir(tarballsRoot)).find((entry) => entry.endsWith(".tgz"));
    expect(tarballName).toBeDefined();

    const consumerRoot = await mkdtemp(join(tmpdir(), "eve-ext-consumer-"));
    await writeFile(
      join(consumerRoot, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module" }),
      "utf8",
    );
    await promisify(execFile)(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-package-lock",
        join(tarballsRoot, tarballName!),
      ],
      { cwd: consumerRoot },
    );
    const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
    await symlink(evePackageRoot, join(consumerRoot, "node_modules", "eve"), "dir");

    const consumerRequire = createRequire(join(consumerRoot, "package.json"));
    const rootEntry = consumerRequire.resolve("@acme/crm");
    const toolsEntry = consumerRequire.resolve("@acme/crm/tools");
    const installedPackageRoot = dirname(dirname(rootEntry));
    await expect(
      readFile(join(installedPackageRoot, "extension", "extension.ts")),
    ).rejects.toThrow();
    expect(
      await readFile(join(installedPackageRoot, "dist", "_ext-manifest.json"), "utf8"),
    ).toContain("eve-extension-artifact");
    const mounted = await import(pathToFileURL(rootEntry).href);
    const tools = await import(pathToFileURL(toolsEntry).href);
    expect(typeof mounted.default).toBe("function");
    expect(mounted.default()).toBeDefined();
    expect(await tools.crm_search.execute()).toEqual({});
  });
});
