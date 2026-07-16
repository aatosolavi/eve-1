import { join as joinPath, relative as relativePath } from "node:path";

import type { AgentSourceManifest, ResolvedExtensionMount } from "#discover/manifest.js";
import type {
  CompiledConnectionDefinition,
  CompiledDynamicInstructionsDefinition,
  CompiledDynamicSkillDefinition,
  CompiledDynamicToolDefinition,
  CompiledHookDefinition,
  CompiledSkillDefinition,
  CompiledToolDefinition,
} from "#compiler/manifest.js";
import type { ExtensionArtifactContributions } from "#compiler/extension-artifact.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";

/**
 * Contributions one mounted extension composes into the consuming agent,
 * already namespaced by the mount and rebased onto the consumer's agent root.
 */
export interface CompiledExtensionContributions {
  readonly tools: CompiledToolDefinition[];
  readonly dynamicTools: CompiledDynamicToolDefinition[];
  readonly hooks: CompiledHookDefinition[];
  readonly skills: CompiledSkillDefinition[];
  readonly dynamicSkills: CompiledDynamicSkillDefinition[];
  readonly dynamicInstructions: CompiledDynamicInstructionsDefinition[];
  readonly connections: CompiledConnectionDefinition[];
  readonly instructionFragments: string[];
}

/**
 * Compiles one mounted extension into the consuming agent, namespacing its
 * contributions by the mount name.
 *
 * Two mount forms produce the extension's own contributions:
 * - **Source-backed** (`mount.manifest`): the extension ships its source, so
 *   each contribution is recompiled from that source (loaded and executed) and
 *   its module-backed `logicalPath` is rebased to a consumer-relative path — the
 *   module-map codegen resolves it against the consumer's agent root, reaching
 *   into the extension package unchanged.
 * - **Source-free** (`mount.artifact`): the extension ships a pre-compiled
 *   artifact, so contributions are composed from the artifact's stamped metadata
 *   without loading or executing any extension code. The rebased `logicalPath`
 *   points at the pre-scoped `.mjs` shipped in the extension's `dist/`.
 *
 * When the mount was authored as a directory (`extensions/<ns>/`), any
 * consumer-authored override slots are composed under the same namespace and
 * win on name collision: an override tool `<ns>__search` shadows the
 * extension's own `<ns>__search`.
 */
export async function compileExtensionContributions(input: {
  readonly mount: ResolvedExtensionMount;
  readonly context: ManifestCompileContext;
  readonly consumerAgentRoot: string;
  readonly externalDependencies: readonly string[];
}): Promise<CompiledExtensionContributions> {
  const { mount, consumerAgentRoot } = input;
  const options = { externalDependencies: input.externalDependencies };

  const base = mount.artifact
    ? resolveArtifactSkillPaths(mount.artifact.contributions, mount.sourceRoot)
    : (
        await produceBaseContributions({
          manifest: expectManifest(mount),
          role: "extension",
          namespace: mount.namespace,
          options,
        })
      ).base;

  const extensionContributions = namespaceContributions({
    base,
    namespace: mount.namespace,
    sourceRoot: mount.sourceRoot,
    consumerAgentRoot,
    sourceIdScope: `ext:${mount.namespace}`,
  });

  if (mount.overrides === undefined) {
    return extensionContributions;
  }

  // Overrides are consumer-authored files, so they are NOT extension-scoped. The
  // `ext-override:` prefix keeps their module-map keys distinct from the
  // extension's own `ext:<ns>:` modules while deliberately not matching the
  // loader's `^ext:<ns>:` scope pattern, so dev and prod both treat them unscoped.
  const overridesBase = await produceBaseContributions({
    manifest: mount.overrides,
    role: "override",
    namespace: mount.namespace,
    options,
  });
  const overrideContributions = namespaceContributions({
    base: overridesBase.base,
    namespace: mount.namespace,
    sourceRoot: mount.overrides.agentRoot,
    consumerAgentRoot,
    sourceIdScope: `ext-override:${mount.namespace}`,
  });

  // Consumer overrides win: list them first so first-registration-wins dedup
  // keeps the override over the extension's same-named contribution.
  const merged = mergeContributions(overrideContributions, extensionContributions);

  const prefix = `${mount.namespace}__`;
  return applyOverrideDisables({
    merged,
    disables: overridesBase.disabledToolTargets.map((disable) => ({
      name: `${prefix}${disable.name}`,
      logicalPath: disable.logicalPath,
    })),
    extensionToolNames: new Set(extensionContributions.tools.map((tool) => tool.name)),
    extensionDynamicToolSlugs: new Set(
      extensionContributions.dynamicTools.map((tool) => tool.slug),
    ),
    namespace: mount.namespace,
  });
}

