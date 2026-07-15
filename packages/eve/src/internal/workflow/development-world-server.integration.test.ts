import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSandboxSession } from "#execution/sandbox/session.js";
import { createSandboxOutputObserver } from "#execution/sandbox/output-events.js";
import { bufferToStream } from "#execution/sandbox/stream-utils.js";
import { turnWorkflowReference, workflowEntryReference } from "#execution/workflow-runtime.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionLogIdKey } from "#context/keys.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { getDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
} from "#internal/workflow/development-world-codec.js";
import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";
import {
  createParentDevelopmentWorkflowWorld,
  type ParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-server.js";
import {
  LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH,
  resolveLocalWorkflowWorldDataDirectory,
} from "#internal/workflow/local-world-data-directory.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKFLOW_DELIVERY_HEADER,
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_STREAM_ROUTE,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#internal/workflow/development-world-protocol.js";
import { DEVELOPMENT_SESSION_LOG_ROUTE } from "#internal/session-logs/protocol.js";
import { resolveSessionLogDirectory, resolveSessionLogPath } from "#internal/session-logs/files.js";
import { flushDevelopmentSessionLogs } from "#internal/session-logs/client.js";
import { ensureDevelopmentSessionOutputCapture } from "#internal/session-logs/output-capture.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createStepCompletedEvent,
  createStepStartedEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

const createScratchDirectory = useTemporaryDirectories();
const SECRET = "workflow-transport-secret";
const RUN_ID = "wrun_01J00000000000000000000000";
const AGENT_NAME = "workflow-world-test";
const QUEUE_PREFIX = deriveEveWorkflowQueuePrefix(AGENT_NAME);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  delete process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  delete process.env.WORKFLOW_LOCAL_BASE_URL;
  delete process.env.EVE_SESSION_LOGS;
});

