import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

export function createEveVercelOptions(enabled: boolean) {
  if (!enabled) {
    return undefined;
  }

  return {
    config: {
      version: 3 as const,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    },
  };
}

/**
 * Raises the emitted app server function's `maxDuration` to the plan maximum.
 *
 * The app function serves long-lived session event streams, so its duration
 * ceiling should match the workflow function's (patched to `"max"` in
 * `workflow-bundle/builder.ts`) — otherwise streams are severed at the shorter
 * platform default and clients reconnect more often than the plan requires.
 * Nitro's typed `vercel.functions` option cannot express the Build Output
 * API's literal `"max"`, so the emitted `.vc-config.json` is patched after the
 * build instead. Missing output (a non-Vercel build) is left untouched.
 */
export async function extendVercelServerFunctionMaxDuration(outputDir: string): Promise<void> {
  const configPath = join(outputDir, "functions", "__server.func", ".vc-config.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }

  const config: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  config.maxDuration = "max";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
