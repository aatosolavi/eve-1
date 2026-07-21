import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createEvePackageTraceHooks } from "#internal/nitro/host/eve-package-trace-hook.js";

describe("eve package trace hooks", () => {
  it("adds the internal closure of traced public entrypoints", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "eve-package-trace-hook-"));
    const packageRoot = join(temporaryDirectory, "node_modules", "eve");
    const connectionsRoot = join(packageRoot, "dist", "src", "public", "connections");
    const entrypoint = join(connectionsRoot, "index.js");
    const errorsPath = join(connectionsRoot, "errors.js");

    try {
      await mkdir(connectionsRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), '{"name":"eve"}\n');
      await writeFile(entrypoint, 'export { error } from "#public/connections/errors.js";\n');
      await writeFile(errorsPath, 'export const error = "present";\n');
      const traceEntrypoint = relative("/", entrypoint);
      const traceErrorsPath = relative("/", errorsPath);
      const traceResult = {
        fileList: new Set([traceEntrypoint]),
        reasons: new Map([
          [
            traceEntrypoint,
            {
              ignored: false,
              parents: new Set<string>(),
              type: ["dependency"],
            },
          ],
        ]),
      };

      await createEvePackageTraceHooks().traceResult(traceResult);

      expect(traceResult.fileList).toContain(traceErrorsPath);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
