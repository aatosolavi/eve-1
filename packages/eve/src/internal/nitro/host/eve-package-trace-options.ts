import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/** Matches NFT's own `fileIOConcurrency` default. */
const FILE_IO_CONCURRENCY = 1024;

function isPathWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

/**
 * Caps how many filesystem operations may be in flight at once.
 *
 * Returns a wrapper that admits an operation immediately when the limit has
 * spare capacity and otherwise queues it. A finishing operation hands its slot
 * directly to the next waiter, so the limit is never exceeded.
 */
export function createFileIoThrottle(
  limit: number,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (operation) => {
    if (active >= limit) {
      // The releasing operation hands its slot over instead of decrementing.
      await new Promise<void>((admit) => waiting.push(admit));
    } else {
      active += 1;
    }

    try {
      return await operation();
    } finally {
      const admitNext = waiting.shift();
      if (admitNext === undefined) {
        active -= 1;
      } else {
        admitNext();
      }
    }
  };
}

function createFindEvePackageRoot(
  readSource: (path: string) => Promise<string>,
): (path: string) => Promise<string | undefined> {
  const packageRootByDirectory = new Map<string, Promise<string | undefined>>();

  function findFromDirectory(directory: string): Promise<string | undefined> {
    const cachedPackageRoot = packageRootByDirectory.get(directory);
    if (cachedPackageRoot !== undefined) {
      return cachedPackageRoot;
    }

    const packageRoot = (async (): Promise<string | undefined> => {
      try {
        const packageJson = JSON.parse(await readSource(join(directory, "package.json"))) as {
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
  const withFileIoSlot = createFileIoThrottle(FILE_IO_CONCURRENCY);
  const readSource = (path: string): Promise<string> =>
    withFileIoSlot(() => readFile(path, "utf8"));
  const findEvePackageRoot = createFindEvePackageRoot(readSource);
  const sourceByPath = new Map<string, Promise<string | null>>();

  async function readTracedSource(path: string): Promise<string | null> {
    let source: string;
    try {
      source = await readSource(path);
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
  }

  return (path) => {
    const cachedSource = sourceByPath.get(path);
    if (cachedSource !== undefined) {
      return cachedSource;
    }

    const source = readTracedSource(path);
    sourceByPath.set(path, source);
    return source;
  };
}

/**
 * Makes eve's package-internal imports visible to nf3's NFT tracer.
 *
 * NFT cannot match eve's embedded `#*.js` import-map wildcard. It can,
 * however, trace the equivalent relative specifiers. This virtual read only
 * changes what NFT analyzes; nf3 still copies the original package files.
 *
 * Supplying `readFile` replaces NFT's cached filesystem wholesale, so this
 * reader has to memoize and throttle on its own: NFT re-reads the same
 * manifests once per resolution and fans reads out with unbounded recursion.
 */
export function createEvePackageTraceOptions(): {
  readonly nft: {
    readonly readFile: (path: string) => Promise<string | null>;
  };
} {
  return { nft: { readFile: createEveTraceFileReader() } };
}