describe("parent development Workflow World", () => {
  it("stores local Workflow state under .eve/.workflow-data", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-data-dir-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      await world.start();
      await expect(
        access(join(resolveLocalWorkflowWorldDataDirectory(appRoot), "version.txt")),
      ).resolves.toBeUndefined();
      await expect(access(join(appRoot, ".workflow-data"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await world.close();
    }
  });

  it("follows committed session events with raw output in one secure session log", async () => {
    const appRoot = await createScratchDirectory("eve-parent-session-log-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);
    let runId: string;

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            allowReservedAttributes: true,
            attributes: { "$eve.type": "session" },
            deploymentId: "generation-a",
            input: new Uint8Array(),
            workflowName: workflowEntryReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 5,
        },
      ]);
      runId = readCreatedRunId(created);
      await callWorld(world, "events.create", [runId, { eventType: "run_started" }]);
      const eventStreamName = defaultSessionEventStreamName(runId);
      const writeEvent = async (event: HandleMessageStreamEvent, at: string) => {
        await callWorld(world, "streams.write", [
          runId,
          eventStreamName,
          encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event, at)),
        ]);
      };
      await writeEvent(
        createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn_1" }),
        "2026-07-15T20:00:00.000Z",
      );
      await writeEvent(
        createActionsRequestedEvent({
          actions: [
            {
              callId: "call_weather",
              input: { city: "San Francisco" },
              kind: "tool-call",
              toolName: "weather",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        }),
        "2026-07-15T20:00:00.010Z",
      );
      await writeEvent(
        createActionResultEvent({
          result: {
            callId: "call_weather",
            kind: "tool-result",
            output: { forecast: "sunny" },
            toolName: "weather",
          },
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        }),
        "2026-07-15T20:00:00.025Z",
      );
      await writeEvent(
        createStepCompletedEvent({
          finishReason: "tool-calls",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
        "2026-07-15T20:00:00.030Z",
      );
      const context = new ContextContainer();
      context.setVirtualContext(SessionLogIdKey, runId);
      ensureDevelopmentSessionOutputCapture();
      await contextStorage.run(context, async () => {
        process.stdout.write("captured process output\n");
        const sandbox = createOutputSandbox({
          exitCode: 7,
          stderr: "sandbox failure\n",
          stdout: "sandbox output\n",
        });
        await sandbox.run({ command: "diagnostic" });
      });
      await flushDevelopmentSessionLogs();
      await callWorld(world, "events.create", [
        runId,
        { eventData: { output: new Uint8Array() }, eventType: "run_completed" },
      ]);
    } finally {
      await world.close();
    }

    const path = resolveSessionLogPath(appRoot, runId!);
    const firstSource = await readFile(path, "utf8");
    expect(firstSource).toContain("type=run_created");
    expect(firstSource).toContain("type=run_started");
    expect(firstSource).toContain("queueMs=");
    expect(firstSource).toContain("type=step.started");
    expect(firstSource).toContain("type=actions.requested timeToFirstOutputMs=10");
    expect(firstSource).toContain("type=action.result durationMs=15");
    expect(firstSource).toContain("type=step.completed durationMs=30");
    expect(firstSource).toContain("call_weather");
    expect(firstSource).toContain("forecast: 'sunny'");
    expect(firstSource).toContain("[process.stdout]");
    expect(firstSource).toContain("captured process output");
    expect(firstSource).toContain("[sandbox.stdout sandbox=sbx_output]");
    expect(firstSource).toContain("sandbox output");
    expect(firstSource).toContain("[sandbox.stderr");
    expect(firstSource).toContain("sandbox failure");
    expect(firstSource).toContain("type=run_completed");
    if (process.platform !== "win32") {
      expect((await stat(resolveSessionLogDirectory(appRoot))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    const restarted = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    try {
      await restarted.start();
    } finally {
      await restarted.close();
    }
    const reconciledSource = await readFile(path, "utf8");
    expect(reconciledSource.match(/type=run_created/g)).toHaveLength(1);
    expect(reconciledSource.match(/type=run_started/g)).toHaveLength(1);
    expect(reconciledSource.match(/type=run_completed/g)).toHaveLength(1);
    expect(reconciledSource.match(/type=step.started/g)).toHaveLength(1);
    expect(reconciledSource.match(/type=action.result/g)).toHaveLength(1);
  });

  it("does not create session logs when EVE_SESSION_LOGS=0", async () => {
    const appRoot = await createScratchDirectory("eve-parent-session-log-disabled-");
    process.env.EVE_SESSION_LOGS = "0";
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    let runId: string;
    try {
      await world.start();
      runId = readCreatedRunId(
        await callWorld(world, "events.create", [
          null,
          {
            eventData: {
              allowReservedAttributes: true,
              attributes: { "$eve.type": "session" },
              deploymentId: "generation-a",
              input: new Uint8Array(),
              workflowName: workflowEntryReference.workflowId,
            },
            eventType: "run_created",
            specVersion: 5,
          },
        ]),
      );
    } finally {
      await world.close();
    }

    await expect(access(resolveSessionLogPath(appRoot, runId!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("pins a turn delivery to its recorded generation", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-world-");
    await seedGeneration(appRoot, "generation-a");
    await seedGeneration(appRoot, "generation-b");
    let activeGenerationId = "generation-a";
    const world = createWorld({ activeGenerationId: () => activeGenerationId, appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: turnWorkflowReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 5,
        },
      ]);
      const runId = readCreatedRunId(created);

      activeGenerationId = "generation-b";
      await expect(deliverToWorker({ runId })).resolves.toBe("generation-a");
    } finally {
      await world.close();
    }
  });

  it("routes the generation-neutral driver to active and rejects untrusted deliveries", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-routing-");
    await seedGeneration(appRoot, "generation-b");
    const world = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      await expect(
        deliverToWorker({
          runId: RUN_ID,
          runInput: {
            deploymentId: "generation-a",
            input: new Uint8Array(),
            specVersion: 5,
            workflowName: workflowEntryReference.workflowId,
          },
        }),
      ).resolves.toBe("generation-b");

      const untrusted = await createWorkerQueueHandler()(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId: RUN_ID }),
          headers: deliveryHeaders({ secret: "forged" }),
          method: "POST",
        }),
      );
      expect(untrusted.status).toBe(401);
    } finally {
      await world.close();
    }
  });

  it("quarantines runs referencing missing generations without refusing to boot", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-missing-generation-");
    await seedGeneration(appRoot, "generation-a");
    const first = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    await first.start();
    await callWorld(first, "events.create", [
      null,
      {
        eventData: {
          deploymentId: "generation-a",
          executionContext: {},
          input: new Uint8Array(),
          workflowName: turnWorkflowReference.workflowId,
        },
        eventType: "run_created",
        specVersion: 5,
      },
    ]);
    await first.close();
    await rm(join(appRoot, ".eve", "dev-runtime", "snapshots", "generation-a"), {
      force: true,
      recursive: true,
    });

    const restarted = createWorld({ activeGenerationId: () => "generation-b", appRoot });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // One poisoned run must not take the app's other active runs down:
      // boot proceeds, the poisoned run's deliveries are quarantined, and
      // the failure is reported explicitly.
      await expect(restarted.start()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("generation-a"));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH),
      );
    } finally {
      errorSpy.mockRestore();
      await restarted.close();
    }
  });

  it("acknowledges and drops a delivery whose generation is permanently missing", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-dropped-delivery-");
    await seedGeneration(appRoot, "generation-a");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: turnWorkflowReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 5,
        },
      ]);
      const runId = readCreatedRunId(created);
      await rm(join(appRoot, ".eve", "dev-runtime", "snapshots", "generation-a"), {
        force: true,
        recursive: true,
      });

      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const response = await handler(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId }),
          headers: deliveryHeaders({}),
          method: "POST",
        }),
      );

      // A missing generation never heals on retry: the delivery is
      // acknowledged so the queue stops redelivering, and the handler
      // never runs.
      expect(response.status).toBe(200);
      expect(handled).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("generation-a"));
    } finally {
      errorSpy.mockRestore();
      await world.close();
    }
  });

  it("retries a delivery when generation metadata is temporarily unreadable", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-retry-delivery-");
    await seedGeneration(appRoot, "generation-a");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });
    connectWorkerToWorld(world, appRoot);

    try {
      await world.start();
      const created = await callWorld(world, "events.create", [
        null,
        {
          eventData: {
            deploymentId: "generation-a",
            executionContext: {},
            input: new Uint8Array(),
            workflowName: turnWorkflowReference.workflowId,
          },
          eventType: "run_created",
          specVersion: 5,
        },
      ]);
      const runId = readCreatedRunId(created);
      const metadataPath = join(
        appRoot,
        ".eve",
        "dev-runtime",
        "snapshots",
        "generation-a",
        "generation.json",
      );
      await rm(metadataPath);
      await mkdir(metadataPath);

      const handled = vi.fn(async () => undefined);
      const handler = createDevelopmentWorkflowWorld().createQueueHandler(QUEUE_PREFIX, handled);
      const createDelivery = () =>
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({ runId }),
          headers: deliveryHeaders({}),
          method: "POST",
        });

      const failed = await handler(createDelivery());
      expect(failed.status).toBe(500);
      expect(handled).not.toHaveBeenCalled();

      await rm(metadataPath, { recursive: true });
      await seedGeneration(appRoot, "generation-a");
      const retried = await handler(createDelivery());
      expect(retried.status).toBe(200);
      expect(handled).toHaveBeenCalledOnce();
    } finally {
      await world.close();
    }
  });

  it("rejects untrusted World, stream, and session-log requests", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-untrusted-");
    const world = createWorld({ activeGenerationId: () => "generation-a", appRoot });

    try {
      const missingHeader = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
          body: encodeDevelopmentWorldValue({ arguments: [], operation: "runs.list" }),
          method: "POST",
        }),
      );
      expect(missingHeader?.status).toBe(401);

      const forgedHeader = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
          body: encodeDevelopmentWorldValue({ arguments: [], operation: "runs.list" }),
          headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: "forged" },
          method: "POST",
        }),
      );
      expect(forgedHeader?.status).toBe(401);

      const stream = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_WORKFLOW_STREAM_ROUTE}?runId=r&name=n`),
      );
      expect(stream?.status).toBe(401);

      const sessionLog = await world.handleRequest(
        new Request(`http://localhost${DEVELOPMENT_SESSION_LOG_ROUTE}`, {
          body: encodeDevelopmentWorldValue({}),
          method: "POST",
        }),
      );
      expect(sessionLog?.status).toBe(401);
    } finally {
      await world.close();
    }
  });

  it("refuses a transport secret too short to be trusted", () => {
    expect(() =>
      createParentDevelopmentWorkflowWorld({
        agentName: AGENT_NAME,
        appRoot: "/tmp/eve-test",
        resolveActiveGenerationId: () => "generation-a",
        transportSecret: "",
      }),
    ).toThrow("too short");
  });
});

