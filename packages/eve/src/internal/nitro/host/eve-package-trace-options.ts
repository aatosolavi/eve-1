import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

function isPathWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function createFindEvePackageRoot(): (path: string) => Promise<string | undefined> {
  const packageRootByDirectory = new Map<string, Promise<string | undefined>>();

  function findFromDirectory(directory: string): Promise<string | undefined> {
    const cachedPackageRoot = packageRootByDirectory.get(directory);
    if (cachedPackageRoot !== undefined) {
      return cachedPackageRoot;
    }

    const packageRoot = (async (): Promise<string | undefined> => {
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
      return parentDirectory === directory ? undefined : findFromDirectory(parentDirectory);
    })();
    packageRootByDirectory.set(directory, packageRoot);
    return packageRoot;
  }

  return (path) =>
    path.split(/[\\/]/).includes(EVE_PACKAGE_NAME)
      ? findFromDirectory(dirname(path))
      : Promise.resolve(undefined);
}

function toRelativeImportSpecifier(importer: string, imported: string): string {
  const relativePath = relative(dirname(importer), imported).replaceAll("\\", "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function createEveTraceFileReader(): (path: string) => Promise<string | null> {
  const findEvePackageRoot = createFindEvePackageRoot();

  return async (path) => {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EISDIR")
      ) {
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

    return source.replace(/(["'])#([^"']+)\1/g, (match, quote: string, specifier: string) => {
      const imported = resolve(distSourceRoot, specifier);
      return isPathWithin(imported, distSourceRoot)
        ? `${quote}${toRelativeImportSpecifier(path, imported)}${quote}`
        : match;
    });
  };
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
  return { nft: { readFile: createEveTraceFileReader() } };
}
