import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import semver from "#compiled/semver/index.js";
import { z } from "#compiled/zod/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { formatValidationError } from "#runtime/validation.js";

/** Stable kind for an extension distribution compatibility manifest. */
export const EXTENSION_COMPATIBILITY_MANIFEST_KIND = "eve-extension";

/** Current compatibility-manifest JSON format. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION = 2;

/** Filename emitted at the root of an extension's agent-shaped dist tree. */
export const EXTENSION_COMPATIBILITY_MANIFEST_FILENAME = "_manifest.json";

/**
 * Earliest producer version this eve release remains compatible with for each
 * extension-facing capability. Raise only the capability whose contract stops
 * accepting artifacts built by older eve releases.
 */
export const EXTENSION_CAPABILITY_MINIMUM_EVE_VERSIONS = {
  extension: "0.25.0",
  tool: "0.25.0",
  dynamicTool: "0.25.0",
  connection: "0.25.0",
  hook: "0.25.0",
  skill: "0.25.0",
  dynamicSkill: "0.25.0",
  instructions: "0.25.0",
  dynamicInstructions: "0.25.0",
  config: "0.25.0",
  state: "0.25.0",
} as const;

/** One independently versioned extension-facing contract. */
export type ExtensionCapability = keyof typeof EXTENSION_CAPABILITY_MINIMUM_EVE_VERSIONS;

/** Extension-facing capabilities independently checked by the consumer. */
export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = Object.keys(
  EXTENSION_CAPABILITY_MINIMUM_EVE_VERSIONS,
) as ExtensionCapability[];

/** Capability requirements stamped by one extension build. */
export type ExtensionCapabilityRequirements = readonly ExtensionCapability[];

/** Consumer support table used to validate one extension distribution. */
export type ExtensionCapabilitySupport = Readonly<Record<string, string>>;

/** Derives producer-version ranges supported by one consuming eve release. */
export function deriveExtensionCapabilitySupport(
  consumerEveVersion: string,
): Readonly<Record<ExtensionCapability, string>> {
  const parsed = semver.parse(consumerEveVersion);
  if (parsed === null) {
    throw new Error(
      `Cannot derive extension compatibility from invalid eve version "${consumerEveVersion}".`,
    );
  }

  const upperBound = `${String(parsed.major)}.${String(parsed.minor + 1)}.0-0`;
  return Object.fromEntries(
    EXTENSION_CAPABILITIES.map((capability) => [
      capability,
      `>=${EXTENSION_CAPABILITY_MINIMUM_EVE_VERSIONS[capability]} <${upperBound}`,
    ]),
  ) as Record<ExtensionCapability, string>;
}

/**
 * Producer-version ranges this eve release can consume for each capability.
 * The upper bound follows the installed consumer's minor release, so an older
 * consumer never predicts compatibility with artifacts built by a newer one.
 */
export const EXTENSION_CAPABILITY_SUPPORT = deriveExtensionCapabilitySupport(
  resolveInstalledPackageInfo().version,
);

/** Compatibility-only metadata emitted by `eve extension build`. */
export interface ExtensionCompatibilityManifest {
  readonly kind: typeof EXTENSION_COMPATIBILITY_MANIFEST_KIND;
  readonly formatVersion: typeof EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION;
  /** Exact eve version that produced this distribution. */
  readonly builtWithEve: string;
  /** Extension-facing capabilities used by this distribution. */
  readonly requires: readonly string[];
}

/** One requirement the consuming eve cannot satisfy. */
export interface UnsupportedExtensionCapability {
  readonly capability: string;
  readonly builtWithEve: string;
  readonly supportedRange: string | undefined;
}

const uniqueCapabilityRequirements = (requirements: readonly string[]): boolean =>
  new Set(requirements).size === requirements.length;

const extensionCompatibilityManifestSchema: z.ZodType<ExtensionCompatibilityManifest> = z
  .object({
    kind: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_KIND),
    formatVersion: z.literal(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION),
    builtWithEve: z.string().refine((version) => semver.valid(version) !== null, {
      message: "Expected a valid semantic version",
    }),
    requires: z
      .array(z.string().min(1))
      .min(1)
      .refine(uniqueCapabilityRequirements, { message: "Capability requirements must be unique" }),
  })
  .strict();

/** Serializes a compatibility manifest deterministically. */
export function serializeExtensionCompatibilityManifest(
  manifest: ExtensionCompatibilityManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses and validates compatibility-manifest JSON. */
export function parseExtensionCompatibilityManifest(
  raw: string,
  manifestPath: string,
): ExtensionCompatibilityManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = extensionCompatibilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Extension compatibility manifest "${manifestPath}" is invalid. ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Reads and validates an extension compatibility manifest. */
export async function readExtensionCompatibilityManifest(
  manifestPath: string,
): Promise<ExtensionCompatibilityManifest> {
  return parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

/** Writes `_manifest.json` into an agent-shaped extension dist root. */
export async function writeExtensionCompatibilityManifest(
  distRoot: string,
  manifest: ExtensionCompatibilityManifest,
): Promise<void> {
  await writeFile(
    join(distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME),
    serializeExtensionCompatibilityManifest(manifest),
    "utf8",
  );
}

/** Finds unknown or unsupported capability requirements without executing extension code. */
export function findUnsupportedExtensionCapabilities(
  manifest: ExtensionCompatibilityManifest,
  support: ExtensionCapabilitySupport = EXTENSION_CAPABILITY_SUPPORT,
): UnsupportedExtensionCapability[] {
  return manifest.requires
    .flatMap((capability) => {
      // Manifest keys are untrusted; "toString" must fail closed, not resolve
      // through the prototype chain.
      const supportedRange = Object.hasOwn(support, capability) ? support[capability] : undefined;
      return supportedRange !== undefined &&
        semver.satisfies(manifest.builtWithEve, supportedRange, { includePrerelease: true })
        ? []
        : [{ capability, builtWithEve: manifest.builtWithEve, supportedRange }];
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
}