/**
 * Wires the worker-side world client to the parent world in memory: the
 * client's fetches route straight into `world.handleRequest`, standing in for
 * the parent listener without binding a port.
 */
function connectWorkerToWorld(world: ParentDevelopmentWorkflowWorld, appRoot: string): void {
  process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = SECRET;
  process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;
  process.env.WORKFLOW_LOCAL_BASE_URL = "http://eve-dev.local";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await world.handleRequest(request);
    if (response === undefined) {
      throw new Error(`Unexpected fetch during test: ${request.url}`);
    }
    return response;
  }) as typeof fetch;
}

function createWorkerQueueHandler(): (request: Request) => Promise<Response> {
  const worker = createDevelopmentWorkflowWorld();
  const handler = worker.createQueueHandler(QUEUE_PREFIX, async () => undefined);
  return handler;
}

/**
 * Runs one queue delivery through the worker-side handler and reports the
 * generation the handler executed under.
 */
async function deliverToWorker(payload: unknown): Promise<string | undefined> {
  const worker = createDevelopmentWorkflowWorld();
  let observedGenerationId: string | undefined;
  const handler = worker.createQueueHandler(QUEUE_PREFIX, async () => {
    observedGenerationId = getDevelopmentWorkflowGeneration()?.generationId;
  });
  const response = await handler(
    new Request("http://localhost/.well-known/workflow/v1/flow", {
      body: JSON.stringify(payload),
      headers: deliveryHeaders({}),
      method: "POST",
    }),
  );
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return observedGenerationId;
}

