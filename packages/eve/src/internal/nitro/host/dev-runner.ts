import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { BaseEnvRunner } from "#compiled/env-runner/index.js";
import { resolvePackageCompiledFilePath } from "#internal/application/package.js";
import { DEVELOPMENT_SESSION_LOG_FLUSH_ROUTE } from "#internal/session-logs/protocol.js";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";

const SESSION_LOG_FLUSH_TIMEOUT_MS = 1_000;

export interface DevelopmentRunner {
  readonly closed: boolean;
  close(cause?: unknown): Promise<void>;
  fetch(request: Request, init?: RequestInit): Promise<Response>;
  onceClosed(listener: (cause?: unknown) => void): void;
  upgrade(input: {
    readonly node: {
      readonly head: Buffer;
      readonly req: import("node:http").IncomingMessage;
      readonly socket: import("node:net").Socket;
    };
  }): Promise<void>;
  waitForReady(timeout: number): Promise<void>;
}

export interface DevelopmentRunnerInput {
  readonly entry: string;
  readonly name: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export type DevelopmentRunnerFactory = (input: DevelopmentRunnerInput) => DevelopmentRunner;

class NodeDevelopmentRunner extends BaseEnvRunner implements DevelopmentRunner {
  #closeCause: unknown;
  readonly #closedListeners = new Set<(cause?: unknown) => void>();
  #worker: Worker | undefined;

  constructor(input: DevelopmentRunnerInput) {
    const workerEntry = resolvePackageCompiledFilePath("src/compiled/env-runner/node-worker.js");
    super({
      data: {
        entry: input.entry,
        ...input.workerData,
      },
      hooks: {
        onClose: (_runner, cause) => {
          const listeners = [...this.#closedListeners];
          this.#closedListeners.clear();
          for (const listener of listeners) {
            listener(cause);
          }
        },
      },
      name: input.name,
      workerEntry,
    });
    this._initWithVirtualData(() => this.#startWorker());
  }

  onceClosed(listener: (cause?: unknown) => void): void {
    if (this.closed) {
      listener(this.#closeCause);
      return;
    }
    this.#closedListeners.add(listener);
  }

  override sendMessage(message: unknown): void {
    if (this.#worker === undefined) {
      throw new Error("Development worker is not initialized.");
    }
    this.#worker.postMessage(message);
  }

  override async waitForReady(timeout: number): Promise<void> {
    try {
      await super.waitForReady(timeout);
    } catch (error) {
      if (this.#closeCause === undefined) {
        throw error;
      }
      throw new Error(
        `Development worker failed before readiness: ${this.#closeCause instanceof Error ? this.#closeCause.message : String(this.#closeCause)}`,
        { cause: this.#closeCause },
      );
    }
  }

  protected override _hasRuntime(): boolean {
    return this.#worker !== undefined;
  }

  protected override _runtimeType(): string {
    return "worker";
  }

  protected override async _closeRuntime(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) {
      return;
    }

    await this.#flushSessionLogs();
    this.#worker = undefined;
    worker.removeAllListeners();
    await worker.terminate();
  }

  async #flushSessionLogs(): Promise<void> {
    const secret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
    if (secret === undefined) return;
    try {
      await this.fetch(DEVELOPMENT_SESSION_LOG_FLUSH_ROUTE, {
        headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: secret },
        method: "POST",
        signal: AbortSignal.timeout(SESSION_LOG_FLUSH_TIMEOUT_MS),
      });
    } catch {
      // Worker shutdown must proceed when diagnostics are unavailable.
    }
  }

  protected override _handleMessage(message: unknown): void {
    if (isWorkerInitializationError(message)) {
      this.#closeCause = new Error(message.error);
    }
    super._handleMessage(message);
  }

  #startWorker(): void {
    if (!existsSync(this._workerEntry)) {
      void this.close(`Development worker entry not found at "${this._workerEntry}".`);
      return;
    }

    const worker = new Worker(this._workerEntry, {
      env: process.env,
      workerData: {
        name: this._name,
        ...this._data,
      },
    });
    this.#worker = worker;
    worker.once("error", (error) => {
      this.#closeCause = error;
      void this.close(error);
    });
    worker.once("exit", (code) => {
      const error = new Error(`Development worker exited with code ${String(code)}.`);
      this.#closeCause ??= error;
      void this.close(error);
    });
    worker.on("message", (message: unknown) => this._handleMessage(message));
  }
}

export const createNodeDevelopmentRunner: DevelopmentRunnerFactory = (input) =>
  new NodeDevelopmentRunner(input);

function isWorkerInitializationError(
  value: unknown,
): value is { readonly error: string; readonly event: "init-error" } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.event === "init-error" && typeof record.error === "string";
}
