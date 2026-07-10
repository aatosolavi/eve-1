import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import { BENCHMARK_MODEL_KIND_ENV, type BenchmarkModelKind } from "../model-kind.js";
import type { ParsedRunnerConfig } from "./config.js";
import { BENCHMARK_RUNTIMES, type BenchmarkRuntimeUrls } from "./types.js";

const HEALTH_ROUTE_PATH = "/eve/v1/health";
const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_REQUEST_TIMEOUT_MS = 3_000;
const READINESS_TIMEOUT_MS = 120_000;
const SANDBOX_TIMEOUT_MS = 45 * 60 * 1_000;
const SANDBOX_VCPUS = 4;

const RUNTIME_PORTS = {
  inline: 8080,
  workflow: 8081,
  temporal: 8082,
} satisfies Record<BenchmarkRuntimeKind, number>;

const RUNTIME_RECORD_PATHS = {
  inline: "/tmp/eve-loop-benchmark-inline.jsonl",
  workflow: "/tmp/eve-loop-benchmark-workflow.jsonl",
  temporal: "/tmp/eve-loop-benchmark-temporal.jsonl",
} satisfies Record<BenchmarkRuntimeKind, string>;

const RUNTIME_WORKFLOW_DATA_DIRS = {
  inline: "/tmp/eve-loop-benchmark-inline-workflow-data",
  workflow: "/tmp/eve-loop-benchmark-workflow-workflow-data",
  temporal: "/tmp/eve-loop-benchmark-temporal-workflow-data",
} satisfies Record<BenchmarkRuntimeKind, string>;

type SandboxRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "sandbox" }>;

interface SandboxGitSourceCommon {
  readonly depth: number;
  readonly revision: string;
  readonly type: "git";
  readonly url: string;
}

type SandboxGitSource = SandboxGitSourceCommon &
  (
    | { readonly password?: never; readonly username?: never }
    | { readonly password: string; readonly username: string }
  );

export interface BenchmarkSandboxCreateInput {
  readonly persistent: false;
  readonly ports: readonly number[];
  readonly resources: { readonly vcpus: number };
  readonly runtime: "node24";
  readonly source: SandboxGitSource;
  readonly timeout: number;
}

export interface BenchmarkSandboxCommand {
  readonly exitCode: number | null;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
}

export interface BenchmarkSandboxRunCommandInput {
  readonly args: readonly string[];
  readonly cmd: string;
  readonly cwd: string;
  readonly detached?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export interface BenchmarkSandbox {
  readonly cwd: string;
  readonly memory: number | undefined;
  readonly name: string;
  readonly region: string | undefined;
  readonly runtime: string | undefined;
  readonly vcpus: number | undefined;
  domain(port: number): string;
  readFileToBuffer(file: { readonly path: string }): Promise<Buffer | null>;
  runCommand(input: BenchmarkSandboxRunCommandInput): Promise<BenchmarkSandboxCommand>;
  stop(): Promise<unknown>;
}

export type CreateBenchmarkSandbox = (
  input: BenchmarkSandboxCreateInput,
) => Promise<BenchmarkSandbox>;

export interface SandboxRuntimeMetadata {
  readonly memoryMb: number | null;
  readonly name: string;
  readonly region: string | null;
  readonly runtime: string | null;
  readonly vcpus: number | null;
}

export interface SandboxRuntimeStartResult {
  readonly runtimeUrls: BenchmarkRuntimeUrls;
  readonly sandbox: SandboxRuntimeMetadata;
}

export interface SandboxSetupRecord {
  readonly gitRevision: string;
  readonly kind: "setup";
  readonly modelKind: BenchmarkModelKind;
  readonly runId: string;
  readonly runtimeUrls: BenchmarkRuntimeUrls;
  readonly sandbox: SandboxRuntimeMetadata;
  readonly targetKind: "vercel";
  readonly topology: "vercel-sandbox";
}

export interface SandboxRuntimeServerGroupHandle {
  readRecordFile(runtimeKind: BenchmarkRuntimeKind): Promise<string | null>;
  start(config: SandboxRunnerConfig): Promise<SandboxRuntimeStartResult>;
  stop(): Promise<void>;
}

interface SandboxRuntimeServerGroupDependencies {
  readonly createSandbox: CreateBenchmarkSandbox;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeDiagnostic: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: SandboxRuntimeServerGroupDependencies = {
  createSandbox: createVercelSandbox,
  fetch: async (input, init) => await globalThis.fetch(input, init),
  now: Date.now,
  sleep: async (milliseconds) => await sleep(milliseconds),
  writeDiagnostic: (message) => process.stderr.write(message),
};

export class SandboxRuntimeServerGroup implements SandboxRuntimeServerGroupHandle {
  readonly #dependencies: SandboxRuntimeServerGroupDependencies;
  #createPromise: Promise<BenchmarkSandbox> | null = null;
  #sandbox: BenchmarkSandbox | null = null;
  #secrets: readonly string[] = [];
  #stopPromise: Promise<void> | null = null;