/**
 * Compiles an extension's own source tree into **base-named** contributions
 * (no mount prefix, no rebase, no source-id scope), used by `eve extension
 * build` to serialize the source-free artifact. Rejects the same
 * extension-illegal contributions the source-backed consumer path rejects.
 */
export async function produceExtensionArtifactContributions(input: {
  readonly manifest: AgentSourceManifest;
  readonly externalDependencies: readonly string[];
}): Promise<CompiledExtensionContributions> {
  const { base } = await produceBaseContributions({
    manifest: input.manifest,
    role: "extension",
    namespace: input.manifest.agentId,
    options: { externalDependencies: input.externalDependencies },
  });
  return base;
}

export interface DisabledToolTarget {
  /** Base (un-prefixed) contribution name, e.g. `search`. */
  readonly name: string;
  /** Override-relative authored path, e.g. `tools/search.ts`, for diagnostics. */
  readonly logicalPath: string;
}

interface ComposedBaseContributions {
  readonly base: CompiledExtensionContributions;
  readonly disabledToolTargets: readonly DisabledToolTarget[];
}

interface ComposeOptions {
  readonly externalDependencies: readonly string[];
}

/**
 * Removes the extension tools an override slot opted out of with `disableTool()`.
 * A `disableTool()` targets a slot by name, so it removes the extension's
 * same-named static tool or dynamic resolver — whichever kind occupies the slot.
 * A disable that matches neither throws rather than silently disabling nothing.
 *
 * Exported for unit testing.
 */
export function applyOverrideDisables(input: {
  readonly merged: CompiledExtensionContributions;
  readonly disables: readonly DisabledToolTarget[];
  readonly extensionToolNames: ReadonlySet<string>;
  readonly extensionDynamicToolSlugs: ReadonlySet<string>;
  readonly namespace: string;
}): CompiledExtensionContributions {
  if (input.disables.length === 0) {
    return input.merged;
  }
  const prefixLength = input.namespace.length + 2; // strip the `<ns>__` prefix
  const removed = new Set<string>();
  for (const disable of input.disables) {
    if (
      !input.extensionToolNames.has(disable.name) &&
      !input.extensionDynamicToolSlugs.has(disable.name)
    ) {
      const available = [...input.extensionToolNames, ...input.extensionDynamicToolSlugs]
        .map((name) => name.slice(prefixLength))
        .sort();
      throw new Error(
        `The override "agent/extensions/${input.namespace}/${disable.logicalPath}" calls disableTool(), ` +
          `but the "${input.namespace}" extension contributes no tool named "${disable.name.slice(prefixLength)}". ` +
          `It contributes: ${available.length > 0 ? available.join(", ") : "(no tools)"}.`,
      );
    }
    removed.add(disable.name);
  }
  return {
    ...input.merged,
    tools: input.merged.tools.filter((tool) => !removed.has(tool.name)),
    dynamicTools: input.merged.dynamicTools.filter((tool) => !removed.has(tool.slug)),
  };
}

/**
 * Compiles one agent-shaped manifest into **base-named** extension
 * contributions (no mount prefix, no rebase, no source-id scope). Used for both
 * the extension's own source tree and a directory mount's consumer override
 * slots; the caller applies namespacing via {@link namespaceContributions}.
 */
