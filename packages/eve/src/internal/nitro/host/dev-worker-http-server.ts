import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  closeServer,
  createPublicRequest,
  createWorkerRequest,
  stampWorkerUpgradeRequest,
  writeRequestError,
  writeResponse,
} from "#internal/nitro/host/dev-worker-http.js";
import type {
  DevelopmentWorkerGeneration,
  DevelopmentWorkerListener,
  DevelopmentWorkerRunner,
} from "#internal/nitro/host/dev-worker-server-types.js";

interface ActiveExchange {
  cancel(): void;
  readonly runner: DevelopmentWorkerRunner;
}

interface ListenerState {
  readonly beginClose: () => Promise<void>;
  destroySockets(): void;
}

export interface DevelopmentWorkerHttpLease {
  readonly generation: DevelopmentWorkerGeneration;
  release(): void;
  readonly runner: DevelopmentWorkerRunner;
}

export class DevelopmentWorkerHttpServer {
  readonly #activeExchanges = new Set<ActiveExchange>();
  readonly #admit: () => Promise<DevelopmentWorkerHttpLease>;
  readonly #handleParentRequest: (request: Request) => Promise<Response | undefined>;
  readonly #listeners = new Set<ListenerState>();
  readonly #transportSecret: string;

  constructor(input: {
    readonly admit: () => Promise<DevelopmentWorkerHttpLease>;
    readonly handleParentRequest: (request: Request) => Promise<Response | undefined>;
    readonly transportSecret: string;
  }) {
    this.#admit = input.admit;
    this.#handleParentRequest = input.handleParentRequest;
    this.#transportSecret = input.transportSecret;
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener {
    let url: string | undefined;
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket as Socket, head);
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Development worker server did not expose a TCP address."));
          return;
        }
        url = `http://${formatListenerHostname(input.hostname)}:${String(address.port)}/`;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: input.hostname, port: input.port });
    });

    let listenerClosePromise: Promise<void> | undefined;
    const beginClose = () => {
      listenerClosePromise ??= closeServer(server).finally(() => {
        this.#listeners.delete(listenerState);
      });
      return listenerClosePromise;
    };
    const destroySockets = () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    };
    const listenerState: ListenerState = { beginClose, destroySockets };
    this.#listeners.add(listenerState);

    return {
      async close() {
        const closed = beginClose();
        destroySockets();
        await closed;
      },
      node: { server },
      ready: async () => await ready,
      get url() {
        return url;
      },
    };
  }

  cancelRunnerExchanges(runner: DevelopmentWorkerRunner): void {
    for (const exchange of this.#activeExchanges) {
      if (exchange.runner === runner) {
        exchange.cancel();
        this.#activeExchanges.delete(exchange);
      }
    }
  }

  async close(closeWorkers: () => Promise<void>): Promise<void> {
    const listeners = [...this.#listeners];
    const listenerClosePromises = listeners.map((listener) => listener.beginClose());
    for (const exchange of this.#activeExchanges) {
      exchange.cancel();
    }
    this.#activeExchanges.clear();
    await closeWorkers();
    for (const listener of listeners) {
      listener.destroySockets();
    }
    await Promise.all(listenerClosePromises);
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortRequest = (cause?: unknown) => {
      if (!requestAbort.signal.aborted) {
        requestAbort.abort(cause);
      }
    };
    request.once("aborted", abortRequest);
    request.once("error", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) {
        abortRequest();
      }
    });

    let exchange: ActiveExchange | undefined;
    try {
      const publicRequest = createPublicRequest(request, requestAbort.signal);
      const parentResponse = await this.#handleParentRequest(publicRequest);
      if (parentResponse !== undefined) {
        await writeResponse(response, parentResponse, requestAbort.signal);
        return;
      }
      const lease = await this.#admit();
      const admittedLease = lease;
      exchange = {
        cancel() {
          abortRequest(new Error("Development worker request was cancelled."));
          if (!response.destroyed) {
            response.destroy();
          }
          admittedLease.release();
        },
        runner: lease.runner,
      };
      this.#activeExchanges.add(exchange);
      response.once("finish", admittedLease.release);
      response.once("error", admittedLease.release);
      response.once("close", admittedLease.release);
      request.once("aborted", admittedLease.release);
      const workerRequest = createWorkerRequest({
        generation: lease.generation,
        request: publicRequest,
        secret: this.#transportSecret,
        socket: request.socket,
      });
      const workerResponse = await lease.runner.fetch(workerRequest);
      await writeResponse(response, workerResponse, requestAbort.signal);
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        writeRequestError(response, error);
      }
    } finally {
      if (exchange !== undefined) {
        exchange.cancel();
        this.#activeExchanges.delete(exchange);
      }
      request.off("aborted", abortRequest);
      request.off("error", abortRequest);
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let lease: DevelopmentWorkerHttpLease | undefined;
    let exchange: ActiveExchange | undefined;
    try {
      lease = await this.#admit();
      stampWorkerUpgradeRequest({
        generation: lease.generation,
        request,
        secret: this.#transportSecret,
      });
      const admittedLease = lease;
      exchange = {
        cancel() {
          if (!socket.destroyed) {
            socket.destroy();
          }
          admittedLease.release();
        },
        runner: lease.runner,
      };
      this.#activeExchanges.add(exchange);
      const release = () => {
        admittedLease.release();
        if (exchange !== undefined) {
          this.#activeExchanges.delete(exchange);
          exchange = undefined;
        }
      };
      socket.once("close", release);
      socket.once("error", release);
      await lease.runner.upgrade({ node: { head, req: request, socket } });
    } catch {
      if (exchange !== undefined) {
        exchange.cancel();
      } else {
        // Failure before the exchange existed: no socket listener releases
        // the lease, so release it here or the retired worker never closes.
        lease?.release();
      }
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }
}

function formatListenerHostname(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}
