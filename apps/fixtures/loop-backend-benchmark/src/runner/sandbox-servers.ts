import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import { BENCHMARK_MODEL_KIND_ENV, type BenchmarkModelKind } from "../model-kind.js";
import type { ParsedRunnerConfig } from "./config.js";
import { BENCHMARK_RUNTIMES } from "./types.js";

const HEALTH_ROUTE_PATH = "/eve/v1/health";
const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_REQUEST_TIMEOUT_MS = 3_000;
const READINESS_TIMEOUT_MS = 120_000;
const RUNTIME_STOP_TIMEOUT_MS = 15_000;
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
  kill(signal: "SIGTERM"): Promise<void>;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
  wait(): Promise<{ readonly exitCode: number }>;
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

export interface SandboxSetupRecord {
  readonly gitRevision: string;
  readonly kind: "setup";
  readonly maxConcurrentRuntimeServers: 1;
  readonly modelKind: BenchmarkModelKind;
  readonly runId: string;
  readonly runtimeBatchOrder: readonly BenchmarkRuntimeKind[];
  readonly runtimeReuse: "one-process-per-runtime";
  readonly sandbox: SandboxRuntimeMetadata;
  readonly sandboxReuse: "one-sandbox-per-run";
  readonly targetKind: "vercel";
  readonly topology: "vercel-sandbox-runtime-batches";
}

/** A handle to one running runtime inside the prepared benchmark Sandbox. */
export interface SandboxRuntimeServerLease<
  RuntimeKind extends BenchmarkRuntimeKind = BenchmarkRuntimeKind,
> {
  readonly runtimeKind: RuntimeKind;
  readonly targetUrl: string;
  readRecordFile(): Promise<string | null>;
  stop(): Promise<void>;
}

export interface SandboxRuntimeServerHostHandle {
  acquire<RuntimeKind extends BenchmarkRuntimeKind>(
    runtimeKind: RuntimeKind,
  ): Promise<SandboxRuntimeServerLease<RuntimeKind>>;
  prepare(config: SandboxRunnerConfig): Promise<SandboxRuntimeMetadata>;
  stop(): Promise<void>;
}

export interface SandboxRuntimeServerHostDependencies {
  readonly createSandbox: CreateBenchmarkSandbox;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeDiagnostic: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: SandboxRuntimeServerHostDependencies = {
  createSandbox: createVercelSandbox,
  fetch: async (input, init) => await globalThis.fetch(input, init),
  now: Date.now,
  sleep: async (milliseconds) => await sleep(milliseconds),
  writeDiagnostic: (message) => process.stderr.write(message),
};

interface ActiveSandboxRuntime {
  readonly command: BenchmarkSandboxCommand;
  readonly leaseId: symbol;
  readonly runtimeKind: BenchmarkRuntimeKind;
  stopPromise: Promise<void> | null;
}

/** Owns one prepared Sandbox and at most one active benchmark runtime. */
export class SandboxRuntimeServerHost implements SandboxRuntimeServerHostHandle {
  readonly #dependencies: SandboxRuntimeServerHostDependencies;
  #active: ActiveSandboxRuntime | null = null;
  #acquiringRuntime: BenchmarkRuntimeKind | null = null;
  #config: SandboxRunnerConfig | null = null;
  #createPromise: Promise<BenchmarkSandbox> | null = null;
  #inFlightCommand: Promise<BenchmarkSandboxCommand> | null = null;
  readonly #inFlightSandboxOperations = new Set<Promise<unknown>>();
  #sandbox: BenchmarkSandbox | null = null;
  readonly #sanitizedErrors = new WeakSet<Error>();
  #secrets: readonly string[] = [];
  #stopPromise: Promise<void> | null = null;

  constructor(dependencies: SandboxRuntimeServerHostDependencies = DEFAULT_DEPENDENCIES) {
    this.#dependencies = dependencies;
  }

  async prepare(config: SandboxRunnerConfig): Promise<SandboxRuntimeMetadata> {
    if (this.#sandbox !== null || this.#createPromise !== null || this.#stopPromise !== null) {
      throw new Error("The Vercel Sandbox benchmark host has already been prepared.");
    }

    this.#config = config;
    this.#secrets = [
      config.vercelOidc.token,
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

      return {
        memoryMb: sandbox.memory ?? null,
        name: sandbox.name,
        region: sandbox.region ?? null,
        runtime: sandbox.runtime ?? null,
        vcpus: sandbox.vcpus ?? null,
      };
    } catch (error) {
      if (this.#sandbox === null && this.#stopPromise === null) {
        this.#createPromise = null;
        this.#config = null;
      }
      try {
        await this.stop();
      } catch (cleanupError) {
        throw sanitizeError(
          combineOperationAndCleanupErrors(
            error,
            cleanupError,
            "Vercel Sandbox setup failed and cleanup also failed.",
          ),
          this.#secrets,
          this.#sanitizedErrors,
        );
      }
      throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
    }
  }

