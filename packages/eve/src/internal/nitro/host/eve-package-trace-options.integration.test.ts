import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createEvePackageTraceOptions } from "#internal/nitro/host/eve-package-trace-options.js";

describe("eve package trace options", () => {
  it("presents package-internal imports to NFT as relative imports", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "eve-package-trace-options-"));
    const packageRoot = join(temporaryDirectory, "node_modules", "eve");
    const connectionsRoot = join(packageRoot, "dist", "src", "public", "connections");
    const entrypoint = join(connectionsRoot, "index.js");

    try {
      await mkdir(connectionsRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), '{"name":"eve"}\n');
      await writeFile(entrypoint, 'export { error } from "#public/connections/errors.js";\n');

      await expect(createEvePackageTraceOptions().nft.readFile(entrypoint)).resolves.toBe(
        'export { error } from "./errors.js";\n',
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
