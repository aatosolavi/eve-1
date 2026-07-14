import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { turnWorkflowReference, workflowEntryReference } from "#execution/workflow-runtime.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
} from "#internal/workflow/development-world-codec.js";
import {
  createParentDevelopmentWorkflowWorld,
  type ParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-server.js";
import {
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
  DEVELOPMENT_WORKFLOW_WORLD_ROUTE,
} from "#internal/workflow/development-world-protocol.js";

const createScratchDirectory = useTemporaryDirectories();
const SECRET = "workflow-transport-secret";
const RUN_ID = "wrun_01J00000000000000000000000";

describe("parent development Workflow World", () => {
  it("pins a child run to its recorded generation until it becomes terminal", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-world-");
    await mkdir(join(appRoot, ".workflow-data"), { recursive: true });
    let activeGenerationId = "generation-a";
    const dispatchedGenerations: string[] = [];
    const world = createWorld({
      activeGenerationId: () => activeGenerationId,
      appRoot,
      dispatch: async (_request, generationId) => {
        dispatchedGenerations.push(generationId);
        return Response.json({ ok: true });
      },
      hasGeneration: (generationId) =>
        generationId === "generation-a" || generationId === "generation-b",
    });

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
      await deliver(world, { runId });
      expect(dispatchedGenerations).toEqual(["generation-a"]);
      await expect(world.collectGenerationReferences()).resolves.toEqual({
        generationIds: new Set(["generation-a"]),
        protectAll: false,
      });

      await callWorld(world, "events.create", [
        runId,
        {
          eventData: { result: new Uint8Array() },
          eventType: "run_completed",
          specVersion: 5,
        },
      ]);
      await expect(world.collectGenerationReferences()).resolves.toEqual({
        generationIds: new Set(),
        protectAll: false,
      });
    } finally {
      await world.close();
    }
  });

  it("routes the generation-neutral driver to active and rejects public queue spoofing", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-routing-");
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const world = createWorld({
      activeGenerationId: () => "generation-b",
      appRoot,
      dispatch,
      hasGeneration: () => true,
    });

    try {
      await world.start();
      await deliver(world, {
        runId: RUN_ID,
        runInput: {
          deploymentId: "generation-a",
          input: new Uint8Array(),
          specVersion: 5,
          workflowName: workflowEntryReference.workflowId,
        },
      });
      expect(dispatch).toHaveBeenCalledWith(expect.any(Request), "generation-b");

      const response = await world.handleRequest(
        new Request("http://localhost/.well-known/workflow/v1/flow", {
          body: JSON.stringify({
            runId: RUN_ID,
            runInput: {
              deploymentId: "generation-a",
              workflowName: turnWorkflowReference.workflowId,
            },
          }),
          method: "POST",
        }),
      );
      expect(response?.status).toBe(401);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await world.close();
    }
  });

  it("fails startup when a nonterminal turn references a missing generation", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-missing-generation-");
    const first = createWorld({
      activeGenerationId: () => "generation-a",
      appRoot,
      dispatch: async () => Response.json({ ok: true }),
      hasGeneration: () => true,
    });
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

    const restarted = createWorld({
      activeGenerationId: () => "generation-b",
      appRoot,
      dispatch: async () => Response.json({ ok: true }),
      hasGeneration: () => false,
    });
    try {
      await expect(restarted.start()).rejects.toThrow(
        'Workflow run references missing development generation "generation-a".',
      );
    } finally {
      await restarted.close();
    }
  });

  it("protects all generations when a persisted run record is unreadable", async () => {
    const appRoot = await createScratchDirectory("eve-parent-workflow-unreadable-run-");
    await mkdir(join(appRoot, ".workflow-data", "runs"), { recursive: true });
    await writeFile(join(appRoot, ".workflow-data", "runs", "unreadable.json"), "{");
    const world = createWorld({
      activeGenerationId: () => "generation-a",
      appRoot,
      dispatch: async () => Response.json({ ok: true }),
      hasGeneration: () => true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(world.collectGenerationReferences()).resolves.toEqual({
        generationIds: new Set(),
        protectAll: true,
      });
    } finally {
      warn.mockRestore();
      await world.close();
    }
  });
});

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

function createWorld(input: {
  readonly activeGenerationId: () => string;
  readonly appRoot: string;
  readonly dispatch: (request: Request, generationId: string) => Promise<Response>;
  readonly hasGeneration: (generationId: string) => boolean;
}): ParentDevelopmentWorkflowWorld {
  return createParentDevelopmentWorkflowWorld({
    agentName: "workflow-world-test",
    appRoot: input.appRoot,
    dispatch: input.dispatch,
    hasGeneration: input.hasGeneration,
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

async function deliver(world: ParentDevelopmentWorkflowWorld, payload: unknown): Promise<void> {
  const response = await world.handleRequest(
    new Request("http://localhost/.well-known/workflow/v1/flow", {
      body: JSON.stringify(payload),
      headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: SECRET },
      method: "POST",
    }),
  );
  expect(response?.status).toBe(200);
}
