import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";

import {
  compiledConnectionDefinitionSchema,
  compiledDynamicInstructionsDefinitionSchema,
  compiledDynamicSkillDefinitionSchema,
  compiledDynamicToolDefinitionSchema,
  compiledHookDefinitionSchema,
  compiledSkillSourceSchema,
  compiledToolDefinitionSchema,
  type CompiledConnectionDefinition,
  type CompiledDynamicInstructionsDefinition,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledHookDefinition,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
} from "#compiler/manifest.js";
import { formatValidationError } from "#runtime/validation.js";

/** Stable kind emitted for a source-free extension's compiled artifact. */
export const EXTENSION_ARTIFACT_KIND = "eve-extension-artifact";

/** Current source-free extension artifact schema version. */
export const EXTENSION_ARTIFACT_VERSION = 1;

/** Filename `eve extension build` writes the artifact to, under `dist/`. */
export const EXTENSION_ARTIFACT_FILENAME = "_ext-manifest.json";

/**
 * The per-extension slice of compiled contributions carried by the artifact.
 *
 * Names are the extension's own **base** names (no `<ns>__` prefix) and each
 * `logicalPath` is relative to the artifact's `dist/` root. The consuming
 * agent's compile prefixes the names with its mount namespace and rebases the
 * logical paths onto its own agent root, exactly as it does for the
 * source-recompiled path — so composition is byte-identical.
 */
export interface ExtensionArtifactContributions {
  readonly tools: readonly CompiledToolDefinition[];
  readonly dynamicTools: readonly CompiledDynamicToolDefinition[];
  readonly hooks: readonly CompiledHookDefinition[];
  readonly skills: readonly CompiledSkillDefinition[];
  readonly dynamicSkills: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicInstructions: readonly CompiledDynamicInstructionsDefinition[];
  readonly connections: readonly CompiledConnectionDefinition[];
  readonly instructionFragments: readonly string[];
}

/**
 * Compiled artifact a source-free extension ships in `dist/_ext-manifest.json`.
 *
 * It is the serialized equivalent of what discovery + compile would otherwise
 * derive by walking and executing the extension's source, so the consuming
 * agent composes the extension without recompiling it. Capability versions are
 * validated against the consumer's eve before any contribution is used.
 */
export interface ExtensionArtifact {
  readonly kind: typeof EXTENSION_ARTIFACT_KIND;
  readonly version: typeof EXTENSION_ARTIFACT_VERSION;
  /** eve version the extension was built with (for friendly messaging only). */
  readonly eveVersion: string;
  readonly packageName: string;
  /** Package-derived namespace baked into the shipped modules' state/config scope. */
  readonly packageNamespace: string;
  /** Contract version of each capability the extension uses, checked on consume. */
  readonly capabilityVersions: Record<string, number>;
  readonly contributions: ExtensionArtifactContributions;
}

const extensionArtifactContributionsSchema = z
  .object({
    tools: z.array(compiledToolDefinitionSchema),
    dynamicTools: z.array(compiledDynamicToolDefinitionSchema),
    hooks: z.array(compiledHookDefinitionSchema),
    skills: z.array(compiledSkillSourceSchema),
    dynamicSkills: z.array(compiledDynamicSkillDefinitionSchema),
    dynamicInstructions: z.array(compiledDynamicInstructionsDefinitionSchema),
    connections: z.array(compiledConnectionDefinitionSchema),
    instructionFragments: z.array(z.string()),
  })
  .strict();

/**
 * Zod schema for the versioned source-free extension artifact.
 */
export const extensionArtifactSchema: z.ZodType<ExtensionArtifact> = z
  .object({
    kind: z.literal(EXTENSION_ARTIFACT_KIND),
    version: z.literal(EXTENSION_ARTIFACT_VERSION),
    eveVersion: z.string(),
    packageName: z.string(),
    packageNamespace: z.string(),
    capabilityVersions: z.record(z.string(), z.number().int().nonnegative()),
    contributions: extensionArtifactContributionsSchema,
  })
  .strict();

/**
 * Serializes an extension artifact to the `dist/_ext-manifest.json` bytes.
 */
export function serializeExtensionArtifact(artifact: ExtensionArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/**
 * Writes the artifact to `<distDir>/_ext-manifest.json`.
 */
export async function writeExtensionArtifact(
  distDir: string,
  artifact: ExtensionArtifact,
): Promise<void> {
  await writeFile(
    join(distDir, EXTENSION_ARTIFACT_FILENAME),
    serializeExtensionArtifact(artifact),
    "utf8",
  );
}

/**
 * Reads and validates an extension artifact from a `_ext-manifest.json` path.
 * Throws a descriptive error when the file is missing or malformed.
 */
export async function readExtensionArtifact(artifactPath: string): Promise<ExtensionArtifact> {
  let raw: string;
  try {
    raw = await readFile(artifactPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read extension artifact "${artifactPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseExtensionArtifact(raw, artifactPath);
}

/**
 * Parses and validates artifact JSON text, naming the source path in errors.
 */
export function parseExtensionArtifact(raw: string, artifactPath: string): ExtensionArtifact {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Extension artifact "${artifactPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = extensionArtifactSchema.safeParse(json);
  if (!parsed.success) {
    // A recognizable artifact failing the strict schema is almost always
    // build-version skew, so name the eve that built it.
    const record =
      typeof json === "object" && json !== null ? (json as Record<string, unknown>) : undefined;
    if (record?.kind === EXTENSION_ARTIFACT_KIND) {
      const builtWith =
        typeof record.eveVersion === "string" && record.eveVersion.length > 0
          ? ` It was built with eve ${record.eveVersion}.`
          : "";
      throw new Error(
        `Extension artifact "${artifactPath}" is not readable by this version of eve.${builtWith} ` +
          `Rebuild the extension with \`eve extension build\` under a compatible eve, or align your eve version. ` +
          `${formatValidationError(parsed.error)}`,
      );
    }
    throw new Error(
      `Extension artifact "${artifactPath}" is not a valid eve extension artifact. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
