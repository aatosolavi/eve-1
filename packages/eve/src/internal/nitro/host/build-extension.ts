import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

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
  bundleAuthoredModuleCode,
  bundleAuthoredModuleForDistribution,
} from "#internal/authored-module-loader.js";

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
}

/**
 * Reads `package.json#eve.extension` from a project root, returning the
 * extension build inputs or `null` when the package is a regular agent app.
 */
export async function tryReadExtensionBuildConfig(
  rootDir: string,
): Promise<ExtensionBuildConfig | null> {
  const appRoot = resolve(rootDir);
  let pkg: { name?: unknown; eve?: { extension?: unknown } };
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

  const outDir = join(appRoot, "dist");
  await mkdir(join(outDir, "tools"), { recursive: true });

  // The mount factory and its contributions must agree on the config/state key,
  // so both are scoped to the same package-derived namespace at build.
  const scopeNamespace = packageStateNamespace(config.packageName);

  await emitExtensionArtifact({
    manifest,
    sourceRoot: config.sourceRoot,
    outDir,
    packageName: config.packageName,
    scopeNamespace,
  });

  const typesRoot = join(outDir, "_types");
  await emitDeclarations({ appRoot, typesRoot });

  const bundleSpecifierFrom = (fromDir: string, logicalPath: string): string =>
    relativeImport(fromDir, join(config.sourceRoot, logicalPath));
  const typeSpecifierFrom = (fromDir: string, logicalPath: string): string =>
    relativeImport(
      fromDir,
      join(typesRoot, relative(appRoot, join(config.sourceRoot, logicalPath))),
    );

  await emitEntrypoint({
    entryPath: join(outDir, "index.mjs"),
    typesPath: join(outDir, "index.d.ts"),
    reexports: [
      { name: "default", specifier: declarationModule.logicalPath },
      { name: config.shortName, specifier: declarationModule.logicalPath },
    ].map((reexport) => ({
      name: reexport.name,
      specifier: bundleSpecifierFrom(outDir, reexport.specifier),
      typeSpecifier: typeSpecifierFrom(outDir, reexport.specifier),
    })),
    scopeNamespace,
  });

  await emitEntrypoint({
    entryPath: join(outDir, "tools", "index.mjs"),
    typesPath: join(outDir, "tools", "index.d.ts"),
    reexports: manifest.tools.map((tool) => ({
      name: toolExportName(tool.logicalPath),
      specifier: bundleSpecifierFrom(join(outDir, "tools"), tool.logicalPath),
      typeSpecifier: typeSpecifierFrom(join(outDir, "tools"), tool.logicalPath),
    })),
    scopeNamespace,
  });

  await ensureExtensionExports(appRoot);

  return outDir;
}

/**
 * Emits declaration files for the extension's whole source tree into
 * `dist/_types/`, so a source-free package carries its own types without
 * shipping `.ts`. Runs the package's own TypeScript with the authored
 * `tsconfig.json`; a non-zero exit (e.g. a type error) fails the build.
 */
async function emitDeclarations(input: {
  readonly appRoot: string;
  readonly typesRoot: string;
}): Promise<void> {
  const tscBinary = await resolveTypeScriptBinary(input.appRoot);
  await rm(input.typesRoot, { force: true, recursive: true });
  // A type error surfaces as a non-zero exit but tsc still emits declarations;
  // authoring type-safety is the extension's own `tsc`/typecheck gate, so the
  // build only requires that emit actually produced output (checked below).
  try {
    await promisify(execFile)(
      process.execPath,
      [
        tscBinary,
        "--project",
        join(input.appRoot, "tsconfig.json"),
        "--declaration",
        "--emitDeclarationOnly",
        "--noEmit",
        "false",
        "--rootDir",
        input.appRoot,
        "--outDir",
        input.typesRoot,
      ],
      { cwd: input.appRoot },
    );
  } catch {
    // Fall through to the output check.
  }
  const emitted = await readdir(input.typesRoot).catch(() => [] as string[]);
  if (emitted.length === 0) {
    throw new Error(
      `Declaration emit produced no output. Ensure "${join(input.appRoot, "tsconfig.json")}" exists and includes the extension source.`,
    );
  }
}

/**
 * Resolves the extension's own `tsc` entry through `typescript/package.json`.
 * `typescript` does not expose `./bin/tsc` in its `exports`, so the bin path is
 * read from the manifest's `bin` field rather than resolved directly.
 */
