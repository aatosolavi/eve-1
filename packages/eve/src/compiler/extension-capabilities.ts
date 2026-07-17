/**
 * Per-capability contract versions used to gate source-free extension
 * distribution.
 *
 * A source-free extension ships a compiled artifact instead of its TypeScript
 * source, so the consumer no longer typechecks the extension's contributions
 * against its own eve. In place of that typecheck, `eve extension build` stamps
 * the version of each capability the extension uses, and the consumer's build
 * validates those stamps against its own eve — failing with a clear "rebuild the
 * extension" message on any mismatch (see {@link validateExtensionCapabilities}).
 *
 * Each entry is the contract version of one capability kind. Bump a kind's
 * version whenever a change to that capability would break an already-built
 * extension — for example a change to a compiled definition's shape, the runtime
 * binding a contribution relies on, or the state/config scoping baked into the
 * shipped `.mjs`. A mismatch is loud and actionable rather than a runtime crash.
 */
export const EXTENSION_CAPABILITY_VERSIONS = {
  tool: 1,
  dynamicTool: 1,
  connection: 1,
  hook: 1,
  skill: 1,
  dynamicSkill: 1,
  instructions: 1,
  dynamicInstructions: 1,
  /** `defineExtension` config binding through the string-keyed registry. */
  config: 1,
  /** `defineState` durable-state scoping baked into the shipped modules. */
  state: 1,
} as const;

/** One capability kind an extension can contribute or depend on. */
export type ExtensionCapabilityKind = keyof typeof EXTENSION_CAPABILITY_VERSIONS;

/**
 * Capability versions an extension recorded at its own build. Partial because an
 * extension stamps only the capabilities it actually uses.
 */
export type ExtensionCapabilityVersions = Partial<Record<ExtensionCapabilityKind, number>>;

/**
 * A capability whose stamped version disagrees with the consumer's eve.
 */
export interface ExtensionCapabilityMismatch {
  readonly kind: ExtensionCapabilityKind;
  /** Version the extension was built against. */
  readonly built: number;
  /** Version the consumer's eve currently provides. */
  readonly current: number;
}

/**
 * Compares an extension's stamped capability versions against the versions the
 * running eve provides, returning every mismatch. An empty array means the
 * artifact is compatible. Unknown capability keys (a newer extension using a
 * capability this eve does not know) are reported with `current: 0` so the
 * consumer fails rather than silently ignoring them.
 */
export function validateExtensionCapabilities(
  stamped: ExtensionCapabilityVersions,
): ExtensionCapabilityMismatch[] {
  const mismatches: ExtensionCapabilityMismatch[] = [];
  for (const [kind, built] of Object.entries(stamped)) {
    if (built === undefined) {
      continue;
    }
    const current =
      kind in EXTENSION_CAPABILITY_VERSIONS
        ? EXTENSION_CAPABILITY_VERSIONS[kind as ExtensionCapabilityKind]
        : 0;
    if (current !== built) {
      mismatches.push({ kind: kind as ExtensionCapabilityKind, built, current });
    }
  }
  return mismatches;
}
