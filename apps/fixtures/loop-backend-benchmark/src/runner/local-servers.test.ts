import { describe, expect, it, vi } from "vitest";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import type { BenchmarkModelKind } from "../model-kind.js";
import {
  forceKillResidualLocalRuntimeProcessGroup,
  LocalRuntimeServerHost,
  parseServerListeningLine,
  shouldSignalLocalRuntimeProcessGroup,
  shouldStreamLocalRuntimeLogs,
  terminateLocalRuntimeProcess,
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

describe("shouldStreamLocalRuntimeLogs", () => {
  it("keeps child-process logs quiet unless verbose diagnostics are explicitly enabled", () => {
    expect(shouldStreamLocalRuntimeLogs({})).toBe(false);
    expect(shouldStreamLocalRuntimeLogs({ EVE_LOOP_BENCHMARK_VERBOSE: "0" })).toBe(false);
    expect(shouldStreamLocalRuntimeLogs({ EVE_LOOP_BENCHMARK_VERBOSE: "1" })).toBe(true);
  });
});

describe("terminateLocalRuntimeProcess", () => {
  it("does not return success unless process exit is observed", async () => {
    const signals: NodeJS.Signals[] = [];

    await expect(
      terminateLocalRuntimeProcess(
        {
          exited: new Promise<void>(() => undefined),
          hasExited: () => false,
          runtimeKind: "workflow",
          signal(signal) {
            signals.push(signal);
          },
        },
        async () => undefined,
      ),
    ).rejects.toThrow(
      "workflow local benchmark server did not exit within 2 seconds after SIGKILL",
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns after observing graceful process exit", async () => {
    vi.useFakeTimers();
    let exited = false;
    const signals: NodeJS.Signals[] = [];

    try {
      await terminateLocalRuntimeProcess({
        exited: Promise.resolve(),
        hasExited: () => exited,
        runtimeKind: "inline",
        signal(signal) {
          signals.push(signal);
          exited = true;
        },
      });

      expect(signals).toEqual(["SIGTERM"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shouldSignalLocalRuntimeProcessGroup", () => {
  it("lets eve drain its children before force-killing the detached group", () => {
    expect(shouldSignalLocalRuntimeProcessGroup("SIGTERM", "darwin")).toBe(false);
    expect(shouldSignalLocalRuntimeProcessGroup("SIGKILL", "darwin")).toBe(true);
    expect(shouldSignalLocalRuntimeProcessGroup("SIGKILL", "win32")).toBe(false);
  });
});

describe("forceKillResidualLocalRuntimeProcessGroup", () => {
  it("reaps only a residual Unix group after the eve parent exits", () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
      return true;
    };

    forceKillResidualLocalRuntimeProcessGroup(42, "darwin", kill);
    forceKillResidualLocalRuntimeProcessGroup(42, "win32", kill);

    expect(signals).toEqual([{ pid: -42, signal: "SIGKILL" }]);
  });

  it("ignores an already-empty process group", () => {
    expect(() =>
      forceKillResidualLocalRuntimeProcessGroup(42, "linux", () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }),
    ).not.toThrow();
  });
});

describe("LocalRuntimeServerHost", () => {
  it("rejects a second acquisition while the active runtime is starting or ready", async () => {
    const readiness = Promise.withResolvers<string>();
    const stop = vi.fn(async () => undefined);
    const start = vi.fn((runtimeKind: BenchmarkRuntimeKind, _modelKind: BenchmarkModelKind) =>
      fakeProcess({
        records: `${runtimeKind}-server-records\n`,
        stop,
        url: readiness.promise,
      }),
    );
    const host = new LocalRuntimeServerHost(start);

    const acquisition = host.acquire("workflow", "live");
    await expect(host.acquire("inline", "live")).rejects.toThrow(/active workflow runtime/);

    readiness.resolve("http://workflow.example");
    const lease = await acquisition;
    expect(lease).toMatchObject({
      runtimeKind: "workflow",
      targetUrl: "http://workflow.example",
    });
    await expect(lease.readRecordFile()).resolves.toBe("workflow-server-records\n");
    await expect(host.acquire("temporal", "live")).rejects.toThrow(/active workflow runtime/);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("workflow", "live");

    await lease.stop();
    await lease.stop();
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cleans up a readiness failure before allowing another runtime", async () => {
    const failedStop = vi.fn(async () => undefined);
    const nextStop = vi.fn(async () => undefined);
    const host = new LocalRuntimeServerHost((runtimeKind) => {
      if (runtimeKind === "workflow") {
        return fakeProcess({
          stop: failedStop,
          url: Promise.reject(new Error("workflow startup failed")),
        });
      }
      return fakeProcess({
        stop: nextStop,
        url: Promise.resolve(`http://${runtimeKind}.example`),
      });
    });

    await expect(host.acquire("workflow", "deterministic")).rejects.toThrow(
      "workflow startup failed",
    );
    expect(failedStop).toHaveBeenCalledOnce();

    const nextLease = await host.acquire("inline", "deterministic");
    await nextLease.stop();
    expect(nextStop).toHaveBeenCalledOnce();
  });

  it("preserves both readiness and cleanup failures", async () => {
    const startupFailure = new Error("workflow startup failed");
    const cleanupFailure = new Error("workflow cleanup failed");
    const host = new LocalRuntimeServerHost(() =>
      fakeProcess({
        stop: async () => {
          throw cleanupFailure;
        },
        url: Promise.reject(startupFailure),
      }),
    );

    const failure = await host
      .acquire("workflow", "deterministic")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupFailure, cleanupFailure]);
    await expect(host.acquire("inline", "deterministic")).rejects.toThrow(
      /active workflow runtime/,
    );
  });

  it("makes lease and host cleanup share one stop operation", async () => {
    const stopped = Promise.withResolvers<void>();
    const stop = vi.fn(async () => await stopped.promise);
    const host = new LocalRuntimeServerHost(() =>
      fakeProcess({ stop, url: Promise.resolve("http://workflow.example") }),
    );
    const lease = await host.acquire("workflow", "live");

    const leaseStop = lease.stop();
    const hostStop = host.stop();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await expect(host.acquire("inline", "live")).rejects.toThrow(/active workflow runtime/);
    stopped.resolve();

    await Promise.all([leaseStop, hostStop]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("memoizes a failed cleanup and keeps the active runtime unavailable", async () => {
    const stop = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const host = new LocalRuntimeServerHost(() =>
      fakeProcess({ stop, url: Promise.resolve("http://workflow.example") }),
    );
    const lease = await host.acquire("workflow", "live");

    const leaseStopped = expect(lease.stop()).rejects.toThrow("cleanup failed");
    const hostStopped = expect(host.stop()).rejects.toThrow("cleanup failed");
    await Promise.all([leaseStopped, hostStopped]);

    await expect(lease.stop()).rejects.toThrow("cleanup failed");
    await expect(host.acquire("inline", "live")).rejects.toThrow(/active workflow runtime/);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not let a stale lease stop a later runtime", async () => {
    const workflowStop = vi.fn(async () => undefined);
    const temporalStop = vi.fn(async () => undefined);
    const host = new LocalRuntimeServerHost((runtimeKind) =>
      fakeProcess({
        stop: runtimeKind === "workflow" ? workflowStop : temporalStop,
        url: Promise.resolve(`http://${runtimeKind}.example`),
      }),
    );

    const workflowLease = await host.acquire("workflow", "deterministic");
    await workflowLease.stop();
    const temporalLease = await host.acquire("temporal", "deterministic");

    await workflowLease.stop();
    expect(temporalStop).not.toHaveBeenCalled();

    await host.stop();
    await temporalLease.stop();
    expect(workflowStop).toHaveBeenCalledOnce();
    expect(temporalStop).toHaveBeenCalledOnce();
  });

  it("stops a process while readiness is pending and does not return its lease", async () => {
    const readiness = Promise.withResolvers<string>();
    const stop = vi.fn(async () => undefined);
    const host = new LocalRuntimeServerHost(() => fakeProcess({ stop, url: readiness.promise }));

    const acquisition = host.acquire("workflow", "deterministic");
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();

    readiness.resolve("http://workflow.example");
    await expect(acquisition).rejects.toThrow(
      "The workflow local benchmark server stopped before it became ready.",
    );

    const nextLease = await host.acquire("inline", "deterministic");
    await nextLease.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("remains idle when spawning a process throws", async () => {
    let shouldThrow = true;
    const stop = vi.fn(async () => undefined);
    const host = new LocalRuntimeServerHost(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("spawn failed");
      }
      return fakeProcess({ stop, url: Promise.resolve("http://inline.example") });
    });

    await expect(host.acquire("workflow", "deterministic")).rejects.toThrow("spawn failed");
    const lease = await host.acquire("inline", "deterministic");
    await lease.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});

function fakeProcess(input: {
  readonly records?: string;
  readonly stop: () => Promise<void>;
  readonly url: Promise<string>;
}): LocalRuntimeServerProcess {
  return {
    async readRecordFile() {
      return input.records;
    },
    async stop() {
      await input.stop();
    },
    url: input.url,
  };
}
