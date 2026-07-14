import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";

import type { Nitro } from "nitro/types";

import {
  closeServer,
  createPublicRequest,
  writeRequestError,
  writeResponse,
} from "#internal/nitro/host/dev-server-http.js";
import {
  createNodeDevelopmentRunner,
  type DevelopmentRunner,
  type DevelopmentRunnerFactory,
} from "#internal/nitro/host/dev-runner.js";
import { toErrorMessage } from "#shared/errors.js";

const RUNNER_READY_TIMEOUT_MS = 60_000;

export interface DrainedDevServerListener {
  close(): Promise<void>;
  readonly node: { readonly server: Server };
  ready(): Promise<void>;
  readonly url: string | undefined;
}

interface RunnerSlot {
  activeExchanges: number;
  drained: boolean;
  quietListeners: Array<() => void>;
  readonly runner: DevelopmentRunner;
}

interface NitroDevHost {
  readonly hooks: Pick<Nitro["hooks"], "hook">;
  readonly logger: { error(message: unknown, ...details: unknown[]): unknown };
  readonly options: {
    readonly output: Pick<Nitro["options"]["output"], "dir" | "serverDir">;
  };
}

/**
 * Development server with the stock Nitro dev-server contract (`dev:start`,
 * `dev:reload`, `dev:error`, ready-gated worker replacement) plus drained
 * replacement: the retired worker keeps serving the responses and sockets it
 * already admitted — without bound, a streaming turn can hold one for
 * minutes — and is terminated only once its last exchange settles. Stock
 * Nitro terminates the previous worker as soon as the next one attaches,
 * which resets admitted work; this class exists solely to close that gap and
 * is intended to be deleted in favor of `createDevServer` once equivalent
 * drain semantics are available upstream.
 */
export class DrainedNitroDevServer {
  readonly #createRunner: DevelopmentRunnerFactory;
  readonly #draining = new Set<RunnerSlot>();
  readonly #listeners = new Set<{ beginClose(): Promise<void>; destroySockets(): void }>();
  readonly #nitro: NitroDevHost;
  #active: RunnerSlot | undefined;
  #buildError: unknown;
  #buildWaiters: Array<() => void> = [];
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #entry: string;
  #reloadChain: Promise<void> = Promise.resolve();
  #runnerCounter = 0;
  #workerData: Readonly<Record<string, unknown>> = {};

  constructor(
    nitro: NitroDevHost,
    createRunner: DevelopmentRunnerFactory = createNodeDevelopmentRunner,
  ) {
    this.#createRunner = createRunner;
    this.#nitro = nitro;
    this.#entry = resolve(nitro.options.output.dir, nitro.options.output.serverDir, "index.mjs");

    nitro.hooks.hook("dev:start", () => {
      this.#buildError = undefined;
    });
    nitro.hooks.hook("dev:reload", (payload) => {
      this.#buildError = undefined;
      if (payload?.entry !== undefined) {
        this.#entry = payload.entry;
      }
      if (payload?.workerData !== undefined) {
        this.#workerData = payload.workerData;
      }
      this.#scheduleReload();
    });
    nitro.hooks.hook("dev:error", (cause) => {
      this.#buildError = cause;
      this.#finishBuild();
    });
    nitro.hooks.hook("close", async () => await this.close());
  }