  constructor(dependencies: SandboxRuntimeServerGroupDependencies = DEFAULT_DEPENDENCIES) {
    this.#dependencies = dependencies;
  }

  async start(config: SandboxRunnerConfig): Promise<SandboxRuntimeStartResult> {
    if (this.#sandbox !== null || this.#stopPromise !== null) {
      throw new Error("The Vercel Sandbox benchmark servers have already been started.");
    }

    this.#secrets = [
      ...(config.modelCredential === undefined ? [] : [config.modelCredential.value]),
      ...(config.gitToken === undefined ? [] : [config.gitToken]),
    ];
    this.#dependencies.writeDiagnostic(
      `Creating one Vercel Sandbox at commit ${config.gitRevision}.\n`,
    );

    try {
      this.#createPromise = this.#dependencies.createSandbox({
        persistent: false,
        ports: BENCHMARK_RUNTIMES.map((runtimeKind) => RUNTIME_PORTS[runtimeKind]),
        resources: { vcpus: SANDBOX_VCPUS },
        runtime: "node24",
        source: createGitSource(config),
        timeout: SANDBOX_TIMEOUT_MS,
      });
      const sandbox = await this.#createPromise;
      this.#sandbox = sandbox;
      if (this.#stopPromise !== null) {
        await this.#stopPromise;
        throw new Error("Vercel Sandbox cleanup started before server setup completed.");
      }

