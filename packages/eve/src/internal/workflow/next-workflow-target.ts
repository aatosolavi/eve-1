import type { World } from "#compiled/@workflow/world/index.js";
import { start } from "#internal/workflow/runtime.js";

const TARGET_QUEUE_NAMESPACE = "evetarget";
const targetSymbol = Symbol.for("eve.next.workflow-target");

interface InstalledNextWorkflowTarget {
  readonly namespace?: string;
  readonly workflows: Readonly<Record<string, string>>;
  readonly world: World;
}

interface GlobalWithTarget {
  [targetSymbol]?: InstalledNextWorkflowTarget;
}

function rewriteQueueName(queueName: string, namespace: string | undefined): string {
  const match = /^__(?:[a-z][a-z0-9]*_)?wkf_(workflow|step)_(.+)$/.exec(queueName);
  if (match === null) return queueName;
  const prefix = namespace === undefined ? "__wkf_" : `__${namespace}_wkf_`;
  return `${prefix}${match[1]}_${match[2]}`;
}

function createDispatchWorld(world: World, namespace: string | undefined): World {
  return new Proxy(world, {
    get(target, property, receiver) {
      if (property !== "queue") return Reflect.get(target, property, receiver) as unknown;
      return ((queueName, message, options) =>
        target.queue(
          rewriteQueueName(queueName, namespace),
          message,
          options,
        )) satisfies World["queue"];
    },
  });
}

/** Installs the Next-owned Workflow target available to authored eve tools. */
export function installNextWorkflowTarget(input: InstalledNextWorkflowTarget): void {
  const globalWithTarget = globalThis as GlobalWithTarget;
  globalWithTarget[targetSymbol] = {
    ...input,
    world: createDispatchWorld(input.world, input.namespace),
  };
}

/** Handle returned after a Next-owned Workflow run is durably started. */
export interface NextWorkflowRunHandle {
  readonly runId: string;
  readonly workflow: string;
}

/** Starts an allowlisted Next-owned Workflow through its configured Workflow World. */
export async function startNextWorkflow(
  workflow: string,
  args: readonly unknown[] = [],
): Promise<NextWorkflowRunHandle> {
  const target = (globalThis as GlobalWithTarget)[targetSymbol];
  if (target === undefined) {
    throw new Error(
      "No Next.js Workflow target is configured. Add workflowBridge to withEve(withWorkflow(...)).",
    );
  }

  const workflowId = target.workflows[workflow];
  if (workflowId === undefined) {
    throw new Error(`Next.js Workflow ${JSON.stringify(workflow)} is not allowlisted.`);
  }

  const run = await start({ workflowId }, [...args], {
    namespace: target.namespace ?? TARGET_QUEUE_NAMESPACE,
    world: target.world,
  });
  return { runId: run.runId, workflow };
}
