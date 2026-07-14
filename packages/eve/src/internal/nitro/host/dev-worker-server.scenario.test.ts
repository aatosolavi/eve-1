import { Agent, request as requestHttp } from "node:http";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { turnWorkflowReference } from "#execution/workflow-runtime.js";
import { writeDevelopmentRuntimeArtifactsWorker } from "#internal/nitro/dev-runtime-worker-artifacts.js";
import { createDevelopmentWorkerServer } from "#internal/nitro/host/dev-worker-server.js";
import type {
  DevelopmentWorkerGeneration,
  DevelopmentWorkerRunner,
  DevelopmentWorkerRunnerFactory,
} from "#internal/nitro/host/dev-worker-server-types.js";
import {
  decodeDevelopmentWorkerMetadata,
  DEVELOPMENT_WORKER_METADATA_HEADER,
} from "#internal/nitro/host/dev-worker-metadata.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { encodeDevelopmentWorldValue } from "#internal/workflow/development-world-codec.js";
import {
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#internal/workflow/development-world-protocol.js";
import { createParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-server.js";

const createScratchDirectory = useTemporaryDirectories();

const TEST_DEADLINE_MS = 5_000;

const FIRST_GENERATION: DevelopmentWorkerGeneration = {
  id: "first",
  runtimeAppRoot: "/tmp/eve-dev-runtime/first/source/app",
  snapshotRoot: "/tmp/eve-dev-runtime/first",
};
const SECOND_GENERATION: DevelopmentWorkerGeneration = {
  id: "second",
  runtimeAppRoot: "/tmp/eve-dev-runtime/second/source/app",
  snapshotRoot: "/tmp/eve-dev-runtime/second",
};

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });

  return {
    promise,
    reject(error) {
      rejectPromise?.(error);
    },
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

interface TestRunner extends DevelopmentWorkerRunner {
  readonly closeMock: ReturnType<typeof vi.fn>;
  readonly waitForReady: ReturnType<typeof vi.fn<(timeout: number) => Promise<void>>>;
  crash(error: Error): void;
}

function createRunnerFactory(
  fetchHandler: (request: Request, runnerIndex: number, secret: string) => Promise<Response>,
  waitForReady: (runnerIndex: number) => Promise<void> = async () => undefined,
  upgradeHandler: (
    input: Parameters<DevelopmentWorkerRunner["upgrade"]>[0],
    runnerIndex: number,
    secret: string,
  ) => Promise<void> = async () => undefined,
): {
  readonly createRunner: DevelopmentWorkerRunnerFactory;
  readonly runners: TestRunner[];
} {
  const runners: TestRunner[] = [];
  const createRunner: DevelopmentWorkerRunnerFactory = (input) => {
    const runnerIndex = runners.length;
    let closed = false;
    const closeMock = vi.fn(async () => {
      closed = true;
      input.onClose();
    });
    const runner: TestRunner = {
      close: closeMock,
      closeMock,
      crash(error) {
        closed = true;
        input.onClose(error);
      },
      fetch: async (request) => await fetchHandler(request, runnerIndex, input.transportSecret),
      get closed() {
        return closed;
      },
      upgrade: vi.fn(
        async (upgradeInput) =>
          await upgradeHandler(upgradeInput, runnerIndex, input.transportSecret),
      ),
      waitForReady: vi.fn(async () => await waitForReady(runnerIndex)),
    };
    runners.push(runner);
    return runner;
  };

  return { createRunner, runners };
}

async function listen(createRunner: DevelopmentWorkerRunnerFactory): Promise<{
  readonly server: ReturnType<typeof createDevelopmentWorkerServer>;
  readonly url: string;
}> {
  return await listenWithGenerationResolver(createRunner, (generation) => generation);
}

async function listenWithGenerationResolver(
  createRunner: DevelopmentWorkerRunnerFactory,
  resolveAdmissionGeneration: (
    workerGeneration: DevelopmentWorkerGeneration,
  ) => DevelopmentWorkerGeneration,
): Promise<{
  readonly server: ReturnType<typeof createDevelopmentWorkerServer>;
  readonly url: string;
}> {
  const server = createDevelopmentWorkerServer({
    appRoot: "/tmp/eve-dev-worker-test",
    createRunner,
    resolveAdmissionGeneration,
    workflowWorld: { agentName: "worker-server-test", kind: "parent-local" },
  });
  const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
  await listener.ready();
  if (listener.url === undefined) {
    throw new Error("Development worker listener did not expose a URL.");
  }

  return { server, url: listener.url };
}

async function closeWithinDeadline(close: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Development worker server close timed out.")),
      TEST_DEADLINE_MS,
    );
  });

  try {
    await Promise.race([close(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function withinDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), TEST_DEADLINE_MS);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe("development worker server", () => {
  it("disposes a candidate host when worker creation fails", async () => {
    const dispose = vi.fn(async () => undefined);
    const server = createDevelopmentWorkerServer({
      appRoot: "/tmp/eve-dev-worker-test",
      createRunner: () => {
        throw new Error("worker creation failed");
      },
      resolveAdmissionGeneration: (generation) => generation,
      workflowWorld: { agentName: "worker-server-test", kind: "parent-local" },
    });

    await expect(
      server.prepareCandidate({
        dispose,
        entry: "/tmp/failed.mjs",
        generation: FIRST_GENERATION,
        workerData: {},
      }),
    ).rejects.toThrow("worker creation failed");
    expect(dispose).toHaveBeenCalledOnce();
    await closeWithinDeadline(() => server.close());
  });

  it("keeps the active worker while a candidate is unready or fails readiness", async () => {
    const candidateReadiness = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(runnerIndex === 0 ? "active" : "candidate"),
      async (runnerIndex) => {
        if (runnerIndex === 1) {
          await candidateReadiness.promise;
        }
      },
    );
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);
    server.setControlHandler(async (request) => {
      const pathname = new URL(request.url).pathname;
      return pathname === "/control" ? new Response("parent") : undefined;
    });

    const pendingCandidate = server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });
    await vi.waitFor(() => {
      expect(runners[1]?.waitForReady).toHaveBeenCalledOnce();
    });
    await expect(
      fetch(new URL("/control", url)).then(async (response) => await response.text()),
    ).resolves.toBe("parent");
    await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
      "active",
    );

    candidateReadiness.reject(new Error("candidate failed readiness"));
    await expect(pendingCandidate).rejects.toThrow("candidate failed readiness");
    await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
      "active",
    );
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();

    await closeWithinDeadline(() => server.close());
  });

  it("restarts an active worker after a crash without moving its generation", async () => {
    const { createRunner, runners } = createRunnerFactory(async (request, runnerIndex, secret) => {
      const metadata = decodeDevelopmentWorkerMetadata({
        header: request.headers.get(DEVELOPMENT_WORKER_METADATA_HEADER),
        secret,
      });
      return new Response(`${String(runnerIndex)}:${metadata.generationId}`);
    });
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);

    runners[0]?.crash(new Error("worker crashed"));
    await vi.waitFor(async () => {
      await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
        "1:first",
      );
    });

    await closeWithinDeadline(() => server.close());
  });

  it("admits later requests on a new runtime generation without replacing the worker", async () => {
    let admissionGeneration = FIRST_GENERATION;
    const { createRunner, runners } = createRunnerFactory(async (request, runnerIndex, secret) => {
      const metadata = decodeDevelopmentWorkerMetadata({
        header: request.headers.get(DEVELOPMENT_WORKER_METADATA_HEADER),
        secret,
      });
      return new Response(`${String(runnerIndex)}:${metadata.generationId}`);
    });
    const { server, url } = await listenWithGenerationResolver(
      createRunner,
      () => admissionGeneration,
    );
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
      "0:first",
    );
    admissionGeneration = SECOND_GENERATION;
    await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
      "0:second",
    );
    expect(runners).toHaveLength(1);

    await closeWithinDeadline(() => server.close());
  });

  it("terminates an active client response when its worker crashes", async () => {
    const responseStarted = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
              responseStarted.resolve();
            },
          }),
        ),
    );
    const { server, url } = await listen(createRunner);
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/stream.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    const response = await fetch(url);
    const reader = response.body?.getReader();
    await responseStarted.promise;
    await expect(reader?.read()).resolves.toEqual(expect.objectContaining({ done: false }));
    runners[0]?.crash(new Error("worker crashed"));

    await expect(
      withinDeadline(
        reader?.read() ?? Promise.reject(new Error("Missing response body.")),
        "Client response remained open after its worker crashed.",
      ),
    ).rejects.toThrow();
    await closeWithinDeadline(() => server.close());
  });

  it("releases a retired worker when the client disconnects from its response", async () => {
    const bodyCancelled = createDeferred<void>();
    const firstChunk = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(async (_request, runnerIndex) => {
      if (runnerIndex !== 0) {
        return new Response("next");
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first\n"));
            firstChunk.resolve();
          },
          cancel() {
            bodyCancelled.resolve();
          },
        }),
      );
    });
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);

    const response = await fetch(url);
    await firstChunk.promise;
    const second = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });
    await server.promote(second);

    expect(runners[0]?.closeMock).not.toHaveBeenCalled();
    await response.body?.cancel();
    await withinDeadline(
      bodyCancelled.promise,
      "Worker response body was not cancelled after the client disconnected.",
    );
    await vi.waitFor(() => {
      expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
    });

    await closeWithinDeadline(() => server.close());
  });

  it("releases a retired worker when the client aborts a request body", async () => {
    const bodyAborted = createDeferred<void>();
    const bodyStarted = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(async (request, runnerIndex) => {
      if (runnerIndex !== 0) {
        return new Response("next");
      }
      bodyStarted.resolve();
      await request.text().catch(() => bodyAborted.resolve());
      return new Response("unexpected");
    });
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);

    const target = new URL(url);
    const request = requestHttp({
      headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
      host: target.hostname,
      method: "POST",
      path: "/",
      port: Number(target.port),
    });
    request.on("error", () => undefined);
    request.write("partial body");
    await bodyStarted.promise;
    const second = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });
    await server.promote(second);
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();

    request.destroy();
    await withinDeadline(
      bodyAborted.promise,
      "Worker request body did not observe the client cancellation.",
    );
    await vi.waitFor(() => {
      expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
    });

    await closeWithinDeadline(() => server.close());
  });

  it("keeps the public HTTP connection alive across worker promotion", async () => {
    const { createRunner } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(String(runnerIndex)),
    );
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    try {
      const firstResponse = await requestWithAgent(url, agent);
      const second = await server.prepareCandidate({
        dispose: async () => undefined,
        entry: "/tmp/second.mjs",
        generation: SECOND_GENERATION,
        workerData: {},
      });
      await server.promote(second);
      const secondResponse = await requestWithAgent(url, agent);

      expect(firstResponse.body).toBe("0");
      expect(secondResponse.body).toBe("1");
      expect(secondResponse.localPort).toBe(firstResponse.localPort);
    } finally {
      agent.destroy();
      await closeWithinDeadline(() => server.close());
    }
  });

  it("keeps the active worker when structural publication fails", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(runnerIndex === 0 ? "active" : "candidate"),
    );
    const { server, url } = await listen(createRunner);
    const active = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(active);
    const candidateDispose = vi.fn(async () => undefined);
    const candidate = await server.prepareCandidate({
      dispose: candidateDispose,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });

    await expect(
      server.publishStructuralCandidate({
        candidate,
        publish: async () => {
          throw new Error("pointer publication failed");
        },
      }),
    ).rejects.toThrow("pointer publication failed");
    await server.discardCandidate(candidate);

    await expect(fetch(url).then(async (response) => await response.text())).resolves.toBe(
      "active",
    );
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();
    expect(runners[1]?.closeMock).toHaveBeenCalledOnce();
    expect(candidateDispose).toHaveBeenCalledOnce();

    await closeWithinDeadline(() => server.close());
  });

  it("rolls back publication before admitting requests when a candidate closes", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(runnerIndex === 0 ? "active" : "candidate"),
    );
    const { server, url } = await listen(createRunner);
    const active = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(active);
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });
    const rollbackAllowed = createDeferred<void>();
    const rollback = vi.fn(async () => await rollbackAllowed.promise);

    const promotion = server.publishStructuralCandidate({
      candidate,
      publish: async () => {
        runners[1]?.crash(new Error("candidate closed during publication"));
        return { commit: vi.fn(), rollback };
      },
    });
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
    let requestSettled = false;
    const request = fetch(url)
      .then(async (response) => await response.text())
      .finally(() => {
        requestSettled = true;
      });
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    rollbackAllowed.resolve();
    await expect(promotion).rejects.toThrow("not ready for promotion");
    await expect(request).resolves.toBe("active");
    await server.discardCandidate(candidate);

    await closeWithinDeadline(() => server.close());
  });

  it("holds a websocket lease until close and stamps the parent socket address", async () => {
    let clientAddress: string | null | undefined;
    const upgraded = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(
      async () => new Response("not used"),
      async () => undefined,
      async (input, _runnerIndex, secret) => {
        const metadata = decodeDevelopmentWorkerMetadata({
          header: input.node.req.headers["x-eve-dev-worker-metadata"] as string,
          secret,
        });
        clientAddress = metadata.clientAddress;
        input.node.socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        upgraded.resolve();
      },
    );
    const { server, url } = await listen(createRunner);
    const first = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/first.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(first);
    const target = new URL(url);
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => undefined);
    socket.write(
      [
        "GET /socket HTTP/1.1",
        `Host: ${target.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "x-eve-dev-worker-metadata: public-spoof",
        "",
        "",
      ].join("\r\n"),
    );
    await upgraded.promise;
    const second = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/second.mjs",
      generation: SECOND_GENERATION,
      workerData: {},
    });
    await server.promote(second);

    expect(clientAddress).toBe("127.0.0.1");
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();
    socket.destroy();
    await vi.waitFor(() => {
      expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
    });

    await closeWithinDeadline(() => server.close());
  });

  it("stops the worker producing an active stream before waiting for listener shutdown", async () => {
    const responseStarted = createDeferred<void>();
    const { createRunner, runners } = createRunnerFactory(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
              responseStarted.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const { server, url } = await listen(createRunner);
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/stream.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    const response = await fetch(url);
    const reader = response.body?.getReader();
    await responseStarted.promise;
    await expect(reader?.read()).resolves.toEqual(expect.objectContaining({ done: false }));
    await closeWithinDeadline(() => server.close());

    expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
    await expect(reader?.read()).rejects.toThrow();
  });

  it("preserves the socket client address in signed metadata and replaces public spoofing", async () => {
    const { createRunner } = createRunnerFactory(async (request, _runnerIndex, secret) => {
      const metadata = decodeDevelopmentWorkerMetadata({
        header: request.headers.get(DEVELOPMENT_WORKER_METADATA_HEADER),
        secret,
      });
      return Response.json({
        clientAddress: metadata.clientAddress,
        runtimeAppRoot: metadata.runtimeAppRoot,
      });
    });
    const { server, url } = await listen(createRunner);
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/metadata.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    const body = await new Promise<string>((resolve, reject) => {
      const target = new URL(url);
      const request = requestHttp(
        {
          headers: { "x-eve-dev-worker-metadata": "public-spoof" },
          host: target.hostname,
          path: "/",
          port: Number(target.port),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(JSON.parse(body)).toEqual({
      clientAddress: "127.0.0.1",
      runtimeAppRoot: FIRST_GENERATION.runtimeAppRoot,
    });

    await closeWithinDeadline(() => server.close());
  });

  it("leaves configured World queue requests with the worker", async () => {
    const { createRunner } = createRunnerFactory(async (request) =>
      request.url.endsWith("/.well-known/workflow/v1/flow")
        ? new Response("configured-world")
        : new Response("unexpected", { status: 404 }),
    );
    const server = createDevelopmentWorkerServer({
      appRoot: "/tmp/eve-dev-worker-configured-world-test",
      createRunner,
      resolveAdmissionGeneration: (generation) => generation,
      workflowWorld: { kind: "worker-configured" },
    });
    const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
    await listener.ready();
    if (listener.url === undefined) {
      throw new Error("Development worker listener did not expose a URL.");
    }
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/configured-world.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    await expect(
      fetch(new URL("/.well-known/workflow/v1/flow", listener.url), {
        body: "{}",
        method: "POST",
      }).then(async (response) => await response.text()),
    ).resolves.toBe("configured-world");

    await closeWithinDeadline(() => server.close());
  });

  it("restores one retired worker for runtime generations that shared a workspace", async () => {
    const appRoot = await createScratchDirectory("eve-dev-worker-shared-restore-");
    const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "workspace-1");
    const entry = join(workspaceRoot, "output", "index.mjs");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "export default {};\n");
    for (const generationId of ["first", "second"]) {
      await writeActivatedGenerationSnapshot({ appRoot, entry, generationId, workspaceRoot });
    }

    const seedSecret = "seed-transport-secret";
    const seedWorld = createParentDevelopmentWorkflowWorld({
      agentName: "shared-restore-test",
      appRoot,
      dispatch: async () => Response.json({ ok: true }),
      hasGeneration: () => true,
      resolveActiveGenerationId: () => "second",
      transportSecret: seedSecret,
    });
    await seedWorld.start();
    for (const generationId of ["first", "second"]) {
      const response = await seedWorld.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
          body: encodeDevelopmentWorldValue({
            arguments: [
              null,
              {
                eventData: {
                  deploymentId: generationId,
                  executionContext: {},
                  input: new Uint8Array(),
                  workflowName: turnWorkflowReference.workflowId,
                },
                eventType: "run_created",
                specVersion: 5,
              },
            ],
            operation: "events.create",
          }),
          headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: seedSecret },
          method: "POST",
        }),
      );
      expect(response?.status).toBe(200);
    }
    await seedWorld.close();

    const dispatchedGenerationIds = new Set<string>();
    const { createRunner, runners } = createRunnerFactory(async (request, _index, secret) => {
      const metadata = decodeDevelopmentWorkerMetadata({
        header: request.headers.get(DEVELOPMENT_WORKER_METADATA_HEADER),
        secret,
      });
      dispatchedGenerationIds.add(metadata.generationId);
      return Response.json({ ok: true });
    });
    const server = createDevelopmentWorkerServer({
      appRoot,
      createRunner,
      resolveAdmissionGeneration: (generation) => generation,
      workflowWorld: { agentName: "shared-restore-test", kind: "parent-local" },
    });
    const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
    await listener.ready();
    const previousBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    process.env.WORKFLOW_LOCAL_BASE_URL = listener.url;
    try {
      await server.startWorkflowWorld();

      expect(runners).toHaveLength(1);
      await withinDeadline(
        vi.waitFor(() => {
          expect(dispatchedGenerationIds).toEqual(new Set(["first", "second"]));
        }),
        "Timed out waiting for both restored generation deliveries.",
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.WORKFLOW_LOCAL_BASE_URL;
      } else {
        process.env.WORKFLOW_LOCAL_BASE_URL = previousBaseUrl;
      }
      await closeWithinDeadline(() => server.close());
    }
  });

  it("closes workers and listeners only once when close is repeated", async () => {
    const { createRunner, runners } = createRunnerFactory(async () => new Response("ok"));
    const { server } = await listen(createRunner);
    const candidate = await server.prepareCandidate({
      dispose: async () => undefined,
      entry: "/tmp/close.mjs",
      generation: FIRST_GENERATION,
      workerData: {},
    });
    await server.promote(candidate);

    await closeWithinDeadline(async () => {
      await Promise.all([server.close(), server.close()]);
      await server.close();
    });

    expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
  });
});

async function requestWithAgent(
  url: string,
  agent: Agent,
): Promise<{ readonly body: string; readonly localPort: number | undefined }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = requestHttp(
      {
        agent,
        host: target.hostname,
        path: "/",
        port: Number(target.port),
      },
      (response) => {
        const chunks: Buffer[] = [];
        const localPort = response.socket.localPort;
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), localPort });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function writeActivatedGenerationSnapshot(input: {
  readonly appRoot: string;
  readonly entry: string;
  readonly generationId: string;
  readonly workspaceRoot: string;
}): Promise<void> {
  const snapshotRoot = join(input.appRoot, ".eve", "dev-runtime", "snapshots", input.generationId);
  const runtimeAppRoot = join(snapshotRoot, "source", "app");

  await mkdir(join(runtimeAppRoot, ".eve", "compile"), { recursive: true });
  await writeFile(join(runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"), "{}\n");
  await writeFile(join(snapshotRoot, "activated"), "");
  await writeFile(join(snapshotRoot, "generation.json"), `${JSON.stringify({ runtimeAppRoot })}\n`);
  await writeDevelopmentRuntimeArtifactsWorker({
    entry: input.entry,
    snapshotRoot,
    workerData: {},
    workspaceRoot: input.workspaceRoot,
  });
}