  listen(input: { readonly hostname: string; readonly port: number }): DrainedDevServerListener {
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }

    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket as Socket, head);
    });

    let url: string | undefined;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectPromise(new Error("Development server did not expose a TCP address."));
          return;
        }
        const host = input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname;
        url = `http://${host}:${String(address.port)}/`;
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: input.hostname, port: input.port });
    });

    let closePromise: Promise<void> | undefined;
    const listenerState = {
      beginClose: () => {
        closePromise ??= closeServer(server).finally(() => {
          this.#listeners.delete(listenerState);
        });
        return closePromise;
      },
      destroySockets: () => {
        for (const socket of sockets) {
          socket.destroy();
        }
      },
    };
    this.#listeners.add(listenerState);

    return {
      async close() {
        const closed = listenerState.beginClose();
        listenerState.destroySockets();
        await closed;
      },
      node: { server },
      ready: async () => await ready,
      get url() {
        return url;
      },
    };
  }

  async waitForActiveRunner(timeoutMs: number = RUNNER_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // An active runner keeps serving through rebuilds; only the initial boot
    // (or a boot whose first candidate failed) has nothing to serve with.
    while (this.#active === undefined && !this.#closed) {
      if (this.#buildError !== undefined) {
        throw this.#buildError instanceof Error
          ? this.#buildError
          : new Error(String(this.#buildError));
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the development worker to become ready.");
      }
      await new Promise<void>((resolvePromise) => {
        this.#buildWaiters.push(resolvePromise);
        setTimeout(resolvePromise, 100);
      });
    }
    if (this.#closed) {
      throw new Error("Development server is closed.");
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#finishBuild();

    const listeners = [...this.#listeners];
    const listenerClosePromises = listeners.map((listener) => listener.beginClose());

    const slots = [this.#active, ...this.#draining].filter(
      (slot): slot is RunnerSlot => slot !== undefined,
    );
    this.#active = undefined;
    this.#draining.clear();
    await Promise.all(slots.map(async (slot) => await slot.runner.close()));

    for (const listener of listeners) {
      listener.destroySockets();
    }
    await Promise.all(listenerClosePromises);
  }

  #scheduleReload(): void {
    this.#reloadChain = this.#reloadChain
      .catch(() => undefined)
      .then(async () => await this.#reload());
  }

  async #reload(): Promise<void> {
    if (this.#closed) {
      return;
    }

    const slot: RunnerSlot = {
      activeExchanges: 0,
      drained: false,
      quietListeners: [],
      runner: this.#createRunner({
        entry: this.#entry,
        name: `eve-dev-${String(this.#runnerCounter++)}`,
        workerData: this.#workerData,
      }),
    };

    try {
      await slot.runner.waitForReady(RUNNER_READY_TIMEOUT_MS);
    } catch (error) {
      await slot.runner.close(error).catch(() => undefined);
      // A failed candidate stays invisible: the previous worker keeps
      // serving, exactly like a failed Nitro build.
      this.#nitro.logger.error(`[eve:dev] dev worker candidate failed: ${toErrorMessage(error)}`);
      if (this.#active === undefined) {
        this.#buildError = error;
      }
      this.#finishBuild();
      return;
    }

    if (this.#closed) {
      await slot.runner.close().catch(() => undefined);
      return;
    }

    const previous = this.#active;
    this.#active = slot;
    slot.runner.onceClosed(() => {
      void this.#handleRunnerClose(slot);
    });
    this.#finishBuild();

    if (previous !== undefined) {
      this.#drainInBackground(previous);
    }
  }

  async #handleRunnerClose(slot: RunnerSlot): Promise<void> {
    if (this.#closed || this.#active !== slot) {
      return;
    }
    this.#active = undefined;
    this.#nitro.logger.error("[eve:dev] dev worker exited; restarting.");
    this.#scheduleReload();
  }

  #drainInBackground(slot: RunnerSlot): void {
    this.#draining.add(slot);
    const finishDrain = () => {
      if (slot.drained) {
        return;
      }
      slot.drained = true;
      this.#draining.delete(slot);
      void slot.runner.close().catch(() => undefined);
    };
    if (slot.activeExchanges === 0) {
      finishDrain();
      return;
    }
    slot.quietListeners.push(finishDrain);
  }

  #beginExchange(slot: RunnerSlot): () => void {
    slot.activeExchanges += 1;
    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      slot.activeExchanges -= 1;
      if (slot.activeExchanges === 0) {
        for (const listener of slot.quietListeners.splice(0)) {
          listener();
        }
      }
    };
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortRequest = (cause?: unknown) => {
      if (!requestAbort.signal.aborted) {
        requestAbort.abort(cause);
      }
    };
    request.once("error", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) {
        abortRequest();
      }
    });

    let settle: (() => void) | undefined;
    try {
      await this.waitForActiveRunner();
      const slot = this.#active;
      if (slot === undefined) {
        throw new Error("Development worker is unavailable.");
      }
      settle = this.#beginExchange(slot);
      const workerResponse = await slot.runner.fetch(
        createPublicRequest(request, requestAbort.signal),
      );
      await writeResponse(response, workerResponse, requestAbort.signal);
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        writeRequestError(response, error);
      }
    } finally {
      settle?.();
      request.off("error", abortRequest);
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let settle: (() => void) | undefined;
    try {
      await this.waitForActiveRunner();
      const slot = this.#active;
      if (slot === undefined) {
        throw new Error("Development worker is unavailable.");
      }
      settle = this.#beginExchange(slot);
      socket.once("close", settle);
      socket.once("error", settle);
      await slot.runner.upgrade({ node: { head, req: request, socket } });
    } catch {
      settle?.();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  #finishBuild(): void {
    for (const wake of this.#buildWaiters.splice(0)) {
      wake();
    }
  }
}