async function resolveTypeScriptBinary(appRoot: string): Promise<string> {
  // Prefer the extension's own TypeScript; fall back to the one eve resolves so a
  // workspace extension without a local install still builds.
  for (const from of [join(appRoot, "package.json"), import.meta.url]) {
    let manifestPath: string;
    try {
      manifestPath = createRequire(from).resolve("typescript/package.json");
    } catch {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
    if (binField !== undefined) {
      return join(dirname(manifestPath), binField);
    }
  }
  throw new Error(
    "Cannot build an eve extension without TypeScript. Add `typescript` to the package's devDependencies.",
  );
}

/**
 * Emits the source-free distribution artifact for an extension: every
 * module-backed contribution as a self-contained, namespace-scoped `.mjs`, every
 * skill package's files copied into `dist/`, and a `dist/_ext-manifest.json`
 * describing the contributions (base names, stamped metadata) plus the eve
 * capability versions the build was made against.
 */
async function emitExtensionArtifact(input: {
  readonly manifest: Awaited<ReturnType<typeof discoverAgent>>["manifest"];
  readonly sourceRoot: string;
  readonly outDir: string;
  readonly packageName: string;
  readonly scopeNamespace: string;
}): Promise<void> {
  const base = await produceExtensionArtifactContributions({
    manifest: input.manifest,
    externalDependencies: [],
  });

  const emitModule = async <T extends { logicalPath: string; sourceId: string }>(
    definition: T,
  ): Promise<T> => {
    const distLogicalPath = toDistModulePath(definition.logicalPath);
    const outputPath = join(input.outDir, distLogicalPath);
    await mkdir(dirname(outputPath), { recursive: true });
    const code = await bundleAuthoredModuleForDistribution(
      join(input.sourceRoot, definition.logicalPath),
      { extensionScopeNamespace: input.scopeNamespace },
    );
    await writeFile(outputPath, code, "utf8");
    return { ...definition, logicalPath: distLogicalPath, sourceId: distLogicalPath };
  };

  const contributions: ExtensionArtifactContributions = {
    tools: await Promise.all(base.tools.map(emitModule)),
    dynamicTools: await Promise.all(base.dynamicTools.map(emitModule)),
    hooks: await Promise.all(base.hooks.map(emitModule)),
    connections: await Promise.all(base.connections.map(emitModule)),
    dynamicSkills: await Promise.all(base.dynamicSkills.map(emitModule)),
    dynamicInstructions: await Promise.all(base.dynamicInstructions.map(emitModule)),
    skills: await Promise.all(
      base.skills.map((skill) =>
        emitArtifactSkill({ skill, sourceRoot: input.sourceRoot, outDir: input.outDir }),
      ),
    ),
    instructionFragments: [...base.instructionFragments],
  };

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
 * Copies a skill package's files into `dist/` (mirroring its source layout) and
 * rewrites its on-disk paths to be relative to `dist/`, so a consuming agent
 * resolves them under the installed package. Static and dynamic skills carry
 * their content in the manifest / module and pass through unchanged, except that
 * inline skill files are rejected — they are not yet supported source-free.
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
    throw new Error(
      `The "${skill.name}" skill provides inline files, which the source-free extension build does not support yet. ` +
        `Author it as a SKILL.md skill-package directory instead.`,
    );
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

/** One `export { <name> } from "<specifier>"` line an entrypoint barrel emits. */
interface Reexport {
  /** Export binding; `"default"` emits the bare `export { default } from …`. */
  readonly name: string;
  /** Source specifier for the runnable `.mjs` barrel (bundled, so inlined). */
  readonly specifier: string;
  /** Emitted-declaration specifier for the `.d.ts` barrel (resolves in `dist/`). */
  readonly typeSpecifier: string;
}

/**
 * Emits one Node-facing entrypoint: a self-contained runnable `.mjs` (bundled
 * from the authored source with the extension namespace baked in) and a `.d.ts`
 * barrel that re-exports the emitted declarations under `dist/_types/`.
 */
async function emitEntrypoint(input: {
  readonly entryPath: string;
  readonly typesPath: string;
  readonly reexports: readonly Reexport[];
  readonly scopeNamespace: string;
}): Promise<void> {
  const header = "// Generated by eve. Do not edit by hand.";
  const line = (name: string, specifier: string): string =>
    name === "default"
      ? `export { default } from ${JSON.stringify(specifier)};`
      : `export { default as ${name} } from ${JSON.stringify(specifier)};`;

  const barrel = [header, "", ...input.reexports.map((r) => line(r.name, r.specifier)), ""].join(
    "\n",
  );
  await writeFile(input.entryPath, barrel, "utf8");
  await writeFile(
    input.entryPath,
    await bundleAuthoredModuleCode(input.entryPath, {
      extensionScopeNamespace: input.scopeNamespace,
    }),
    "utf8",
  );

  const declaration = [
    header,
    "",
    ...input.reexports.map((r) => line(r.name, toJsSpecifier(r.typeSpecifier))),
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
