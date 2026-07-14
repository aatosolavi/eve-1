import { connect } from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { Nitro } from "nitro/types";

import {
  DrainedNitroDevServer,
  type DrainedDevServerListener,
} from "#internal/nitro/host/drained-nitro-dev-server.js";
import type {
  DevelopmentRunner,
  DevelopmentRunnerFactory,
} from "#internal/nitro/host/dev-runner.js";

const TEST_DEADLINE_MS = 5_000;

interface TestRunner extends DevelopmentRunner {
  crash(cause: Error): void;
  readonly closeMock: ReturnType<typeof vi.fn>;
}

interface NitroStub {
  emitError(cause: unknown): void;
  emitReload(): void;
  emitStart(): void;
  readonly nitro: ConstructorParameters<typeof DrainedNitroDevServer>[0];
}

function createNitroStub(): NitroStub {
  const handlers = new Map<string, Array<(payload?: never) => unknown>>();
  return {
    emitError(cause) {
      for (const handler of handlers.get("dev:error") ?? []) {
        handler(cause as never);
      }
    },
    emitReload() {
      for (const handler of handlers.get("dev:reload") ?? []) {
        handler(undefined as never);
      }
    },
    emitStart() {
      for (const handler of handlers.get("dev:start") ?? []) {
        handler(undefined as never);
      }
    },
    nitro: {
      hooks: {
        hook: ((name: string, handler: (payload?: never) => unknown) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
          return () => undefined;
        }) as Pick<Nitro["hooks"], "hook">["hook"],
      },
      logger: { error: () => undefined },
      options: { output: { dir: "/tmp/eve-drained-test", serverDir: "server" } },
    },
  };
}

function createRunnerFactory(
  fetchHandler: (request: Request, runnerIndex: number) => Promise<Response>,
  readiness: (runnerIndex: number) => Promise<void> = async () => undefined,
): { readonly createRunner: DevelopmentRunnerFactory; readonly runners: TestRunner[] } {
  const runners: TestRunner[] = [];
  const createRunner: DevelopmentRunnerFactory = () => {
    const runnerIndex = runners.length;
    let closed = false;
    const closedListeners = new Set<(cause?: unknown) => void>();
    const notifyClosed = (cause?: unknown) => {
      const listeners = [...closedListeners];
      closedListeners.clear();
      for (const listener of listeners) {
        listener(cause);
      }
    };
    const closeMock = vi.fn(async () => {
      closed = true;
      notifyClosed();
    });
    const runner: TestRunner = {
      close: closeMock,
      closeMock,
      get closed() {
        return closed;
      },
      crash(cause) {
        closed = true;
        notifyClosed(cause);
      },
      fetch: async (request) => await fetchHandler(request, runnerIndex),
      onceClosed(listener) {
        if (closed) {
          listener();
          return;
        }
        closedListeners.add(listener);
      },
      upgrade: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => await readiness(runnerIndex)),
    };
    runners.push(runner);
    return runner;
  };
  return { createRunner, runners };
}

async function listen(server: DrainedNitroDevServer): Promise<DrainedDevServerListener> {
  const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
  await listener.ready();
  if (listener.url === undefined) {
    throw new Error("Listener did not expose a URL.");
  }
  return listener;
}

async function withinDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), TEST_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("drained Nitro dev server", () => {
  it("keeps the previous worker serving when a candidate fails readiness", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(`runner-${String(runnerIndex)}`),
      async (runnerIndex) => {
        if (runnerIndex === 1) {
          throw new Error("candidate failed");
        }
      },
    );
    const stub = createNitroStub();
    const server = new DrainedNitroDevServer(stub.nitro, createRunner);
    const listener = await listen(server);

    stub.emitReload();
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-0");

    stub.emitStart();
    stub.emitReload();
    await vi.waitFor(() => {
      expect(runners[1]?.closeMock).toHaveBeenCalled();
    });
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-0");

    await server.close();
  });

  it("drains the retired worker only after its last admitted exchange settles", async () => {
    let releaseFirstResponse: (() => void) | undefined;
    const { createRunner, runners } = createRunnerFactory(async (_request, runnerIndex) => {
      if (runnerIndex === 0) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("started\n"));
            releaseFirstResponse = () => controller.close();
          },
        });
        return new Response(body);
      }
      return new Response("runner-1");
    });
    const stub = createNitroStub();
    const server = new DrainedNitroDevServer(stub.nitro, createRunner);
    const listener = await listen(server);

    stub.emitReload();
    const streaming = await fetch(new URL("/", listener.url));
    const reader = streaming.body?.getReader();
    await reader?.read();

    stub.emitReload();
    await withinDeadline(
      vi.waitFor(async () => {
        const response = await fetch(new URL("/", listener.url));
        expect(await response.text()).toBe("runner-1");
      }),
      "Timed out waiting for the replacement worker to serve.",
    );
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();

    releaseFirstResponse?.();
    await withinDeadline(
      (async () => {
        for (;;) {
          const result = await reader?.read();
          if (result === undefined || result.done) {
            return;
          }
        }
      })(),
      "Timed out waiting for the retired stream to finish.",
    );
    await vi.waitFor(() => {
      expect(runners[0]?.closeMock).toHaveBeenCalled();
    });

    await server.close();
  });

  it("restarts the worker when it exits unexpectedly", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(`runner-${String(runnerIndex)}`),
    );
    const stub = createNitroStub();
    const server = new DrainedNitroDevServer(stub.nitro, createRunner);
    const listener = await listen(server);
    stub.emitReload();
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-0");

    runners[0]?.crash(new Error("worker exploded"));
    await withinDeadline(
      vi.waitFor(async () => {
        const response = await fetch(new URL("/", listener.url));
        expect(await response.text()).toBe("runner-1");
      }),
      "Timed out waiting for the restarted worker.",
    );

    await server.close();
  });

  it("destroys the socket when an upgrade fails and closes idempotently", async () => {
    const { createRunner, runners } = createRunnerFactory(async () => new Response("ok"));
    const stub = createNitroStub();
    const server = new DrainedNitroDevServer(stub.nitro, createRunner);
    const listener = await listen(server);
    stub.emitReload();
    await fetch(new URL("/", listener.url));
    (runners[0] as { upgrade: unknown }).upgrade = vi.fn(async () => {
      throw new Error("upgrade rejected");
    });

    const target = new URL(listener.url ?? "");
    await withinDeadline(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
          socket.write(
            "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
        });
        socket.once("close", () => resolve());
        socket.once("error", reject);
      }),
      "Timed out waiting for the failed upgrade socket to close.",
    );

    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
  });
});
