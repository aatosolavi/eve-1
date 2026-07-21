import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

interface MutableTraceResult {
  readonly fileList: Set<string>;
  readonly reasons: Map<
    string,
    {
      ignored: boolean;
      parents: Set<string>;
      type: string[];
    }
  >;
}

function isMutableTraceResult(value: unknown): value is MutableTraceResult {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const result = value as { fileList?: unknown; reasons?: unknown };
  return result.fileList instanceof Set && result.reasons instanceof Map;
}

function isPathWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length === 0 ||
    (!pathFromRoot.startsWith("..") && !pathFromRoot.split(/[\\/]/).includes(".."))
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findEvePackageRoot(path: string): Promise<string | undefined> {
  if (!path.split(/[\\/]/).includes(EVE_PACKAGE_NAME)) {
    return undefined;
  }

  let directory = dirname(path);
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === EVE_PACKAGE_NAME) {
        return directory;
      }
    } catch {
      // Keep walking: this directory either has no manifest or does not contain valid JSON.
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      return undefined;
    }
    directory = parentDirectory;
  }
}

function parseStaticImportSpecifiers(source: string): string[] {
  const staticImportPattern = /\b(?:import|export)\s*(?:[^;"']*?\s*from\s*)?["']([^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  return [
    ...source.matchAll(staticImportPattern),
    ...source.matchAll(dynamicImportPattern),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function resolveEveInternalImport(input: {
  readonly distSourceRoot: string;
  readonly importer: string;
  readonly specifier: string;
}): string | undefined {
  if (input.specifier.startsWith("#")) {
    return resolve(input.distSourceRoot, input.specifier.slice(1));
  }

  if (input.specifier.startsWith(".")) {
    return resolve(dirname(input.importer), input.specifier);
  }

  return undefined;
}

async function collectEveInternalClosure(input: {
  readonly distSourceRoot: string;
  readonly entrypoints: readonly string[];
}): Promise<Set<string>> {
  const closure = new Set<string>();
  const pending = [...input.entrypoints];

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || closure.has(path) || !isPathWithin(path, input.distSourceRoot)) {
      continue;
    }
    if (!(await isFile(path))) {
      continue;
    }

    closure.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of parseStaticImportSpecifiers(source)) {
      const resolved = resolveEveInternalImport({
        distSourceRoot: input.distSourceRoot,
        importer: path,
        specifier,
      });
      if (resolved !== undefined) {
        pending.push(resolved);
      }
    }
  }

  return closure;
}

/**
 * Extends nf3's trace with eve's package-internal import closure.
 *
 * nf3's vendored resolver cannot match eve's embedded `#*.js` import-map
 * wildcard, so external packages that import an eve public subpath would
 * otherwise ship only that entrypoint.
 */
export function createEvePackageTraceHooks(): {
  readonly traceResult: (result: unknown) => Promise<void>;
} {
  return {
    async traceResult(value: unknown): Promise<void> {
      if (!isMutableTraceResult(value)) {
        return;
      }

      const packageEntrypoints = new Map<string, string[]>();
      for (const tracePath of value.fileList) {
        const entrypoint = resolve("/", tracePath);
        const packageRoot = await findEvePackageRoot(entrypoint);
        if (packageRoot === undefined) {
          continue;
        }

        const entrypoints = packageEntrypoints.get(packageRoot) ?? [];
        entrypoints.push(entrypoint);
        packageEntrypoints.set(packageRoot, entrypoints);
      }

      for (const [packageRoot, entrypoints] of packageEntrypoints) {
        const closure = await collectEveInternalClosure({
          distSourceRoot: join(packageRoot, "dist", "src"),
          entrypoints,
        });
        for (const path of closure) {
          const tracePath = relative("/", path);
          value.fileList.add(tracePath);
          value.reasons.set(tracePath, {
            ignored: false,
            parents: new Set(),
            type: ["dependency"],
          });
        }
      }
    },
  };
}