async function produceBaseContributions(input: {
  readonly manifest: AgentSourceManifest;
  readonly role: "extension" | "override";
  readonly namespace: string;
  readonly options: ComposeOptions;
}): Promise<ComposedBaseContributions> {
  const { manifest, role, namespace, options } = input;
  const sourceRoot = manifest.agentRoot;

  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledToolTargets: DisabledToolTarget[] = [];
  for (const source of manifest.tools) {
    const entry = await compileToolEntry(sourceRoot, source, options);
    if (entry.kind === "tool") {
      tools.push(entry.definition);
    } else if (entry.kind === "dynamic-tool") {
      dynamicTools.push(entry.definition);
    } else if (entry.kind === "workflow-tool") {
      throw new Error(
        `${describeExtensionSource(role, namespace, source.logicalPath)} enables the Workflow tool, ` +
          `but the Workflow tool is the consuming agent's to enable, not an extension's. Remove it.`,
      );
    } else if (role === "extension") {
      throw new Error(
        `${describeExtensionSource(role, namespace, source.logicalPath)} calls disableTool(), ` +
          `but an extension cannot disable framework tools — that is the consuming agent's to own. Remove it.`,
      );
    } else {
      disabledToolTargets.push({ name: entry.name, logicalPath: source.logicalPath });
    }
  }

  const hooks: CompiledHookDefinition[] = manifest.hooks.map((source) => compileHookEntry(source));

  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];
  for (const source of manifest.skills) {
    const entry = await compileSkillSource(sourceRoot, source, options);
    if (entry.kind === "skill") {
      skills.push(entry.definition);
    } else {
      dynamicSkills.push(entry.definition);
    }
  }

  const connections: CompiledConnectionDefinition[] = await Promise.all(
    manifest.connections.map((source) => compileConnectionDefinition(sourceRoot, source, options)),
  );

  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];
  const instructionFragments: string[] = [];
  for (const source of manifest.instructions) {
    const entry = await compileInstructionsEntry(sourceRoot, source, options);
    if (entry.kind === "instructions") {
      instructionFragments.push(entry.definition.markdown);
    } else {
      dynamicInstructions.push(entry.definition);
    }
  }

  return {
    base: {
      tools,
      dynamicTools,
      hooks,
      skills,
      dynamicSkills,
      dynamicInstructions,
      connections,
      instructionFragments,
    },
    disabledToolTargets,
  };
}

/**
 * Namespaces a set of base contributions into one mounted extension's composed
 * shape: prefixes every model-facing name with `<ns>__`, tags dynamic resolvers
 * with the mount namespace, scopes each source id, and rebases each
 * module-backed `logicalPath` onto the consumer's agent root.
 */
function namespaceContributions(input: {
  readonly base: CompiledExtensionContributions;
  readonly namespace: string;
  readonly sourceRoot: string;
  readonly consumerAgentRoot: string;
  readonly sourceIdScope: string;
}): CompiledExtensionContributions {
  const { base, namespace, sourceRoot, consumerAgentRoot, sourceIdScope } = input;
  const prefix = `${namespace}__`;
  const scopeSourceId = (sourceId: string): string => `${sourceIdScope}:${sourceId}`;
  const rebase = (logicalPath: string): string =>
    relativePath(consumerAgentRoot, joinPath(sourceRoot, logicalPath)).replaceAll("\\", "/");

  return {
    tools: base.tools.map((tool) => ({
      ...tool,
      name: `${prefix}${tool.name}`,
      sourceId: scopeSourceId(tool.sourceId),
      logicalPath: rebase(tool.logicalPath),
    })),
    dynamicTools: base.dynamicTools.map((tool) => ({
      ...tool,
      slug: `${prefix}${tool.slug}`,
      extensionNamespace: namespace,
      sourceId: scopeSourceId(tool.sourceId),
      logicalPath: rebase(tool.logicalPath),
    })),
    hooks: base.hooks.map((hook) => ({
      ...hook,
      slug: `${prefix}${hook.slug}`,
      sourceId: scopeSourceId(hook.sourceId),
      logicalPath: rebase(hook.logicalPath),
    })),
    skills: base.skills.map((skill) => ({
      ...skill,
      name: `${prefix}${skill.name}`,
      sourceId: scopeSourceId(skill.sourceId),
      logicalPath: rebase(skill.logicalPath),
    })),
    dynamicSkills: base.dynamicSkills.map((skill) => ({
      ...skill,
      slug: `${prefix}${skill.slug}`,
      extensionNamespace: namespace,
      sourceId: scopeSourceId(skill.sourceId),
      logicalPath: rebase(skill.logicalPath),
    })),
    dynamicInstructions: base.dynamicInstructions.map((instruction) => ({
      ...instruction,
      slug: `${prefix}${instruction.slug}`,
      sourceId: scopeSourceId(instruction.sourceId),
      logicalPath: rebase(instruction.logicalPath),
    })),
    connections: base.connections.map((connection) => ({
      ...connection,
      connectionName: `${prefix}${connection.connectionName}`,
      sourceId: scopeSourceId(connection.sourceId),
      logicalPath: rebase(connection.logicalPath),
    })),
    instructionFragments: [...base.instructionFragments],
  };
}

