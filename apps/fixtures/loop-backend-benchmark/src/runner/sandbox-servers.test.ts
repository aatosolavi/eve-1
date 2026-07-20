import { describe, expect, it, vi } from "vitest";

import type { ParsedRunnerConfig } from "./config.js";
import {
  type BenchmarkSandbox,
  type BenchmarkSandboxCommand,
  type BenchmarkSandboxCreateInput,
  type BenchmarkSandboxRunCommandInput,
  SandboxRuntimeServerHost,
} from "./sandbox-servers.js";

const FULL_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("SandboxRuntimeServerHost", () => {
  it("prepares once and runs at most one direct eve runtime command at a time", async () => {
    const createInputs: BenchmarkSandboxCreateInput[] = [];
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const healthRequests: string[] = [];
    const recordReads: string[] = [];
    const runtimeCommands: Array<{
      readonly kill: ReturnType<typeof vi.fn<(signal: "SIGTERM") => Promise<void>>>;
      readonly runtimeKind: string;
      readonly wait: ReturnType<typeof vi.fn<() => Promise<{ readonly exitCode: number }>>>;
    }> = [];
    let activeCommands = 0;
    let maximumActiveCommands = 0;
    const stop = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({
      commands,
      createDetachedCommand(input) {
        const runtimeKind = input.env?.EVE_LOOP_BENCHMARK_RUNTIME ?? "unknown";
        activeCommands += 1;
        maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
        const kill = vi.fn(async (_signal: "SIGTERM") => undefined);
        const wait = vi.fn(async () => {
          activeCommands -= 1;
          return { exitCode: 0 };
        });
        runtimeCommands.push({ kill, runtimeKind, wait });
        return runningCommand({ kill, wait });
      },
      recordReads,
      stop,
    });
    const host = new SandboxRuntimeServerHost({
      async createSandbox(input) {
        createInputs.push(input);
        return sandbox;
      },
      async fetch(input) {
        healthRequests.push(String(input));
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await expect(host.prepare(sandboxConfig())).resolves.toEqual({
      memoryMb: 8192,
      name: "benchmark-sandbox",
      region: "iad1",
      runtime: "node24",
      vcpus: 4,
    });
    expect(createInputs).toEqual([
      {
        persistent: false,
        ports: [8080, 8081, 8082],
        resources: { vcpus: 4 },
        runtime: "node24",
        source: {
          depth: 1,
          revision: FULL_COMMIT_SHA,
          type: "git",
          url: "https://github.com/vercel/eve.git",
        },
        timeout: 2_700_000,
      },
    ]);
    expect(commands).toEqual([
      {
        args: ["pnpm", "install", "--frozen-lockfile"],
        cmd: "corepack",
        cwd: "/vercel/sandbox",
      },
      {
        args: ["pnpm", "--filter", "loop-backend-benchmark...", "build"],
        cmd: "corepack",
        cwd: "/vercel/sandbox",
        env: {
          AI_GATEWAY_API_KEY: "gateway-test-key",
          EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
        },
      },
    ]);

    const inline = await host.acquire("inline");
    expect(inline).toMatchObject({
      runtimeKind: "inline",
      targetUrl: "https://inline.sandbox.example",
    });
    expect(commands.at(-1)).toEqual({
      args: [
        "/vercel/sandbox/packages/eve/bin/eve.js",
        "start",
        "--host",
        "0.0.0.0",
        "--port",
        "8080",
      ],
      cmd: "node",
      cwd: "/vercel/sandbox/apps/fixtures/loop-backend-benchmark",
      detached: true,
      env: {
        AI_GATEWAY_API_KEY: "gateway-test-key",
        EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
        EVE_LOOP_BENCHMARK_RECORD_PATH: "/tmp/eve-loop-benchmark-inline.jsonl",
        EVE_LOOP_BENCHMARK_RUNTIME: "inline",
        EVE_LOOP_BENCHMARK_TARGET: "vercel",
        VERCEL_PROJECT_ID: "prj_benchmark",
        VERCEL_TARGET_ENV: "development",
        WORKFLOW_LOCAL_DATA_DIR: "/tmp/eve-loop-benchmark-inline-workflow-data",
      },
    });
    await expect(host.acquire("workflow")).rejects.toThrow("already has an active inline runtime");
    await expect(inline.readRecordFile()).resolves.toBe("inline-record\n");
    expect(recordReads).toEqual(["/tmp/eve-loop-benchmark-inline.jsonl"]);

    await inline.stop();
    await inline.stop();
    expect(runtimeCommands[0]?.kill).toHaveBeenCalledOnce();
    expect(runtimeCommands[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runtimeCommands[0]?.wait).toHaveBeenCalledOnce();

    const workflow = await host.acquire("workflow");
    await inline.stop();
    expect(runtimeCommands[1]?.kill).not.toHaveBeenCalled();
    await workflow.stop();

    expect(maximumActiveCommands).toBe(1);
    expect(runtimeCommands.map((command) => command.runtimeKind)).toEqual(["inline", "workflow"]);
    expect(healthRequests).toEqual([
      "https://inline.sandbox.example/eve/v1/health",
      "https://workflow.sandbox.example/eve/v1/health",
    ]);
    await expect(inline.readRecordFile()).rejects.toThrow("lease is no longer active");

    await host.stop();
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("kills and waits for a runtime that never becomes ready", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    let now = 0;
    const kill = vi.fn(async (_signal: "SIGTERM") => undefined);
    const wait = vi.fn(async () => ({ exitCode: 0 }));
    const stop = vi.fn(async () => undefined);
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands,
          createDetachedCommand: () => runningCommand({ kill, wait }),
          recordReads: [],
          stop,
        }),
      async fetch() {
        return Response.json({ ok: false, status: "starting" }, { status: 503 });
      },
      now: () => now,
      sleep: async () => {
        now = 120_000;
      },
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    await expect(host.acquire("temporal")).rejects.toThrow(
      "temporal runtime did not become ready within 120 seconds",
    );
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(wait).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent acquire before the first runtime command is published", async () => {
    let publishCommand: ((command: BenchmarkSandboxCommand) => void) | undefined;
    const command = new Promise<BenchmarkSandboxCommand>((resolve) => {
      publishCommand = resolve;
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          runCommand: async (input) =>
            input.detached === true ? await command : finishedCommand(0),
          stop: vi.fn(async () => undefined),
        }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const acquiring = host.acquire("inline");
    await expect(host.acquire("workflow")).rejects.toThrow("already starting the inline runtime");
    publishCommand?.(runningCommand());
    const lease = await acquiring;

    await lease.stop();
    await host.stop();
  });

  it("stops and poisons the Sandbox when runtime command publication fails", async () => {
    const sandboxStop = vi.fn(async () => undefined);
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          runCommand: async (input) => {
            if (input.detached === true) throw new Error("runtime command publication failed");
            return finishedCommand(0);
          },
          stop: sandboxStop,
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());

    await expect(host.acquire("inline")).rejects.toThrow("runtime command publication failed");
    expect(sandboxStop).toHaveBeenCalledOnce();
    await expect(host.acquire("workflow")).rejects.toThrow("cleanup has started");
  });

  it("preserves runtime publication and Sandbox cleanup failures", async () => {
    const sandboxStop = vi.fn(async () => {
      throw new Error("sandbox stop failed");
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          runCommand: async (input) => {
            if (input.detached === true) throw new Error("runtime command publication failed");
            return finishedCommand(0);
          },
          stop: sandboxStop,
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const failure = await host.acquire("workflow").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected an AggregateError.");
    expect(failure.errors.map(String)).toEqual([
      "Error: runtime command publication failed",
      "Error: sandbox stop failed",
    ]);
    const laterStopFailure = await host.stop().catch((error: unknown) => error);
    expect(failure.errors[1]).toBe(laterStopFailure);
    expect(sandboxStop).toHaveBeenCalledOnce();
  });

  it("stops the Sandbox only after an in-flight runtime command is published", async () => {
    const events: string[] = [];
    const publishedCommand = Promise.withResolvers<BenchmarkSandboxCommand>();
    const sandboxStop = vi.fn(async () => {
      events.push("sandbox:stop");
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          async runCommand(input) {
            if (input.detached !== true) return finishedCommand(0);
            events.push("runtime:publishing");
            const command = await publishedCommand.promise;
            events.push("runtime:published");
            return command;
          },
          stop: sandboxStop,
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const acquiring = host.acquire("inline");
    await vi.waitFor(() => expect(events).toEqual(["runtime:publishing"]));

    const stopping = host.stop();
    await vi.waitFor(() => expect(sandboxStop).not.toHaveBeenCalled());
    publishedCommand.resolve(runningCommand());

    await stopping;
    await expect(acquiring).rejects.toThrow("cleanup started before the runtime became active");
    expect(events).toEqual(["runtime:publishing", "runtime:published", "sandbox:stop"]);
    expect(sandboxStop).toHaveBeenCalledOnce();
  });

  it("stops the Sandbox only after an in-flight record read settles", async () => {
    const events: string[] = [];
    const recordRead = Promise.withResolvers<Buffer | null>();
    const sandboxStop = vi.fn(async () => {
      events.push("sandbox:stop");
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          async readFileToBuffer() {
            events.push("record:reading");
            const result = await recordRead.promise;
            events.push("record:read");
            return result;
          },
          recordReads: [],
          stop: sandboxStop,
        }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const lease = await host.acquire("workflow");
    const reading = lease.readRecordFile();
    await vi.waitFor(() => expect(events).toEqual(["record:reading"]));

    const stopping = host.stop();
    await vi.waitFor(() => expect(sandboxStop).not.toHaveBeenCalled());
    recordRead.resolve(Buffer.from("workflow-record\n"));

    await stopping;
    await expect(reading).rejects.toThrow("cleanup started before the record read completed");
    expect(events).toEqual(["record:reading", "record:read", "sandbox:stop"]);
    expect(sandboxStop).toHaveBeenCalledOnce();
  });

  it("preserves readiness and runtime cleanup failures", async () => {
    let now = 0;
    const stop = vi.fn(async () => undefined);
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          createDetachedCommand: () =>
            runningCommand({
              kill: vi.fn(async () => {
                throw new Error("runtime kill failed");
              }),
            }),
          recordReads: [],
          stop,
        }),
      async fetch() {
        return Response.json({ ok: false, status: "starting" }, { status: 503 });
      },
      now: () => now,
      sleep: async () => {
        now = 120_000;
      },
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    let failure: unknown;
    try {
      await host.acquire("workflow");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected an AggregateError.");
    expect(failure.message).toBe("workflow runtime readiness failed and cleanup also failed.");
    expect(failure.errors.map(String)).toEqual([
      expect.stringContaining("workflow runtime did not become ready within 120 seconds"),
      "Error: runtime kill failed",
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("bounds runtime shutdown and stops the Sandbox when wait hangs", async () => {
    const kill = vi.fn(async (_signal: "SIGTERM") => undefined);
    const wait = vi.fn(
      async () => await new Promise<{ readonly exitCode: number }>(() => undefined),
    );
    const stop = vi.fn(async () => undefined);
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          createDetachedCommand: () => runningCommand({ kill, wait }),
          recordReads: [],
          stop,
        }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const lease = await host.acquire("temporal");

    vi.useFakeTimers();
    try {
      const stopping = lease.stop();
      const stopped = stopping.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(stopped).resolves.toMatchObject({
        message: "temporal runtime did not stop within 15 seconds.",
      });
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(wait).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      await expect(host.acquire("inline")).rejects.toThrow("cleanup has started");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves runtime and Sandbox cleanup failures and remains unavailable", async () => {
    const sensitiveValue = "cleanup-sensitive-value";
    const stop = vi.fn(async () => {
      throw new Error("sandbox stop failed");
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          createDetachedCommand: () =>
            runningCommand({
              kill: vi.fn(async () => {
                throw new Error(`kill failed with ${sensitiveValue}`);
              }),
              wait: vi.fn(async () => ({ exitCode: 0 })),
            }),
          recordReads: [],
          stop,
        }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare({
      ...sandboxConfig(),
      modelCredential: { name: "AI_GATEWAY_API_KEY", value: sensitiveValue },
    });
    const lease = await host.acquire("inline");

    let failure: unknown;
    try {
      await lease.stop();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected an AggregateError.");
    expect(failure.message).toBe(
      "inline runtime cleanup failed and Vercel Sandbox cleanup also failed.",
    );
    expect(failure.errors.map(String)).toEqual([
      "Error: kill failed with [redacted]",
      "Error: sandbox stop failed",
    ]);
    const laterStopFailure = await host.stop().catch((error: unknown) => error);
    expect(failure.errors[1]).toBe(laterStopFailure);
    expect(stop).toHaveBeenCalledOnce();
    await expect(host.acquire("workflow")).rejects.toThrow("cleanup has started");
  });

  it("stops during runtime readiness without publishing a lease", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const stop = vi.fn(async () => undefined);
    let resolveHealth: ((response: Response) => void) | undefined;
    const health = new Promise<Response>((resolve) => {
      resolveHealth = resolve;
    });
    const fetchStarted = Promise.withResolvers<void>();
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () => fakeSandbox({ commands, recordReads: [], stop }),
      async fetch() {
        fetchStarted.resolve();
        return await health;
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare(sandboxConfig());
    const acquiring = host.acquire("workflow");
    await fetchStarted.promise;
    const stopping = host.stop();
    resolveHealth?.(Response.json({ ok: true, status: "ready" }));

    await stopping;
    await expect(acquiring).rejects.toThrow("cleanup started before runtime readiness completed");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("waits for in-flight creation and stops before setup continues", async () => {
    const stop = vi.fn(async () => undefined);
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const sandbox = fakeSandbox({ commands, recordReads: [], stop });
    let resolveSandbox: ((sandbox: BenchmarkSandbox) => void) | undefined;
    const created = new Promise<BenchmarkSandbox>((resolve) => {
      resolveSandbox = resolve;
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () => await created,
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    const preparing = host.prepare(sandboxConfig());
    const stopping = host.stop();
    resolveSandbox?.(sandbox);

    await stopping;
    await expect(preparing).rejects.toThrow("cleanup started before server setup completed");
    expect(commands).toHaveLength(0);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the Sandbox after an in-flight install settles and does not start the build", async () => {
    const events: string[] = [];
    const installResult = Promise.withResolvers<BenchmarkSandboxCommand>();
    const sandboxStop = vi.fn(async () => {
      events.push("sandbox:stop");
    });
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          async runCommand(input) {
            if (input.args[0] === "pnpm" && input.args[1] === "install") {
              events.push("install:running");
              const command = await installResult.promise;
              events.push("install:settled");
              return command;
            }
            events.push("build:started");
            return finishedCommand(0);
          },
          stop: sandboxStop,
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    const preparing = host.prepare(sandboxConfig());
    await vi.waitFor(() => expect(events).toEqual(["install:running"]));

    const stopping = host.stop();
    await vi.waitFor(() => expect(sandboxStop).not.toHaveBeenCalled());
    installResult.resolve(finishedCommand(0));

    await stopping;
    await expect(preparing).rejects.toThrow("cleanup started before dependency installation");
    expect(events).toEqual(["install:running", "install:settled", "sandbox:stop"]);
    expect(sandboxStop).toHaveBeenCalledOnce();
  });

  it("does not duplicate a failed Sandbox stop observed by in-flight setup", async () => {
    const installResult = Promise.withResolvers<BenchmarkSandboxCommand>();
    const installStarted = Promise.withResolvers<void>();
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          async runCommand(input) {
            if (input.args[0] === "pnpm" && input.args[1] === "install") {
              installStarted.resolve();
              return await installResult.promise;
            }
            return finishedCommand(0);
          },
          stop: async () => {
            throw new Error("sandbox stop failed");
          },
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    const preparing = host.prepare(sandboxConfig());
    await installStarted.promise;
    const stopping = host.stop();
    installResult.resolve(finishedCommand(0));

    const stopFailure = await stopping.catch((error: unknown) => error);
    const prepareFailure = await preparing.catch((error: unknown) => error);
    expect(String(stopFailure)).toBe("Error: sandbox stop failed");
    expect(prepareFailure).toBe(stopFailure);
  });

  it("separates private-source auth and preserves the model credential name", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const createSandbox = vi.fn(async () =>
      fakeSandbox({ commands, recordReads: [], stop: vi.fn(async () => undefined) }),
    );
    const host = new SandboxRuntimeServerHost({
      createSandbox,
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare({
      ...sandboxConfig(),
      modelCredential: { name: "VERCEL_OIDC_TOKEN", value: "oidc-test-token" },
      gitToken: "git-test-token",
      gitUrl: "https://github.example/acme/eve.git",
      gitUsername: "benchmark-bot",
    });
    const lease = await host.acquire("workflow");

    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          password: "git-test-token",
          username: "benchmark-bot",
        }),
      }),
    );
    expect(commands[1]?.env).toEqual(
      expect.objectContaining({ VERCEL_OIDC_TOKEN: "oidc-test-token" }),
    );
    expect(commands[2]?.env).toEqual(
      expect.objectContaining({ VERCEL_OIDC_TOKEN: "oidc-test-token" }),
    );
    expect(JSON.stringify(commands)).not.toContain("git-test-token");

    await lease.stop();
    await host.stop();
  });

  it("forwards the deterministic model kind without a model credential", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({ commands, recordReads: [], stop: vi.fn(async () => undefined) }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await host.prepare({
      gitRevision: FULL_COMMIT_SHA,
      gitUrl: "https://github.com/vercel/eve.git",
      measuredBlocks: 2,
      modelKind: "deterministic",
      mode: "sandbox",
      seed: 7,
      vercelOidc: {
        environment: "development",
        projectId: "prj_benchmark",
        token: "oidc-test-token",
      },
      warmupBlocks: 1,
    });
    const lease = await host.acquire("inline");

    expect(commands.slice(1).map((command) => command.env)).toEqual([
      { EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" },
      expect.objectContaining({ EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" }),
    ]);
    expect(JSON.stringify(commands)).not.toContain("AI_GATEWAY_API_KEY");
    expect(JSON.stringify(commands)).not.toContain("VERCEL_OIDC_TOKEN");
    expect(JSON.stringify(commands)).not.toContain("oidc-test-token");

    await lease.stop();
    await host.stop();
  });

  it("stops the Sandbox when setup fails and redacts configured credentials", async () => {
    const aiCredential = "gateway-sensitive-value";
    const gitCredential = "git-sensitive-value";
    const routeCredential = "route-sensitive-value";
    const diagnostics: string[] = [];
    const stop = vi.fn(async () => undefined);
    let commandIndex = 0;
    const host = new SandboxRuntimeServerHost({
      createSandbox: async () =>
        fakeSandbox({
          commands: [],
          recordReads: [],
          runCommand: async () => {
            commandIndex += 1;
            return commandIndex === 1
              ? finishedCommand(0)
              : finishedCommand(
                  1,
                  `build stdout ${aiCredential}`,
                  `build stderr ${routeCredential}`,
                );
          },
          stop,
        }),
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic(message) {
        diagnostics.push(message);
      },
    });

    let failure: unknown;
    try {
      await host.prepare({
        ...sandboxConfig(),
        modelCredential: { name: "AI_GATEWAY_API_KEY", value: aiCredential },
        gitToken: gitCredential,
        gitUsername: "benchmark-bot",
        vercelOidc: {
          environment: "development",
          projectId: "prj_benchmark",
          token: routeCredential,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("workspace build failed with exit code 1");
    expect(String(failure)).toContain("[redacted]");
    expect(String(failure)).not.toContain(aiCredential);
    expect(String(failure)).not.toContain(gitCredential);
    expect(String(failure)).not.toContain(routeCredential);
    expect(diagnostics.join("\n")).not.toContain(aiCredential);
    expect(diagnostics.join("\n")).not.toContain(gitCredential);
    expect(diagnostics.join("\n")).not.toContain(routeCredential);
    expect(stop).toHaveBeenCalledOnce();
  });
});

function sandboxConfig(): Extract<ParsedRunnerConfig, { readonly mode: "sandbox" }> & {
  readonly modelCredential: { readonly name: "AI_GATEWAY_API_KEY"; readonly value: string };
  readonly modelKind: "live";
} {
  return {
    gitRevision: FULL_COMMIT_SHA,
    gitUrl: "https://github.com/vercel/eve.git",
    measuredBlocks: 2,
    modelCredential: { name: "AI_GATEWAY_API_KEY", value: "gateway-test-key" },
    modelKind: "live",
    mode: "sandbox",
    seed: 7,
    vercelOidc: {
      environment: "development",
      projectId: "prj_benchmark",
      token: "oidc-test-token",
    },
    warmupBlocks: 1,
  };
}

function fakeSandbox(input: {
  readonly commands: BenchmarkSandboxRunCommandInput[];
  readonly createDetachedCommand?: (
    command: BenchmarkSandboxRunCommandInput,
  ) => BenchmarkSandboxCommand;
  readonly readFileToBuffer?: (file: { readonly path: string }) => Promise<Buffer | null>;
  readonly recordReads: string[];
  readonly runCommand?: (
    command: BenchmarkSandboxRunCommandInput,
  ) => Promise<BenchmarkSandboxCommand>;
  readonly stop: () => Promise<void>;
}): BenchmarkSandbox {
  const records = new Map([
    ["/tmp/eve-loop-benchmark-inline.jsonl", "inline-record\n"],
    ["/tmp/eve-loop-benchmark-workflow.jsonl", "workflow-record\n"],
    ["/tmp/eve-loop-benchmark-temporal.jsonl", "temporal-record\n"],
  ]);
  return {
    cwd: "/vercel/sandbox",
    domain(port) {
      switch (port) {
        case 8080:
          return "https://inline.sandbox.example";
        case 8081:
          return "https://workflow.sandbox.example";
        case 8082:
          return "https://temporal.sandbox.example";
        default:
          throw new Error(`Unexpected port ${String(port)}.`);
      }
    },
    memory: 8192,
    name: "benchmark-sandbox",
    async readFileToBuffer({ path }) {
      input.recordReads.push(path);
      if (input.readFileToBuffer !== undefined) {
        return await input.readFileToBuffer({ path });
      }
      const value = records.get(path);
      return value === undefined ? null : Buffer.from(value);
    },
    region: "iad1",
    async runCommand(command) {
      input.commands.push(command);
      if (input.runCommand !== undefined) return await input.runCommand(command);
      if (command.detached === true) {
        return input.createDetachedCommand?.(command) ?? runningCommand();
      }
      return finishedCommand(0);
    },
    runtime: "node24",
    stop: input.stop,
    vcpus: 4,
  };
}

function finishedCommand(exitCode: number, stdout = "", stderr = ""): BenchmarkSandboxCommand {
  return {
    exitCode,
    kill: async () => undefined,
    stderr: async () => stderr,
    stdout: async () => stdout,
    wait: async () => ({ exitCode }),
  };
}

function runningCommand(
  overrides: {
    readonly kill?: (signal: "SIGTERM") => Promise<void>;
    readonly wait?: () => Promise<{ readonly exitCode: number }>;
  } = {},
): BenchmarkSandboxCommand {
  return {
    exitCode: null,
    kill: overrides.kill ?? (async () => undefined),
    stderr: async () => "",
    stdout: async () => "",
    wait: overrides.wait ?? (async () => ({ exitCode: 0 })),
  };
}
