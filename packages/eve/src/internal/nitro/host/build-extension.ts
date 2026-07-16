import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  EXTENSION_CAPABILITY_VERSIONS,
  type ExtensionCapabilityKind,
} from "#compiler/extension-capabilities.js";
import {
  writeExtensionArtifact,
  EXTENSION_ARTIFACT_KIND,
  EXTENSION_ARTIFACT_VERSION,
  type ExtensionArtifact,
  type ExtensionArtifactContributions,
} from "#compiler/extension-artifact.js";
import {
  produceExtensionArtifactContributions,
  type CompiledExtensionContributions,
} from "#compiler/normalize-extension.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { packageStateNamespace } from "#discover/extensions.js";
import { discoverFlatModuleSource, readSortedDirectoryEntries } from "#discover/grammar.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  bundleAuthoredModuleGraphForDistribution,
  type DistributionGraphEntry,
} from "#internal/authored-module-loader.js";
import { emitExtensionDeclarations } from "#internal/nitro/host/extension-declarations.js";
import { normalizeSkillPackage, writeSkillPackageDirectory } from "#shared/skill-package.js";

/**
 * Resolved build inputs for an extension package (a `package.json` declaring
 * `eve.extension`).
 */
export interface ExtensionBuildConfig {
  /** Absolute path to the agent-shaped source root (`eve.extension`). */
  readonly sourceRoot: string;
  /** Package name from `package.json`. */
  readonly packageName: string;
  /** Short name a consumer mounts by (`@acme/crm` → `crm`). */
  readonly shortName: string;
  /** Packages that may remain as runtime imports in the published artifact. */
  readonly runtimeDependencies: readonly string[];
}

/**
 * Reads `package.json#eve.extension` from a project root, returning the
 * extension build inputs or `null` when the package is a regular agent app.
 */
export async function tryReadExtensionBuildConfig(
  rootDir: string,
): Promise<ExtensionBuildConfig | null> {
  const appRoot = resolve(rootDir);
  let pkg: {
    name?: unknown;
    eve?: { extension?: unknown };
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  try {
    pkg = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return null;
  }

  const extensionRoot = pkg.eve?.extension;
  if (typeof extensionRoot !== "string" || extensionRoot.length === 0) {
    return null;
  }

  const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : "extension";
  const bareName = packageName.slice(packageName.lastIndexOf("/") + 1);
  const shortName = safeJsIdentifier(bareName);
  return {
    sourceRoot: resolve(appRoot, extensionRoot),
    packageName,
    shortName,
    runtimeDependencies: [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]),
    ].sort(),
  };
}

/** One managed subpath export: runnable JS plus its declaration barrel. */
interface ManagedExportTarget {
  readonly types: string;
  readonly default: string;
}

/** Subpath exports `eve extension build` manages for an extension package. */
const MANAGED_EXTENSION_EXPORTS: Readonly<Record<string, ManagedExportTarget>> = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
  "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
};

/**
 * Normalizes the extension package's `exports` map to the entries the build
 * emits so authors never hand-list them. eve owns these two subpaths, so a stale
 * value (e.g. the earlier bare-string `"./dist/index.mjs"`) is upgraded to the
 * `{ types, default }` shape; `package.json` is rewritten only when something changed.
 */