  async acquire<RuntimeKind extends BenchmarkRuntimeKind>(
    runtimeKind: RuntimeKind,
  ): Promise<SandboxRuntimeServerLease<RuntimeKind>> {
    if (this.#stopPromise !== null) {
      throw new Error("Cannot start a runtime after Vercel Sandbox cleanup has started.");
    }
    const sandbox = this.#sandbox;
    const config = this.#config;
    if (sandbox === null || config === null) {
      throw new Error("Cannot start a runtime before preparing the Vercel Sandbox.");
    }
    if (this.#active !== null) {
      throw new Error(
        `The Vercel Sandbox benchmark host already has an active ${this.#active.runtimeKind} runtime.`,
      );
    }
    if (this.#acquiringRuntime !== null) {
      throw new Error(
        `The Vercel Sandbox benchmark host is already starting the ${this.#acquiringRuntime} runtime.`,
      );
    }

    const targetUrl = sandbox.domain(RUNTIME_PORTS[runtimeKind]);
    this.#acquiringRuntime = runtimeKind;
    this.#dependencies.writeDiagnostic(
      `Starting the ${runtimeKind} runtime on port ${String(RUNTIME_PORTS[runtimeKind])}.\n`,
    );
    let command: BenchmarkSandboxCommand;
    try {
      command = await this.#runSandboxCommand({
        args: [
          posix.join(sandbox.cwd, "packages/eve/bin/eve.js"),
          "start",
          "--host",
          "0.0.0.0",
          "--port",
          String(RUNTIME_PORTS[runtimeKind]),
        ],
        cmd: "node",
        cwd: posix.join(sandbox.cwd, "apps/fixtures/loop-backend-benchmark"),
        detached: true,
        env: {
          ...modelEnvironment(config),
          EVE_LOOP_BENCHMARK_RECORD_PATH: RUNTIME_RECORD_PATHS[runtimeKind],
          EVE_LOOP_BENCHMARK_RUNTIME: runtimeKind,
          EVE_LOOP_BENCHMARK_TARGET: "vercel",
          VERCEL_PROJECT_ID: config.vercelOidc.projectId,
          VERCEL_TARGET_ENV: config.vercelOidc.environment,
          WORKFLOW_LOCAL_DATA_DIR: RUNTIME_WORKFLOW_DATA_DIRS[runtimeKind],
        },
      });
    } catch (error) {
      if (this.#acquiringRuntime === runtimeKind) this.#acquiringRuntime = null;
      try {
        await this.stop();
      } catch (cleanupError) {
        throw sanitizeError(
          combineOperationAndCleanupErrors(
            error,
            cleanupError,
            `${runtimeKind} runtime command publication failed and Vercel Sandbox cleanup also failed.`,
          ),
          this.#secrets,
          this.#sanitizedErrors,
        );
      }
      throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
    }

    if (this.#stopPromise !== null) {
      if (this.#acquiringRuntime === runtimeKind) this.#acquiringRuntime = null;
      await this.#stopPromise;
      throw new Error("Vercel Sandbox cleanup started before the runtime became active.");
    }

    const leaseId = Symbol(runtimeKind);
    const active: ActiveSandboxRuntime = {
      command,
      leaseId,
      runtimeKind,
      stopPromise: null,
    };
    this.#acquiringRuntime = null;
    this.#active = active;

    try {
      await this.#waitUntilReady(runtimeKind, targetUrl);
    } catch (error) {
      try {
        await this.#stopLease(leaseId);
      } catch (cleanupError) {
        throw sanitizeError(
          combineOperationAndCleanupErrors(
            error,
            cleanupError,
            `${runtimeKind} runtime readiness failed and cleanup also failed.`,
          ),
          this.#secrets,
          this.#sanitizedErrors,
        );
      }
      throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
    }

    if (this.#active !== active || active.stopPromise !== null) {
      await this.#stopLease(leaseId);
      throw new Error(`The ${runtimeKind} Sandbox runtime stopped before it became ready.`);
    }

    return {
      readRecordFile: async () => await this.#readLeaseRecord(leaseId, runtimeKind),
      runtimeKind,
      stop: async () => await this.#stopLease(leaseId),
      targetUrl,
    };
  }

  async stop(): Promise<void> {
    const pendingSandbox =
      this.#sandbox === null ? this.#createPromise : Promise.resolve(this.#sandbox);
    if (pendingSandbox === null) return;
    const inFlightOperations = [...this.#inFlightSandboxOperations].map((operation) =>
      operation.catch(() => undefined),
    );

    this.#stopPromise ??= Promise.all([pendingSandbox, ...inFlightOperations])
      .then(async ([sandbox]) => await sandbox.stop())
      .then(() => {
        this.#active = null;
        this.#acquiringRuntime = null;
      })
      .catch((error: unknown) => {
        throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
      });
    await this.#stopPromise;
  }

  async #readLeaseRecord(
    leaseId: symbol,
    runtimeKind: BenchmarkRuntimeKind,
  ): Promise<string | null> {
    if (this.#active?.leaseId !== leaseId) {
      throw new Error(`The ${runtimeKind} Vercel Sandbox runtime lease is no longer active.`);
    }
    if (this.#stopPromise !== null) {
      throw new Error("Cannot read benchmark records after Vercel Sandbox cleanup has started.");
    }
    const sandbox = this.#sandbox;
    if (sandbox === null) {
      throw new Error("Cannot read benchmark records before preparing the Vercel Sandbox.");
    }

    try {
      const contents = await this.#runSandboxOperation(
        async () =>
          await sandbox.readFileToBuffer({
            path: RUNTIME_RECORD_PATHS[runtimeKind],
          }),
      );
      if (this.#stopPromise !== null) {
        await this.#stopPromise;
        throw new Error("Vercel Sandbox cleanup started before the record read completed.");
      }
      return contents?.toString("utf8") ?? null;
    } catch (error) {
      throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
    }
  }

  async #stopLease(leaseId: symbol): Promise<void> {
    const active = this.#active;
    if (active === null || active.leaseId !== leaseId) return;

    active.stopPromise ??= this.#stopActiveRuntime(active);
    await active.stopPromise;
  }

  async #stopActiveRuntime(active: ActiveSandboxRuntime): Promise<void> {
    if (this.#stopPromise !== null) {
      await this.#stopPromise;
      return;
    }

    try {
      await withTimeout(
        (async () => {
          await active.command.kill("SIGTERM");
          await active.command.wait();
        })(),
        RUNTIME_STOP_TIMEOUT_MS,
        `${active.runtimeKind} runtime did not stop within ${String(RUNTIME_STOP_TIMEOUT_MS / 1_000)} seconds.`,
      );
      if (this.#active?.leaseId === active.leaseId) {
        this.#active = null;
      }
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw sanitizeError(
          combineOperationAndCleanupErrors(
            error,
            cleanupError,
            `${active.runtimeKind} runtime cleanup failed and Vercel Sandbox cleanup also failed.`,
          ),
          this.#secrets,
          this.#sanitizedErrors,
        );
      }
      throw sanitizeError(error, this.#secrets, this.#sanitizedErrors);
    }
  }

  async #runCheckedCommand(
    description: string,
    input: BenchmarkSandboxRunCommandInput,
  ): Promise<void> {
    const command = await this.#runSandboxCommand(input);
    if (this.#stopPromise !== null) {
      await this.#stopPromise;
      throw new Error(`Vercel Sandbox cleanup started before ${description} completed.`);
    }
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

  async #runSandboxCommand(
    input: BenchmarkSandboxRunCommandInput,
  ): Promise<BenchmarkSandboxCommand> {
    if (this.#stopPromise !== null) {
      throw new Error("Cannot start a Sandbox command after cleanup has started.");
    }
    if (this.#inFlightCommand !== null) {
      throw new Error("The Vercel Sandbox benchmark host already has a command in flight.");
    }
    const sandbox = this.#sandbox;
    if (sandbox === null) {
      throw new Error("Cannot run a command before creating the Vercel Sandbox.");
    }

    const command = this.#runSandboxOperation(async () => await sandbox.runCommand(input));
    this.#inFlightCommand = command;
    try {
      return await command;
    } finally {
      if (this.#inFlightCommand === command) this.#inFlightCommand = null;
    }
  }

  async #runSandboxOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#stopPromise !== null) {
      throw new Error("Cannot start a Sandbox operation after cleanup has started.");
    }

    const pending = operation();
    this.#inFlightSandboxOperations.add(pending);
    try {
      return await pending;
    } finally {
      this.#inFlightSandboxOperations.delete(pending);
    }
  }

  async #waitUntilReady(runtimeKind: BenchmarkRuntimeKind, origin: string): Promise<void> {
    const healthUrl = new URL(HEALTH_ROUTE_PATH, origin).toString();
    const deadline = this.#dependencies.now() + READINESS_TIMEOUT_MS;

    while (this.#dependencies.now() < deadline) {
      if (this.#stopPromise !== null) {
        await this.#stopPromise;
        throw new Error("Vercel Sandbox cleanup started before runtime readiness completed.");
      }

      let ready = false;
      try {
        const response = await this.#dependencies.fetch(healthUrl, {
          signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
        });
        ready = response.ok && (await isReadyHealthResponse(response));
      } catch {}

      if (this.#stopPromise !== null) {
        await this.#stopPromise;
        throw new Error("Vercel Sandbox cleanup started before runtime readiness completed.");
      }
      if (ready) {
        this.#dependencies.writeDiagnostic(`${runtimeKind} runtime is ready.\n`);
        return;
      }

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
          return adaptVercelSandboxCommand(
            await sandbox.runCommand({
              args: [...commandInput.args],
              cmd: commandInput.cmd,
              cwd: commandInput.cwd,
              detached: true,
              env: { ...commandInput.env },
            }),
          );
        }
        return adaptVercelSandboxCommand(
          await sandbox.runCommand({
            args: [...commandInput.args],
            cmd: commandInput.cmd,
            cwd: commandInput.cwd,
            detached: true,
          }),
        );
      }
      if (commandInput.env !== undefined) {
        return adaptVercelSandboxCommand(
          await sandbox.runCommand({
            args: [...commandInput.args],
            cmd: commandInput.cmd,
            cwd: commandInput.cwd,
            env: { ...commandInput.env },
          }),
        );
      }
      return adaptVercelSandboxCommand(
        await sandbox.runCommand({
          args: [...commandInput.args],
          cmd: commandInput.cmd,
          cwd: commandInput.cwd,
        }),
      );
    },
    runtime: sandbox.runtime,
    stop: async () => await sandbox.stop(),
    vcpus: sandbox.vcpus,
  };
}

