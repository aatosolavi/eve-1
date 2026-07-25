import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CORE_ROOT = resolve(SOURCE_ROOT, "core");

/**
 * The core boundary rule: `core/` holds the engine-neutral programs, so a
 * core module may *value*-import only from `#core/*`. Type-only imports
 * are permitted — from `ai` (the approved SDK type surface) and from eve
 * modules whose type definitions have not yet migrated into core — because
 * they are erased at runtime and cannot smuggle engine or SDK behavior.
 */
describe("core boundary structure", () => {
  it("keeps core free of value imports from outside #core", async () => {
    const violations: string[] = [];

    for (const file of await listSourceFiles(CORE_ROOT)) {
      const source = await readFile(file, "utf8");
      for (const found of findValueImports(source)) {
        if (found.startsWith("#core/")) {
          continue;
        }
        // Relative imports stay inside core when they resolve under it.
        if (found.startsWith(".") && resolve(dirname(file), found).startsWith(CORE_ROOT + sep)) {
          continue;
        }
        violations.push(`${relative(SOURCE_ROOT, file).split(sep).join("/")} -> ${found}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "core/ modules may value-import only from #core.",
          "Move the implementation into core, keep the import type-only, or",
          "inject the value through the flow's ports instead.",
          "",
          "Value imports crossing the core boundary:",
          ...violations.map((violation) => `  - ${violation}`),
        ].join("\n"),
      );
    }
  });
});

async function listSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(resolve(entry.parentPath, entry.name));
  }
  return files;
}

/** Import specifiers with at least one runtime (non-type-only) binding. */
function findValueImports(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /^import\s+([^;]*?)\s*from\s*["']([^"']+)["']/gms;
  for (const match of source.matchAll(importRe)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (/^type\s/.test(clause)) {
      continue;
    }
    // A braces-only clause where every named binding is `type X` is
    // type-only despite the missing top-level `type` keyword.
    const braces = /^\{([^}]*)\}$/s.exec(clause.trim());
    if (braces) {
      const names = (braces[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.every((name) => name.startsWith("type "))) {
        continue;
      }
    }
    specifiers.push(specifier);
  }
  return specifiers;
}
