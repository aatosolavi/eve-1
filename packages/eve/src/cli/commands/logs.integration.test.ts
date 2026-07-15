import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tailSessionLogFile } from "#cli/commands/logs.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("session log tail", () => {
  it("prints the requested number of existing lines without following", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-log-tail-"));
    temporaryRoots.push(root);
    const path = join(root, "session.log");
    await writeFile(path, "one\ntwo\nthree\nfour\n", "utf8");
    const chunks: string[] = [];

    await tailSessionLogFile(path, { follow: false, lines: 2, write: (text) => chunks.push(text) });

    expect(chunks.join("")).toBe("three\nfour\n");
  });
});