function adaptVercelSandboxCommand(command: {
  readonly exitCode: number | null;
  kill(signal: "SIGTERM"): Promise<void>;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
  wait(): Promise<{ readonly exitCode: number }>;
}): BenchmarkSandboxCommand {
  return {
    exitCode: command.exitCode,
    kill: async (signal) => await command.kill(signal),
    stderr: async () => await command.stderr(),
    stdout: async () => await command.stdout(),
    wait: async () => await command.wait(),
  };
}

function formatCommandOutput(label: string, output: string): string {
  const maximumLength = 32_000;
  const retained = output.length <= maximumLength ? output : output.slice(-maximumLength);
  return `${label}:\n${retained}`;
}

function combineOperationAndCleanupErrors(
  operationError: unknown,
  cleanupError: unknown,
  message: string,
): unknown {
  if (operationError === cleanupError) return operationError;
  return new AggregateError([operationError, cleanupError], message);
}

function sanitizeError(
  error: unknown,
  secrets: readonly string[],
  sanitizedErrors: WeakSet<Error>,
): Error {
  if (error instanceof Error && sanitizedErrors.has(error)) return error;

  let sanitized: Error;
  if (error instanceof AggregateError) {
    const nestedErrors: Error[] = [];
    for (const nestedError of error.errors) {
      nestedErrors.push(sanitizeError(nestedError, secrets, sanitizedErrors));
    }
    sanitized = new AggregateError(nestedErrors, redactSecrets(error.message, secrets));
  } else if (error instanceof Error) {
    sanitized = new Error(redactSecrets(error.message, secrets));
    sanitized.name = redactSecrets(error.name, secrets);
  } else {
    sanitized = new Error(redactSecrets(String(error), secrets));
  }
  sanitizedErrors.add(sanitized);
  return sanitized;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[redacted]"), value);
}

async function withTimeout(
  operation: Promise<void>,
  milliseconds: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
