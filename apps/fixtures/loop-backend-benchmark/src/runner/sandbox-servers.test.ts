import { describe, expect, it, vi } from "vitest";

import type { ParsedRunnerConfig } from "./config.js";
import {
  type BenchmarkSandbox,
  type BenchmarkSandboxCommand,
  type BenchmarkSandboxCreateInput,
  type BenchmarkSandboxRunCommandInput,
  SandboxRuntimeServerGroup,
} from "./sandbox-servers.js";

const FULL_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("SandboxRuntimeServerGroup", () => {
  it("builds one pinned Sandbox and starts three ready runtime servers", async () => {
    const createInputs: BenchmarkSandboxCreateInput[] = [];
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const healthRequests: string[] = [];
    const recordReads: string[] = [];
    const stop = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({ commands, recordReads, stop });
    const group = new SandboxRuntimeServerGroup({
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

    const result = await group.start(sandboxConfig());

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
    expect(commands.slice(0, 2)).toEqual([
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

    const serverCommands = commands.slice(2);
    expect(serverCommands).toHaveLength(3);
    expect(serverCommands.map((command) => command.detached)).toEqual([true, true, true]);
    expect(serverCommands.map((command) => command.args.at(-1))).toEqual(["8080", "8081", "8082"]);
    expect(serverCommands.map((command) => command.env)).toEqual([
      {
        AI_GATEWAY_API_KEY: "gateway-test-key",
        EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
        EVE_LOOP_BENCHMARK_RECORD_PATH: "/tmp/eve-loop-benchmark-inline.jsonl",
        EVE_LOOP_BENCHMARK_RUNTIME: "inline",
        EVE_LOOP_BENCHMARK_TARGET: "vercel",
        VERCEL_PROJECT_ID: "prj_benchmark",
        VERCEL_TARGET_ENV: "development",
        WORKFLOW_LOCAL_DATA_DIR: "/tmp/eve-loop-benchmark-inline-workflow-data",
      },
      {
        AI_GATEWAY_API_KEY: "gateway-test-key",
        EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
        EVE_LOOP_BENCHMARK_RECORD_PATH: "/tmp/eve-loop-benchmark-workflow.jsonl",
        EVE_LOOP_BENCHMARK_RUNTIME: "workflow",
        EVE_LOOP_BENCHMARK_TARGET: "vercel",
        VERCEL_PROJECT_ID: "prj_benchmark",
        VERCEL_TARGET_ENV: "development",
        WORKFLOW_LOCAL_DATA_DIR: "/tmp/eve-loop-benchmark-workflow-workflow-data",
      },
      {
        AI_GATEWAY_API_KEY: "gateway-test-key",
        EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
        EVE_LOOP_BENCHMARK_RECORD_PATH: "/tmp/eve-loop-benchmark-temporal.jsonl",
        EVE_LOOP_BENCHMARK_RUNTIME: "temporal",
        EVE_LOOP_BENCHMARK_TARGET: "vercel",
        VERCEL_PROJECT_ID: "prj_benchmark",
        VERCEL_TARGET_ENV: "development",
        WORKFLOW_LOCAL_DATA_DIR: "/tmp/eve-loop-benchmark-temporal-workflow-data",
      },
    ]);
    expect(healthRequests).toEqual([
      "https://inline.sandbox.example/eve/v1/health",
      "https://workflow.sandbox.example/eve/v1/health",
      "https://temporal.sandbox.example/eve/v1/health",
    ]);
    expect(result).toEqual({
      runtimeUrls: {
        inline: "https://inline.sandbox.example",
        temporal: "https://temporal.sandbox.example",
        workflow: "https://workflow.sandbox.example",
      },
      sandbox: {
        memoryMb: 8192,
        name: "benchmark-sandbox",
        region: "iad1",
        runtime: "node24",
        vcpus: 4,
      },
    });

    await expect(group.readRecordFile("workflow")).resolves.toBe("workflow-record\n");
    expect(recordReads).toEqual(["/tmp/eve-loop-benchmark-workflow.jsonl"]);
    await group.stop();
    await group.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("separates private-source auth and preserves the model credential name", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const createSandbox = vi.fn(async () => {
      return fakeSandbox({ commands, recordReads: [], stop: vi.fn(async () => undefined) });
    });
    const group = new SandboxRuntimeServerGroup({
      createSandbox,
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await group.start({
      ...sandboxConfig(),
      modelCredential: { name: "VERCEL_OIDC_TOKEN", value: "oidc-test-token" },
      gitToken: "git-test-token",
      gitUrl: "https://github.example/acme/eve.git",
      gitUsername: "benchmark-bot",
    });

    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          password: "git-test-token",
          username: "benchmark-bot",
        }),
      }),
    );
    expect(commands.slice(2).map((command) => command.env)).toEqual([
      expect.objectContaining({ VERCEL_OIDC_TOKEN: "oidc-test-token" }),
      expect.objectContaining({ VERCEL_OIDC_TOKEN: "oidc-test-token" }),
      expect.objectContaining({ VERCEL_OIDC_TOKEN: "oidc-test-token" }),
    ]);
    expect(JSON.stringify(commands)).not.toContain("git-test-token");
  });

  it("forwards the deterministic model kind without a model credential", async () => {
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const group = new SandboxRuntimeServerGroup({
      createSandbox: async () =>
        fakeSandbox({ commands, recordReads: [], stop: vi.fn(async () => undefined) }),
      async fetch() {
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await group.start({
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

    expect(commands.slice(1).map((command) => command.env)).toEqual([
      { EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" },
      expect.objectContaining({ EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" }),
      expect.objectContaining({ EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" }),
      expect.objectContaining({ EVE_LOOP_BENCHMARK_MODEL_KIND: "deterministic" }),
    ]);
    expect(JSON.stringify(commands)).not.toContain("AI_GATEWAY_API_KEY");
    expect(JSON.stringify(commands)).not.toContain("VERCEL_OIDC_TOKEN");
    expect(JSON.stringify(commands)).not.toContain("oidc-test-token");
  });

  it("stops the Sandbox when setup fails", async () => {
    const stop = vi.fn(async () => undefined);
    let commandIndex = 0;
    const sandbox = fakeSandbox({
      commands: [],
      recordReads: [],
      runCommand: async () => {
        commandIndex += 1;
        return commandIndex === 1
          ? finishedCommand(0)
          : finishedCommand(1, "build stdout", "build stderr");
      },
      stop,
    });
    const group = new SandboxRuntimeServerGroup({
      createSandbox: async () => sandbox,
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    await expect(group.start(sandboxConfig())).rejects.toThrow(
      "workspace build failed with exit code 1",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight creation and stops before setup continues", async () => {
    const stop = vi.fn(async () => undefined);
    const commands: BenchmarkSandboxRunCommandInput[] = [];
    const sandbox = fakeSandbox({ commands, recordReads: [], stop });
    let resolveSandbox: ((sandbox: BenchmarkSandbox) => void) | undefined;
    const created = new Promise<BenchmarkSandbox>((resolve) => {
      resolveSandbox = resolve;
    });
    const group = new SandboxRuntimeServerGroup({
      createSandbox: async () => await created,
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic: vi.fn(),
    });

    const starting = group.start(sandboxConfig());
    const stopping = group.stop();
    resolveSandbox?.(sandbox);

    await stopping;
    await expect(starting).rejects.toThrow("cleanup started before server setup completed");
    expect(commands).toHaveLength(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("redacts configured credentials from setup failures", async () => {
    const aiCredential = "gateway-sensitive-value";
    const gitCredential = "git-sensitive-value";
    const routeCredential = "route-sensitive-value";
    const diagnostics: string[] = [];
    const group = new SandboxRuntimeServerGroup({
      async createSandbox() {
        throw new Error(
          `create failed with ${aiCredential}, ${gitCredential}, and ${routeCredential}`,
        );
      },
      fetch: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
      writeDiagnostic(message) {
        diagnostics.push(message);
      },
    });

    let failure: unknown;
    try {
      await group.start({
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

    expect(String(failure)).toContain("[redacted]");
    expect(String(failure)).not.toContain(aiCredential);
    expect(String(failure)).not.toContain(gitCredential);
    expect(String(failure)).not.toContain(routeCredential);
    expect(diagnostics.join("\n")).not.toContain(aiCredential);
    expect(diagnostics.join("\n")).not.toContain(gitCredential);
    expect(diagnostics.join("\n")).not.toContain(routeCredential);
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
      const value = records.get(path);
      return value === undefined ? null : Buffer.from(value);
    },
    region: "iad1",
    async runCommand(command) {
      input.commands.push(command);
      return input.runCommand?.(command) ?? finishedCommand(command.detached === true ? null : 0);
    },
    runtime: "node24",
    stop: input.stop,
    vcpus: 4,
  };
}

function finishedCommand(
  exitCode: number | null,
  stdout = "",
  stderr = "",
): BenchmarkSandboxCommand {
  return {
    exitCode,
    stderr: async () => stderr,
    stdout: async () => stdout,
  };
}
