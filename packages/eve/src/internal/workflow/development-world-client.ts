import type {
  MessageId,
  QueuePrefix,
  SpecVersion,
  ValidQueueName,
  World,
} from "#compiled/@workflow/world/index.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV,
  readDevelopmentWorkerRequestMetadata,
} from "#internal/nitro/host/dev-worker-metadata.js";
import {
  decodeDevelopmentWorldJson,
  decodeDevelopmentWorldValue,
  deserializeDevelopmentWorldError,
  encodeDevelopmentWorldValue,
} from "#internal/workflow/development-world-codec.js";
import {
  getDevelopmentWorkflowGeneration,
  withDevelopmentWorkflowGeneration,
} from "#internal/workflow/development-generation-context.js";
import {
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
  type DevelopmentWorldCall,
  type DevelopmentWorldOperation,
} from "#internal/workflow/development-world-protocol.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";

export function createDevelopmentWorkflowWorld(): World {
  const call = async <T>(
    operation: DevelopmentWorldOperation,
    args: readonly unknown[] = [],
  ): Promise<T> => {
    const response = await fetchDevelopmentWorld(DEVELOPMENT_WORKFLOW_WORLD_ROUTE, {
      body: encodeDevelopmentWorldValue({
        arguments: args,
        operation,
      } satisfies DevelopmentWorldCall),
      method: "POST",
    });
    return decodeDevelopmentWorldValue(await response.text()) as T;
  };

  const world = {
    specVersion: 5 as SpecVersion,
    processExitTriggersQueueRedelivery: false,
    async getDeploymentId() {
      return (
        getDevelopmentWorkflowGeneration()?.generationId ?? (await call<string>("getDeploymentId"))
      );
    },
    async resolveLatestDeploymentId() {
      return await call<string>("resolveLatestDeploymentId");
    },
    async queue(...args: Parameters<World["queue"]>) {
      return await call<Awaited<ReturnType<World["queue"]>>>("queue", args);
    },
    createQueueHandler,
    runs: {
      get: async (...args: unknown[]) => await call("runs.get", args),
      list: async (...args: unknown[]) => await call("runs.list", args),
      experimentalSetAttributes: async (...args: unknown[]) =>
        await call("runs.experimentalSetAttributes", args),
    } as World["runs"],
    steps: {
      get: async (...args: unknown[]) => await call("steps.get", args),
      list: async (...args: unknown[]) => await call("steps.list", args),
    } as World["steps"],
    events: {
      create: async (...args: unknown[]) => await call("events.create", args),
      get: async (...args: unknown[]) => await call("events.get", args),
      list: async (...args: unknown[]) => await call("events.list", args),
      listByCorrelationId: async (...args: unknown[]) =>
        await call("events.listByCorrelationId", args),
    } as World["events"],
    hooks: {
      get: async (...args: unknown[]) => await call("hooks.get", args),
      getByToken: async (...args: unknown[]) => await call("hooks.getByToken", args),
      list: async (...args: unknown[]) => await call("hooks.list", args),
    } as World["hooks"],
    streams: {
      write: async (...args: unknown[]) => await call("streams.write", args),
      writeMulti: async (...args: unknown[]) => await call("streams.writeMulti", args),
      close: async (...args: unknown[]) => await call("streams.close", args),
      get: async (runId: string, name: string, startIndex?: number) => {
        const url = new URL(resolveDevelopmentWorldBaseUrl());
        url.pathname = DEVELOPMENT_WORKFLOW_STREAM_ROUTE;
        url.searchParams.set("runId", runId);
        url.searchParams.set("name", name);
        if (startIndex !== undefined) {
          url.searchParams.set("startIndex", String(startIndex));
        }
        const response = await fetchDevelopmentWorld(url, { method: "GET" });
        if (response.body === null) {
          throw new Error("Development Workflow stream response had no body.");
        }
        return response.body;
      },
      list: async (...args: unknown[]) => await call("streams.list", args),
      getChunks: async (...args: unknown[]) => await call("streams.getChunks", args),
      getInfo: async (...args: unknown[]) => await call("streams.getInfo", args),
    } as World["streams"],
    async start() {},
    async close() {},
  } satisfies World;

  return world;
}

function createQueueHandler(
  prefix: QueuePrefix,
  handler: (
    message: unknown,
    metadata: {
      attempt: number;
      queueName: ValidQueueName;
      messageId: MessageId;
      requestId?: string;
    },
  ) => Promise<void | { timeoutSeconds: number }>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const secret = readRequiredEnvironment(DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV);
    if (request.headers.get(DEVELOPMENT_WORKFLOW_DELIVERY_HEADER) !== secret) {
      return Response.json({ error: "Workflow delivery is not trusted." }, { status: 401 });
    }
    const queueName = request.headers.get("x-vqs-queue-name");
    const messageId = request.headers.get("x-vqs-message-id");
    const attempt = Number(request.headers.get("x-vqs-message-attempt"));
    if (
      queueName === null ||
      !queueName.startsWith(prefix) ||
      messageId === null ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      request.body === null
    ) {
      return Response.json({ error: "Workflow delivery is malformed." }, { status: 400 });
    }
    const metadata = readDevelopmentWorkerRequestMetadata(request);
    if (metadata === undefined) {
      return Response.json({ error: "Workflow delivery has no generation." }, { status: 400 });
    }
    const message = decodeDevelopmentWorldJson(await request.text());
    try {
      const result = await withDevelopmentWorkflowGeneration(
        {
          generationId: metadata.generationId,
          source: createDiskRuntimeCompiledArtifactsSource(metadata.runtimeAppRoot, {
            moduleMapLoaderPath: resolvePackageSourceFilePath(
              "src/internal/authored-module-map-loader.ts",
            ),
            sandboxAppRoot: readRequiredEnvironment(DEVELOPMENT_WORKER_APP_ROOT_ENV),
          }),
        },
        async () =>
          await handler(message, {
            attempt,
            messageId: messageId as MessageId,
            queueName: queueName as ValidQueueName,
          }),
      );
      return Response.json(
        result === undefined ? { ok: true } : { timeoutSeconds: result.timeoutSeconds },
      );
    } catch (error) {
      return Response.json(String(error), { status: 500 });
    }
  };
}

async function fetchDevelopmentWorld(route: string | URL, init: RequestInit): Promise<Response> {
  const url = route instanceof URL ? route : new URL(route, resolveDevelopmentWorldBaseUrl());
  const headers = new Headers(init.headers);
  headers.set(
    DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
    readRequiredEnvironment(DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV),
  );
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const source = await response.text();
    const error = readDevelopmentWorldError(source);
    if (error !== undefined) {
      throw error;
    }
    throw new Error(
      `Development Workflow World request failed (${String(response.status)}): ${source}`,
    );
  }
  return response;
}

function readDevelopmentWorldError(source: string): Error | undefined {
  try {
    return deserializeDevelopmentWorldError(decodeDevelopmentWorldValue(source));
  } catch {
    return undefined;
  }
}

function resolveDevelopmentWorldBaseUrl(): string {
  return readRequiredEnvironment(WORKFLOW_LOCAL_BASE_URL_ENV);
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Development Workflow transport is missing ${name}.`);
  }
  return value;
}
