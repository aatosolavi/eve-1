import { afterEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
vi.mock("#internal/workflow/runtime.js", () => ({
  start: (...args: unknown[]) => startMock(...args),
}));

import { installNextWorkflowTarget, startNextWorkflow } from "./next-workflow-target.js";

const targetSymbol = Symbol.for("eve.next.workflow-target");

describe("Next Workflow target", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, targetSymbol);
    startMock.mockReset();
  });

  it("starts allowlisted metadata through the explicit target World", async () => {
    const queue = vi.fn();
    const world = { queue };
    startMock.mockImplementation(async (_metadata, _args, options) => {
      await options.world.queue("__evetarget_wkf_workflow_workflow-id", {}, {});
      return { runId: "wrun_123" };
    });
    installNextWorkflowTarget({
      workflows: { reportWorkflow: "workflow//./workflows/report//reportWorkflow" },
      world: world as never,
    });

    await expect(startNextWorkflow("reportWorkflow", ["quarterly revenue"])).resolves.toEqual({
      runId: "wrun_123",
      workflow: "reportWorkflow",
    });
    expect(startMock).toHaveBeenCalledWith(
      { workflowId: "workflow//./workflows/report//reportWorkflow" },
      ["quarterly revenue"],
      expect.objectContaining({ namespace: "evetarget" }),
    );
    expect(queue).toHaveBeenCalledWith("__wkf_workflow_workflow-id", {}, {});
  });

  it("rejects a workflow outside the allowlist", async () => {
    installNextWorkflowTarget({ workflows: {}, world: { queue: vi.fn() } as never });
    await expect(startNextWorkflow("privateWorkflow")).rejects.toThrow("not allowlisted");
  });
});
