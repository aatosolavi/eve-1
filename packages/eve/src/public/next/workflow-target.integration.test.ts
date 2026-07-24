import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodeNextWorkflowTargetDescriptor,
  readNextWorkflowTargetDescriptor,
  resolveNextWorkflowTargetDescriptor,
  writeNextWorkflowTargetDescriptor,
} from "./workflow-target.js";

describe("Next Workflow target descriptor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("selects allowlisted workflow IDs and the World configured by withWorkflow", async () => {
    const nextRoot = await mkdtemp(join(tmpdir(), "eve-next-workflows-"));
    const manifestDirectory = join(nextRoot, "app", ".well-known", "workflow", "v1");
    await mkdir(manifestDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(manifestDirectory, "manifest.json"),
        JSON.stringify({
          workflows: {
            "workflows/private.ts": {
              privateWorkflow: { workflowId: "workflow//private" },
            },
            "workflows/report.ts": {
              reportWorkflow: { workflowId: "workflow//report" },
            },
          },
        }),
      ),
      writeFile(
        join(manifestDirectory, "config.json"),
        JSON.stringify({
          workflows: {
            experimentalTriggers: [{ topic: "__application_wkf_workflow_*" }],
          },
        }),
      ),
    ]);

    const agentRoot = join(nextRoot, "agent");
    const descriptor = await resolveNextWorkflowTargetDescriptor({
      agentRoot,
      nextConfig: {
        env: {
          WORKFLOW_QUEUE_NAMESPACE: "application",
          WORKFLOW_TARGET_WORLD: "local",
        },
      },
      nextRoot,
      workflowBridge: ["reportWorkflow"],
    });

    expect(descriptor).toEqual({
      namespace: "application",
      nextRootFromAgentRoot: "..",
      version: 1,
      workflows: { reportWorkflow: "workflow//report" },
      worldPackage: "@workflow/world-local",
    });

    await writeNextWorkflowTargetDescriptor(
      agentRoot,
      encodeNextWorkflowTargetDescriptor(descriptor),
    );
    await expect(readNextWorkflowTargetDescriptor(agentRoot)).resolves.toEqual(descriptor);
  });
});