async function ensureExtensionExports(appRoot: string): Promise<void> {
  const pkgPath = join(appRoot, "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  const exports =
    typeof pkg.exports === "object" && pkg.exports !== null && !Array.isArray(pkg.exports)
      ? (pkg.exports as Record<string, unknown>)
      : {};

  let changed = false;
  for (const [subpath, target] of Object.entries(MANAGED_EXTENSION_EXPORTS)) {
    const current = exports[subpath];
    const matches =
      typeof current === "object" &&
      current !== null &&
      (current as ManagedExportTarget).types === target.types &&
      (current as ManagedExportTarget).default === target.default;
    if (!matches) {
      exports[subpath] = target;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }
  pkg.exports = exports;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * Builds an extension package into a source-free `dist/`: the mount factory
 * (`index.mjs`), the tool re-export barrel overrides use (`tools/index.mjs`),
 * every contribution as a pre-scoped `.mjs`, a `_ext-manifest.json` describing
 * them, and emitted type declarations. Fills the package `exports` map. A
 * consuming agent loads this artifact without recompiling the extension's source.
 */
export async function buildExtensionPackage(
  rootDir: string,
  config: ExtensionBuildConfig,
): Promise<string> {
  const appRoot = resolve(rootDir);
  const source = createDiskProjectSource();

  const { diagnostics, manifest } = await discoverAgent({
    agentRoot: config.sourceRoot,
    appRoot,
    source,
    role: "extension",
  });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Cannot build extension "${config.packageName}":\n${errors
        .map((diagnostic) => `  - ${diagnostic.message}`)
        .join("\n")}`,
    );
  }

  const rootEntries = await readSortedDirectoryEntries(source, config.sourceRoot);
  const declarationModule = discoverFlatModuleSource({
    rootEntries,
    rootPath: config.sourceRoot,
    slotName: "extension",
  }).module;

  if (declarationModule === undefined) {
    throw new Error(
      `Cannot build extension "${config.packageName}": its source root "${config.sourceRoot}" is missing an "extension.<ext>" declaration. Add \`export default defineExtension(...)\` there (with or without config).`,
    );
  }

  // The generated re-export barrel claims dist/tools/index.mjs; a same-named
  // contribution would be silently overwritten and break at the consumer.
  const reservedTool = manifest.tools.find(
    (tool) => toDistModulePath(tool.logicalPath) === "tools/index.mjs",
  );
  if (reservedTool !== undefined) {
    throw new Error(
      `Cannot build extension "${config.packageName}": "${reservedTool.logicalPath}" collides with the generated tool re-export barrel (dist/tools/index.mjs). Rename the file.`,
    );
  }

  const outDir = join(appRoot, "dist");
  const transactionRoot = await mkdtemp(join(appRoot, ".eve-extension-build-"));
  const stagedOutDir = join(transactionRoot, "dist");
  await mkdir(join(stagedOutDir, "tools"), { recursive: true });

  // The mount factory and its contributions must agree on the config/state key,
  // so both are scoped to the same package-derived namespace at build.
  const scopeNamespace = packageStateNamespace(config.packageName);

  try {
    await emitExtensionArtifact({
      manifest,
      appRoot,
      sourceRoot: config.sourceRoot,
      outDir: stagedOutDir,
      barrelStagingDir: join(transactionRoot, "entry-barrels"),
      packageName: config.packageName,
      shortName: config.shortName,
      declarationLogicalPath: declarationModule.logicalPath,
      scopeNamespace,
      runtimeDependencies: config.runtimeDependencies,
    });

    const typesRoot = join(stagedOutDir, "_types");
    await emitExtensionDeclarations({
      appRoot,
      sourceRoot: config.sourceRoot,
      typesRoot,
    });

    const typeSpecifierFrom = (fromDir: string, logicalPath: string): string =>
      relativeImport(
        fromDir,
        join(typesRoot, relative(appRoot, join(config.sourceRoot, logicalPath))),
      );

    await writeDeclarationBarrel({
      typesPath: join(stagedOutDir, "index.d.ts"),
      reexports: [
        { name: "default", logicalPath: declarationModule.logicalPath },
        { name: config.shortName, logicalPath: declarationModule.logicalPath },
      ].map((reexport) => ({
        name: reexport.name,
        typeSpecifier: typeSpecifierFrom(stagedOutDir, reexport.logicalPath),
      })),
    });

    await writeDeclarationBarrel({
      typesPath: join(stagedOutDir, "tools", "index.d.ts"),
      reexports: manifest.tools.map((tool) => ({
        name: toolExportName(tool.logicalPath),
        typeSpecifier: typeSpecifierFrom(join(stagedOutDir, "tools"), tool.logicalPath),
      })),
    });

    // Swap dist first so a failed build leaves package.json untouched along
    // with the previous output.
    await replaceBuildOutput({ outDir, stagedOutDir, transactionRoot });
    await ensureExtensionExports(appRoot);
    return outDir;
  } finally {
    await rm(transactionRoot, { force: true, recursive: true });
  }
}

async function replaceBuildOutput(input: {
  readonly outDir: string;
  readonly stagedOutDir: string;
  readonly transactionRoot: string;
}): Promise<void> {
  const previousOutDir = join(input.transactionRoot, "previous-dist");
  let hadPreviousOutput = false;
  try {
    await rename(input.outDir, previousOutDir);
    hadPreviousOutput = true;
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }

  try {
    await rename(input.stagedOutDir, input.outDir);
  } catch (error) {
    if (hadPreviousOutput) {
      await rename(previousOutDir, input.outDir);
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Emits the source-free distribution artifact for an extension: every
 * module-backed contribution and the two Node-facing entrypoint barrels as one
 * **code-split** namespace-scoped graph (shared extension source lands once
 * under `dist/_chunks/`, preserving module identity across contributions),
 * every skill package's files copied into `dist/`, and a
 * `dist/_ext-manifest.json` describing the contributions (base names, stamped
 * metadata) plus the eve capability versions the build was made against.
 */
async function emitExtensionArtifact(input: {
  readonly manifest: Awaited<ReturnType<typeof discoverAgent>>["manifest"];
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly outDir: string;
  /** Staging directory the generated entrypoint barrel sources are written to. */
  readonly barrelStagingDir: string;
  readonly packageName: string;
  readonly shortName: string;
  readonly declarationLogicalPath: string;
  readonly scopeNamespace: string;
  readonly runtimeDependencies: readonly string[];
}): Promise<void> {
  const base = await produceExtensionArtifactContributions({
    manifest: input.manifest,
    externalDependencies: [],
  });

  const entries: DistributionGraphEntry[] = [];
  const registerModules = <T extends { logicalPath: string; sourceId: string }>(
    definitions: readonly T[],
  ): T[] =>
    definitions.map((definition) => {
      const distLogicalPath = toDistModulePath(definition.logicalPath);
      entries.push({
        name: distLogicalPath.slice(0, -".mjs".length),
        path: join(input.sourceRoot, definition.logicalPath),
      });
      return { ...definition, logicalPath: distLogicalPath, sourceId: distLogicalPath };
    });

  const contributions: ExtensionArtifactContributions = {
    tools: registerModules(base.tools),
    dynamicTools: registerModules(base.dynamicTools),
    hooks: registerModules(base.hooks),
    connections: registerModules(base.connections),
    dynamicSkills: registerModules(base.dynamicSkills),
    dynamicInstructions: registerModules(base.dynamicInstructions),
    skills: await Promise.all(
      base.skills.map((skill) =>
        emitArtifactSkill({ skill, sourceRoot: input.sourceRoot, outDir: input.outDir }),
      ),
    ),
    instructionFragments: [...base.instructionFragments],
  };

  entries.push(
    await stageBarrelEntry({
      name: "index",
      barrelStagingDir: input.barrelStagingDir,
      sourceRoot: input.sourceRoot,
      reexports: [
        { name: "default", logicalPath: input.declarationLogicalPath },
        { name: input.shortName, logicalPath: input.declarationLogicalPath },
      ],
    }),
    await stageBarrelEntry({
      name: "tools/index",
      barrelStagingDir: input.barrelStagingDir,
      sourceRoot: input.sourceRoot,
      reexports: input.manifest.tools.map((tool) => ({
        name: toolExportName(tool.logicalPath),
        logicalPath: tool.logicalPath,
      })),
    }),
  );

  const files = await bundleAuthoredModuleGraphForDistribution({
    entries,
    packageRoot: input.appRoot,
    extensionScopeNamespace: input.scopeNamespace,
    externalDependencies: input.runtimeDependencies,
  });
  for (const [fileName, code] of files) {
    const outputPath = join(input.outDir, fileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, code, "utf8");
  }

  const artifact: ExtensionArtifact = {
    kind: EXTENSION_ARTIFACT_KIND,
    version: EXTENSION_ARTIFACT_VERSION,
    eveVersion: resolveInstalledPackageInfo().version,
    packageName: input.packageName,
    packageNamespace: input.scopeNamespace,
    capabilityVersions: deriveCapabilityVersions(base),
    contributions,
  };
  await writeExtensionArtifact(input.outDir, artifact);
}

/**
 * Writes one generated entrypoint barrel (re-exports of authored source) into
 * the transaction's staging directory and returns it as a graph entry. The
 * barrel compiles as part of the distribution graph, so the modules it
 * re-exports are shared with their own entry chunks rather than inlined.
 */
async function stageBarrelEntry(input: {
  readonly name: string;
  readonly barrelStagingDir: string;
  readonly sourceRoot: string;
  readonly reexports: readonly { readonly name: string; readonly logicalPath: string }[];
}): Promise<DistributionGraphEntry> {
  const barrelPath = join(input.barrelStagingDir, `${input.name.replaceAll("/", "__")}.mjs`);
  await mkdir(dirname(barrelPath), { recursive: true });
  const lines = input.reexports.map((reexport) =>
    reexportLine(
      reexport.name,
      relativeImport(dirname(barrelPath), join(input.sourceRoot, reexport.logicalPath)),
    ),
  );
  await writeFile(barrelPath, `${lines.join("\n")}\n`, "utf8");
  return { name: input.name, path: barrelPath };
}

/**
 * Copies a skill package's files into `dist/` (mirroring its source layout) and
 * rewrites its on-disk paths to be relative to `dist/`, so a consuming agent
 * resolves them under the installed package. Static and dynamic skills carry
 * their content in the manifest / module and pass through unchanged, except that
 * inline skill files are materialized as a skill package owned by `dist/`.
 */
async function emitArtifactSkill(input: {
  readonly skill: CompiledExtensionContributions["skills"][number];
  readonly sourceRoot: string;
  readonly outDir: string;
}): Promise<CompiledExtensionContributions["skills"][number]> {
  const { skill, sourceRoot, outDir } = input;
  const toDistRelative = (absolutePath: string): string =>
    relative(sourceRoot, absolutePath).replaceAll("\\", "/");

  if (skill.sourceKind === "skill-package") {
    const distRootPath = toDistRelative(skill.rootPath);
    await cp(skill.rootPath, join(outDir, distRootPath), { recursive: true });
    return {
      ...skill,
      rootPath: distRootPath,
      skillFilePath: toDistRelative(skill.skillFilePath),
      assetsPath: skill.assetsPath === undefined ? undefined : toDistRelative(skill.assetsPath),
      referencesPath:
        skill.referencesPath === undefined ? undefined : toDistRelative(skill.referencesPath),
      scriptsPath: skill.scriptsPath === undefined ? undefined : toDistRelative(skill.scriptsPath),
    };
  }

  if (skill.files !== undefined && Object.keys(skill.files).length > 0) {
    const resourceRoot = join(outDir, "_inline-skills");
    const normalized = normalizeSkillPackage(skill);
    await writeSkillPackageDirectory({ rootPath: resourceRoot, skill: normalized });
    const distRootPath = join("_inline-skills", "skills", skill.name).replaceAll("\\", "/");
    const hasDirectory = (name: string): boolean =>
      normalized.files.some((file) => file.relativePath.startsWith(`${name}/`));
    return {
      ...skill,
      sourceKind: "skill-package",
      sourceId: `${distRootPath}/SKILL.md`,
      logicalPath: `${distRootPath}/SKILL.md`,
      skillId: skill.name,
      rootPath: distRootPath,
      skillFilePath: `${distRootPath}/SKILL.md`,
      assetsPath: hasDirectory("assets") ? `${distRootPath}/assets` : undefined,
      referencesPath: hasDirectory("references") ? `${distRootPath}/references` : undefined,
      scriptsPath: hasDirectory("scripts") ? `${distRootPath}/scripts` : undefined,
      files: undefined,
    };
  }
  const { files: _files, ...rest } = skill;
  return rest;
}

/**
 * Derives the per-capability version stamps for the contributions an extension
 * actually ships. `config` and `state` are always stamped because every
 * extension binds config through the mount factory and bakes state scope into
 * its shipped modules.
 */
function deriveCapabilityVersions(
  contributions: CompiledExtensionContributions,
): Record<string, number> {
  const versions: Record<string, number> = {
    config: EXTENSION_CAPABILITY_VERSIONS.config,
    state: EXTENSION_CAPABILITY_VERSIONS.state,
  };
  const stamp = (kind: ExtensionCapabilityKind, present: boolean): void => {
    if (present) {
      versions[kind] = EXTENSION_CAPABILITY_VERSIONS[kind];
    }
  };
  stamp("tool", contributions.tools.length > 0);
  stamp("dynamicTool", contributions.dynamicTools.length > 0);
  stamp("hook", contributions.hooks.length > 0);
  stamp("connection", contributions.connections.length > 0);
  stamp("skill", contributions.skills.length > 0);
  stamp("dynamicSkill", contributions.dynamicSkills.length > 0);
  stamp("instructions", contributions.instructionFragments.length > 0);
  stamp("dynamicInstructions", contributions.dynamicInstructions.length > 0);
  return versions;
}

/** Rewrites an authored module's logical path to its emitted `.mjs` path. */
function toDistModulePath(logicalPath: string): string {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (logicalPath.endsWith(extension)) {
      return `${logicalPath.slice(0, logicalPath.length - extension.length)}.mjs`;
    }
  }
  return logicalPath;
}

/** Renders one `export { default as <name> } from "<specifier>"` barrel line. */
function reexportLine(name: string, specifier: string): string {
  return name === "default"
    ? `export { default } from ${JSON.stringify(specifier)};`
    : `export { default as ${name} } from ${JSON.stringify(specifier)};`;
}

/**
 * Writes one entrypoint's `.d.ts` barrel, re-exporting the emitted declarations
 * under `dist/_types/`.
 */
async function writeDeclarationBarrel(input: {
  readonly typesPath: string;
  readonly reexports: readonly { readonly name: string; readonly typeSpecifier: string }[];
}): Promise<void> {
  const header = "// Generated by eve. Do not edit by hand.";
  const declaration = [
    header,
    "",
    ...input.reexports.map((r) => reexportLine(r.name, toJsSpecifier(r.typeSpecifier))),
    "",
  ].join("\n");
  await writeFile(input.typesPath, declaration, "utf8");
}

/**
 * Renders a filesystem-relative import specifier (POSIX separators, leading
 * `./` when needed) so a generated barrel imports a sibling `dist/` file.
 */
function relativeImport(fromDir: string, targetPath: string): string {
  const rel = relative(fromDir, targetPath).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Rewrites a `.ts`-family specifier to the `.js`-family a re-export resolves. */
function toJsSpecifier(specifier: string): string {
  return specifier
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs")
    .replace(/\.tsx?$/, ".js");
}

function toolExportName(logicalPath: string): string {
  let name = logicalPath;
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension)) {
      name = name.slice(0, name.length - extension.length);
      break;
    }
  }
  return safeJsIdentifier(name.replace(/^tools\//, ""));
}

/**
 * Coerces a name into a valid JS identifier for a generated
 * `export { default as … }` binding — otherwise a tool like `get-weather.ts`
 * would emit the invalid binding `export { default as get-weather }`.
 */
function safeJsIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