/**
 * Resolves a source-free artifact's dist-relative skill-package paths to
 * absolute paths under the shipped `dist/`, so consumer-side workspace
 * materialization copies the skill files exactly as it does for source skills.
 * Everything else in the artifact contributions is carried through unchanged.
 */
function resolveArtifactSkillPaths(
  contributions: ExtensionArtifactContributions,
  distRoot: string,
): CompiledExtensionContributions {
  const resolve = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : joinPath(distRoot, path);
  return {
    tools: [...contributions.tools],
    dynamicTools: [...contributions.dynamicTools],
    hooks: [...contributions.hooks],
    skills: contributions.skills.map((skill) => {
      if (skill.sourceKind !== "skill-package") {
        return { ...skill };
      }
      return {
        ...skill,
        rootPath: joinPath(distRoot, skill.rootPath),
        skillFilePath: joinPath(distRoot, skill.skillFilePath),
        assetsPath: resolve(skill.assetsPath),
        referencesPath: resolve(skill.referencesPath),
        scriptsPath: resolve(skill.scriptsPath),
      };
    }),
    dynamicSkills: [...contributions.dynamicSkills],
    dynamicInstructions: [...contributions.dynamicInstructions],
    connections: [...contributions.connections],
    instructionFragments: [...contributions.instructionFragments],
  };
}

function expectManifest(mount: ResolvedExtensionMount): AgentSourceManifest {
  if (mount.manifest === undefined) {
    throw new Error(
      `Extension mount "${mount.namespace}" (${mount.packageName}) has neither a source manifest nor a compiled artifact.`,
    );
  }
  return mount.manifest;
}

function describeExtensionSource(
  role: "extension" | "override",
  namespace: string,
  logicalPath: string,
): string {
  return role === "override"
    ? `The override "agent/extensions/${namespace}/${logicalPath}"`
    : `The "${namespace}" extension's "${logicalPath}"`;
}

/**
 * Merges two composed contribution sets with earlier-set-wins precedence per
 * composed name. Named contributions (tools, connections, skills, dynamic
 * tools) dedup by their model-facing identifier so an override shadows the
 * extension's same-named entry; unnamed contributions (hooks, dynamic skills,
 * dynamic instructions, instruction fragments) simply concatenate.
 *
 * Exported for unit testing: passing the consumer overrides as `primary` and
 * the extension's own contributions as `secondary` yields consumer-wins
 * shadowing on name collision.
 */
export function mergeContributions(
  primary: CompiledExtensionContributions,
  secondary: CompiledExtensionContributions,
): CompiledExtensionContributions {
  return {
    tools: dedupeBy([...primary.tools, ...secondary.tools], (tool) => tool.name),
    dynamicTools: dedupeBy(
      [...primary.dynamicTools, ...secondary.dynamicTools],
      (tool) => tool.slug,
    ),
    connections: dedupeBy(
      [...primary.connections, ...secondary.connections],
      (connection) => connection.connectionName,
    ),
    skills: dedupeBy([...primary.skills, ...secondary.skills], (skill) => skill.name),
    hooks: [...primary.hooks, ...secondary.hooks],
    dynamicSkills: [...primary.dynamicSkills, ...secondary.dynamicSkills],
    dynamicInstructions: [...primary.dynamicInstructions, ...secondary.dynamicInstructions],
    instructionFragments: [...primary.instructionFragments, ...secondary.instructionFragments],
  };
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const identifier = key(item);
    if (seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    result.push(item);
  }
  return result;
}