      this.#dependencies.writeDiagnostic("Installing the pinned checkout once.\n");
      await this.#runCheckedCommand("dependency installation", {
        args: ["pnpm", "install", "--frozen-lockfile"],
        cmd: "corepack",
        cwd: sandbox.cwd,
      });

      this.#dependencies.writeDiagnostic(
        "Building the benchmark fixture and its dependencies once.\n",
      );
      await this.#runCheckedCommand("workspace build", {
        args: ["pnpm", "--filter", "loop-backend-benchmark...", "build"],
        cmd: "corepack",
        cwd: sandbox.cwd,
        env: modelEnvironment(config),
      });

      for (const runtimeKind of BENCHMARK_RUNTIMES) {
        this.#dependencies.writeDiagnostic(
          `Starting the ${runtimeKind} runtime on port ${String(RUNTIME_PORTS[runtimeKind])}.\n`,
        );
        await sandbox.runCommand({
          args: [
            "pnpm",
            "--filter",
            "loop-backend-benchmark",
            "exec",
            "eve",
            "start",
            "--host",
            "0.0.0.0",
            "--port",
            String(RUNTIME_PORTS[runtimeKind]),
          ],
          cmd: "corepack",
          cwd: posix.join(sandbox.cwd, "apps/fixtures/loop-backend-benchmark"),
          detached: true,
          env: {
            ...modelEnvironment(config),
            EVE_LOOP_BENCHMARK_RECORD_PATH: RUNTIME_RECORD_PATHS[runtimeKind],
            EVE_LOOP_BENCHMARK_RUNTIME: runtimeKind,
            EVE_LOOP_BENCHMARK_TARGET: "vercel",
            WORKFLOW_LOCAL_DATA_DIR: RUNTIME_WORKFLOW_DATA_DIRS[runtimeKind],
          },
        });
      }

      const runtimeUrls = runtimeUrlsFor(sandbox);
      await Promise.all(
        BENCHMARK_RUNTIMES.map(async (runtimeKind) => {
          await this.#waitUntilReady(runtimeKind, runtimeUrls[runtimeKind]);
        }),
      );

      return {
        runtimeUrls,
        sandbox: {
          memoryMb: sandbox.memory ?? null,
          name: sandbox.name,
          region: sandbox.region ?? null,
          runtime: sandbox.runtime ?? null,
          vcpus: sandbox.vcpus ?? null,
        },
      };
    } catch (error) {
      if (this.#sandbox === null && this.#stopPromise === null) {
        this.#createPromise = null;
      }
      try {
        await this.stop();
      } catch (cleanupError) {
        this.#dependencies.writeDiagnostic(
          `Vercel Sandbox cleanup failed: ${formatError(cleanupError)}\n`,
        );
      }
      throw sanitizeError(error, this.#secrets);
    }
  }

  async readRecordFile(runtimeKind: BenchmarkRuntimeKind): Promise<string | null> {
    if (this.#stopPromise !== null) {
      throw new Error("Cannot read benchmark records after Vercel Sandbox cleanup has started.");
    }
    if (this.#sandbox === null) {
      throw new Error("Cannot read benchmark records before the Vercel Sandbox has started.");
    }

    try {
      const contents = await this.#sandbox.readFileToBuffer({
        path: RUNTIME_RECORD_PATHS[runtimeKind],
      });
      return contents?.toString("utf8") ?? null;
    } catch (error) {
      throw sanitizeError(error, this.#secrets);
    }
  }

  async stop(): Promise<void> {
    const pendingSandbox =
      this.#sandbox === null ? this.#createPromise : Promise.resolve(this.#sandbox);
    if (pendingSandbox === null) return;

    this.#stopPromise ??= pendingSandbox
      .then(async (sandbox) => await sandbox.stop())
      .then(() => undefined)
      .catch((error: unknown) => {
        throw sanitizeError(error, this.#secrets);
      });
    await this.#stopPromise;
  }

  async #runCheckedCommand(
    description: string,
    input: BenchmarkSandboxRunCommandInput,
  ): Promise<void> {
    const sandbox = this.#sandbox;
    if (sandbox === null) {
      throw new Error(`Cannot run ${description} before creating the Vercel Sandbox.`);
    }

    const command = await sandbox.runCommand(input);
    if (command.exitCode === 0) return;

    const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
    throw new Error(
      redactSecrets(
        [
          `${description} failed with exit code ${String(command.exitCode)}.`,
          formatCommandOutput("stdout", stdout),
          formatCommandOutput("stderr", stderr),
        ].join("\n"),
        this.#secrets,
      ),
    );
  }

  async #waitUntilReady(runtimeKind: BenchmarkRuntimeKind, origin: string): Promise<void> {
    const healthUrl = new URL(HEALTH_ROUTE_PATH, origin).toString();
    const deadline = this.#dependencies.now() + READINESS_TIMEOUT_MS;

    while (this.#dependencies.now() < deadline) {
      try {
        const response = await this.#dependencies.fetch(healthUrl, {
          signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
        });
        if (response.ok && (await isReadyHealthResponse(response))) {
          this.#dependencies.writeDiagnostic(`${runtimeKind} runtime is ready.\n`);
          return;
        }
      } catch {}

      await this.#dependencies.sleep(READINESS_POLL_INTERVAL_MS);
    }

    throw new Error(
      `${runtimeKind} runtime did not become ready within ${String(READINESS_TIMEOUT_MS / 1_000)} seconds at ${healthUrl}.`,
    );
  }
}

