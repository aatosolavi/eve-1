import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

function isPathWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length === 0 ||
    (!pathFromRoot.startsWith("..") && !pathFromRoot.split(/[\\/]/).includes(".."))
  );
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

function toRelativeImportSpecifier(importer: string, imported: string): string {
  const relativePath = relative(dirname(importer), imported).replaceAll("\\", "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

async function readEveTraceFile(path: string): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const packageRoot = await findEvePackageRoot(path);
  if (packageRoot === undefined) {
    return source;
  }

  const distSourceRoot = join(packageRoot, "dist", "src");
  if (!isPathWithin(path, distSourceRoot)) {
    return source;
  }

  return source.replace(/(["'])#([^"']+)\1/g, (_match, quote: string, specifier: string) => {
    const imported = resolve(distSourceRoot, specifier);
    return `${quote}${toRelativeImportSpecifier(path, imported)}${quote}`;
  });
}

/**
 * Makes eve's package-internal imports visible to nf3's NFT tracer.
 *
 * NFT cannot match eve's embedded `#*.js` import-map wildcard. It can,
 * however, trace the equivalent relative specifiers. This virtual read only
 * changes what NFT analyzes; nf3 still copies the original package files.
 */
export function createEvePackageTraceOptions(): {
  readonly nft: {
    readonly readFile: (path: string) => Promise<string | null>;
  };
} {
  return { nft: { readFile: readEveTraceFile } };
}