function deliveryHeaders(input: { readonly secret?: string }): Record<string, string> {
  return {
    [DEVELOPMENT_WORKFLOW_DELIVERY_HEADER]: input.secret ?? SECRET,
    "x-vqs-message-attempt": "1",
    "x-vqs-message-id": "msg_test",
    "x-vqs-queue-name": `${QUEUE_PREFIX}${turnWorkflowReference.workflowId}`,
  };
}

async function seedGeneration(appRoot: string, generationId: string): Promise<void> {
  const snapshotRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", generationId);
  const runtimeAppRoot = join(snapshotRoot, "source", "app");
  await mkdir(runtimeAppRoot, { recursive: true });
  await writeFile(join(snapshotRoot, "generation.json"), `${JSON.stringify({ runtimeAppRoot })}\n`);
}

function readCreatedRunId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof value.run === "object" &&
    value.run !== null &&
    "runId" in value.run &&
    typeof value.run.runId === "string"
  ) {
    return value.run.runId;
  }
  throw new Error("Workflow World did not return the created run ID.");
}

function defaultSessionEventStreamName(runId: string): string {
  return `strm_${runId.slice("wrun_".length)}_user`;
}

function createOutputSandbox(input: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}) {
  return buildSandboxSession({
    id: "sbx_output",
    async readFile() {
      return null;
    },
    async removePath() {},
    resolvePath(path) {
      return path;
    },
    async spawn() {
      const observer = createSandboxOutputObserver("sbx_output");
      observer.write("stdout", Buffer.from(input.stdout));
      observer.write("stderr", Buffer.from(input.stderr));
      observer.close("stdout");
      observer.close("stderr");
      return {
        async kill() {},
        stderr: bufferToStream(Buffer.from(input.stderr)),
        stdout: bufferToStream(Buffer.from(input.stdout)),
        async wait() {
          return { exitCode: input.exitCode };
        },
      };
    },
    async writeFile() {},
  });
}

function createWorld(input: {
  readonly activeGenerationId: () => string;
  readonly appRoot: string;
}): ParentDevelopmentWorkflowWorld {
  return createParentDevelopmentWorkflowWorld({
    agentName: AGENT_NAME,
    appRoot: input.appRoot,
    resolveActiveGenerationId: input.activeGenerationId,
    transportSecret: SECRET,
  });
}

async function callWorld(
  world: ParentDevelopmentWorkflowWorld,
  operation: string,
  args: readonly unknown[],
): Promise<unknown> {
  const response = await world.handleRequest(
    new Request(`http://localhost${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}`, {
      body: encodeDevelopmentWorldValue({ arguments: args, operation }),
      headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: SECRET },
      method: "POST",
    }),
  );
  expect(response).toBeDefined();
  const body = await response!.text();
  expect(response!.status, body).toBe(200);
  return decodeDevelopmentWorldValue(body);
}