function modelEnvironment(config: SandboxRunnerConfig): Readonly<Record<string, string>> {
  if (config.modelKind === "deterministic") {
    return { [BENCHMARK_MODEL_KIND_ENV]: config.modelKind };
  }

  return {
    [config.modelCredential.name]: config.modelCredential.value,
    [BENCHMARK_MODEL_KIND_ENV]: config.modelKind,
  };
}

function createGitSource(config: SandboxRunnerConfig): SandboxGitSource {
  const common = {
    depth: 1,
    revision: config.gitRevision,
    type: "git" as const,
    url: config.gitUrl,
  };
  if (config.gitUsername === undefined || config.gitToken === undefined) {
    return common;
  }
  return {
    ...common,
    password: config.gitToken,
    username: config.gitUsername,
  };
}

function runtimeUrlsFor(sandbox: BenchmarkSandbox): BenchmarkRuntimeUrls {
  return {
    inline: sandbox.domain(RUNTIME_PORTS.inline),
    temporal: sandbox.domain(RUNTIME_PORTS.temporal),
    workflow: sandbox.domain(RUNTIME_PORTS.workflow),
  };
}

async function isReadyHealthResponse(response: Response): Promise<boolean> {
  const body: unknown = await response.json();
  return (
    typeof body === "object" &&
    body !== null &&
    Reflect.get(body, "ok") === true &&
    Reflect.get(body, "status") === "ready"
  );
}

async function createVercelSandbox(input: BenchmarkSandboxCreateInput): Promise<BenchmarkSandbox> {
  const { Sandbox } = await import("@vercel/sandbox");
  const source =
    input.source.username === undefined || input.source.password === undefined
      ? {
          depth: input.source.depth,
          revision: input.source.revision,
          type: input.source.type,
          url: input.source.url,
        }
      : {
          depth: input.source.depth,
          password: input.source.password,
          revision: input.source.revision,
          type: input.source.type,
          url: input.source.url,
          username: input.source.username,
        };
  const sandbox = await Sandbox.create({
    persistent: input.persistent,
    ports: [...input.ports],
    resources: input.resources,
    runtime: input.runtime,
    source,
    timeout: input.timeout,
  });

  return {
    cwd: sandbox.cwd,
    domain: (port) => sandbox.domain(port),
    memory: sandbox.memory,
    name: sandbox.name,
    readFileToBuffer: async (file) => await sandbox.readFileToBuffer(file),
    region: sandbox.region,
    runCommand: async (commandInput) => {
      if (commandInput.detached === true) {
        if (commandInput.env !== undefined) {
          return await sandbox.runCommand({
            args: [...commandInput.args],
            cmd: commandInput.cmd,
            cwd: commandInput.cwd,
            detached: true,
            env: { ...commandInput.env },
          });
        }
        return await sandbox.runCommand({
          args: [...commandInput.args],
          cmd: commandInput.cmd,
          cwd: commandInput.cwd,
          detached: true,
        });
      }
      if (commandInput.env !== undefined) {
        return await sandbox.runCommand({
          args: [...commandInput.args],
          cmd: commandInput.cmd,
          cwd: commandInput.cwd,
          env: { ...commandInput.env },
        });
      }
      return await sandbox.runCommand({
        args: [...commandInput.args],
        cmd: commandInput.cmd,
        cwd: commandInput.cwd,
      });
    },
    runtime: sandbox.runtime,
    stop: async () => await sandbox.stop(),
    vcpus: sandbox.vcpus,
  };
}

function formatCommandOutput(label: string, output: string): string {
  const maximumLength = 32_000;
  const retained = output.length <= maximumLength ? output : output.slice(-maximumLength);
  return `${label}:\n${retained}`;
}

function sanitizeError(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof Error) {
    const sanitized = new Error(redactSecrets(error.message, secrets));
    sanitized.name = redactSecrets(error.name, secrets);
    return sanitized;
  }
  return new Error(redactSecrets(String(error), secrets));
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[redacted]"), value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
