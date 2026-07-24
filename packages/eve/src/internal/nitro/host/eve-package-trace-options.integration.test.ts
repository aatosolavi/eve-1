import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createEvePackageTraceOptions,
  createFileIoThrottle,
} from "#internal/nitro/host/eve-package-trace-options.js";

describe("eve package trace options", () => {
  it("presents package-internal imports to NFT as relative imports", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "eve-package-trace-options-"));
    const packageRoot = join(temporaryDirectory, "node_modules", "eve");
    const connectionsRoot = join(packageRoot, "dist", "src", "public", "connections");
    const entrypoint = join(connectionsRoot, "index.js");

    try {
      await mkdir(connectionsRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), '{"name":"eve"}\n');
      await writeFile(
        entrypoint,
        [
          'export { error } from "#public/connections/errors.js";',
          'export { z } from "#compiled/zod/index.js";',
          'export { invalid } from "#../outside.js";',
          "",
        ].join("\n"),
      );

      await expect(createEvePackageTraceOptions().nft.readFile(entrypoint)).resolves.toBe(
        [
          'export { error } from "./errors.js";',
          'export { z } from "../../compiled/zod/index.js";',
          'export { invalid } from "#../outside.js";',
          "",
        ].join("\n"),
      );
      await expect(
        createEvePackageTraceOptions().nft.readFile(connectionsRoot),
      ).resolves.toBeNull();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("reads each traced path from disk only once", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "eve-package-trace-options-"));
    const modulePath = join(temporaryDirectory, "module.js");

    try {
      await writeFile(modulePath, "export const first = 1;\n");

      const { readFile: readTracedFile } = createEvePackageTraceOptions().nft;
      await expect(readTracedFile(modulePath)).resolves.toBe("export const first = 1;\n");

      await writeFile(modulePath, "export const second = 2;\n");

      await expect(readTracedFile(modulePath)).resolves.toBe("export const first = 1;\n");
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

describe("file IO throttle", () => {
  it("never exceeds the limit and still completes every operation", async () => {
    const withFileIoSlot = createFileIoThrottle(4);
    let active = 0;
    let peakActive = 0;

    const completed = await Promise.all(
      Array.from({ length: 64 }, (_unused, index) =>
        withFileIoSlot(async () => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          await new Promise((admit) => setTimeout(admit, 1));
          active -= 1;
          return index;
        }),
      ),
    );

    expect(peakActive).toBe(4);
    expect(completed).toEqual(Array.from({ length: 64 }, (_unused, index) => index));
  });

  it("releases its slot when an operation rejects", async () => {
    const withFileIoSlot = createFileIoThrottle(1);

    await expect(
      withFileIoSlot(() => Promise.reject(new Error("read failed"))),
    ).rejects.toThrowError("read failed");
    await expect(withFileIoSlot(() => Promise.resolve("readable"))).resolves.toBe("readable");
  });
});
