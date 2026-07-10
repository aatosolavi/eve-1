import { describe, expect, it, vi } from "vitest";

import {
  LocalRuntimeServerGroup,
  parseServerListeningLine,
  type LocalRuntimeServerProcess,
} from "./local-servers.js";

describe("parseServerListeningLine", () => {
  it.each([
    ["server listening at http://127.0.0.1:3100", "http://127.0.0.1:3100/"],
    ["[START] server listening at https://preview.example", "https://preview.example/"],
    [
      "\u001B[32m[START]\u001B[0m server listening at http://127.0.0.1:4100",
      "http://127.0.0.1:4100/",
    ],
  ])("parses the exact eve start listening line", (line, expected) => {
    expect(parseServerListeningLine(line)).toBe(expected);
  });

  it.each([
    "prefix server listening at http://127.0.0.1:3100",
    "server listening on http://127.0.0.1:3100",
    "server listening at http://127.0.0.1:3100 trailing",
    "server listening at not-a-url",
  ])("rejects a non-contract line: %s", (line) => {
    expect(parseServerListeningLine(line)).toBeUndefined();
  });
});

describe("LocalRuntimeServerGroup", () => {
  it("starts all three runtimes and stops each process once", async () => {
    const stopped: string[] = [];
    const start = vi.fn(
      (runtimeKind: "inline" | "temporal" | "workflow", _modelKind: "deterministic" | "live") =>
        fakeProcess(`http://${runtimeKind}.example`, () => stopped.push(runtimeKind)),
    );
    const group = new LocalRuntimeServerGroup(start);

    await expect(group.start("live")).resolves.toEqual({
      inline: "http://inline.example",
      temporal: "http://temporal.example",
      workflow: "http://workflow.example",
    });
    expect(start.mock.calls.map(([runtime]) => runtime)).toEqual([
      "inline",
      "workflow",
      "temporal",
    ]);
    expect(start.mock.calls.map(([, modelKind]) => modelKind)).toEqual(["live", "live", "live"]);
    await expect(group.readRecordFile("workflow")).resolves.toBe("workflow-server-records\n");

    await group.stop();
    await group.stop();
    expect(stopped.toSorted()).toEqual(["inline", "temporal", "workflow"]);
  });

  it("stops every process when one runtime fails to become ready", async () => {
    const stopped: string[] = [];
    const group = new LocalRuntimeServerGroup((runtimeKind) => ({
      async readRecordFile() {
        return undefined;
      },
      async stop() {
        stopped.push(runtimeKind);
      },
      url:
        runtimeKind === "workflow"
          ? Promise.reject(new Error("workflow startup failed"))
          : Promise.resolve(`http://${runtimeKind}.example`),
    }));

    await expect(group.start("deterministic")).rejects.toThrow("workflow startup failed");
    expect(stopped.toSorted()).toEqual(["inline", "temporal", "workflow"]);
  });

  it("stops processes that started before a later spawn throws", async () => {
    const stopInline = vi.fn(async () => undefined);
    const group = new LocalRuntimeServerGroup((runtimeKind) => {
      if (runtimeKind === "workflow") throw new Error("spawn failed");
      return fakeProcess(`http://${runtimeKind}.example`, stopInline);
    });

    await expect(group.start("deterministic")).rejects.toThrow("spawn failed");
    expect(stopInline).toHaveBeenCalledOnce();
  });
});

function fakeProcess(url: string, stop: () => void): LocalRuntimeServerProcess {
  return {
    async readRecordFile() {
      return `${new URL(url).hostname.split(".")[0]}-server-records\n`;
    },
    async stop() {
      stop();
    },
    url: Promise.resolve(url),
  };
}
