import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { DevelopmentWorkerHttpServer } from "#internal/nitro/host/dev-worker-http-server.js";
import { DevelopmentWorkflowDispatcher } from "#internal/nitro/host/development-workflow-dispatch.js";
import { isRestorableDevelopmentWorker } from "#internal/nitro/host/development-worker-recovery.js";
import {
  pruneDevelopmentRuntimeArtifactsSnapshots,
  readActivatedDevelopmentRuntimeArtifactGenerations,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { copyDevelopmentRuntimeArtifactsWorker } from "#internal/nitro/dev-runtime-worker-artifacts.js";
import type {
  DevelopmentWorkerCandidate,
  DevelopmentWorkerGeneration,
  DevelopmentWorkerListener,
  DevelopmentWorkerPublication,
  DevelopmentWorkerRunner,
  DevelopmentWorkerRunnerFactory,
  DevelopmentWorkerServer,
  DevelopmentWorkerSlot,
  DevelopmentWorkflowWorldOwnership,
} from "#internal/nitro/host/dev-worker-server-types.js";
import {
  createParentDevelopmentWorkflowWorld,
  type DevelopmentWorkflowGenerationReferences,
  type ParentDevelopmentWorkflowWorld,
} from "#internal/workflow/development-world-server.js";
import { toErrorMessage } from "#shared/errors.js";

const DEVELOPMENT_WORKER_READY_TIMEOUT_MS = 60_000;

interface RequestLease {
  readonly generation: DevelopmentWorkerGeneration;
  release(): void;
  readonly slot: DevelopmentWorkerSlot;
}

export function createDevelopmentWorkerServer(input: {
  readonly appRoot: string;
  readonly createRunner: DevelopmentWorkerRunnerFactory;
  readonly resolveAdmissionGeneration: (
    workerGeneration: DevelopmentWorkerGeneration,
  ) => DevelopmentWorkerGeneration;
  readonly workflowWorld: DevelopmentWorkflowWorldOwnership;
}): DevelopmentWorkerServer {
  return new ParentDevelopmentWorkerServer(input);
}

class ParentDevelopmentWorkerServer implements DevelopmentWorkerServer {
  readonly #activeWaiters = new Set<() => void>();
  readonly #appRoot: string;
  readonly #createRunner: DevelopmentWorkerRunnerFactory;
  readonly #generationRegistry = new Map<string, DevelopmentWorkerGeneration>();
  readonly #generationSlots = new Map<string, DevelopmentWorkerSlot>();
  readonly #httpServer: DevelopmentWorkerHttpServer;
  readonly #leasedGenerations = new Map<string, number>();
  readonly #parentOwnsWorkflowWorld: boolean;
  readonly #resolveAdmissionGeneration: (
    workerGeneration: DevelopmentWorkerGeneration,
  ) => DevelopmentWorkerGeneration;
  readonly #slots = new Set<DevelopmentWorkerSlot>();
  readonly #transportSecret = randomBytes(32).toString("base64url");
  readonly #workflowDispatcher: DevelopmentWorkflowDispatcher;
  readonly #workflowWorld: ParentDevelopmentWorkflowWorld;
  #accepting = true;
  #activeSlot: DevelopmentWorkerSlot | undefined;
  #closePromise: Promise<void> | undefined;
  #controlHandler: ((request: Request) => Promise<Response | undefined>) | undefined;
  #promotion: Promise<void> = Promise.resolve();
  #prunePromise: Promise<void> | undefined;
  #pruneRequested = false;
  #workerCounter = 0;

  constructor(input: {
    readonly appRoot: string;
    readonly createRunner: DevelopmentWorkerRunnerFactory;
    readonly resolveAdmissionGeneration: (
      workerGeneration: DevelopmentWorkerGeneration,
    ) => DevelopmentWorkerGeneration;
    readonly workflowWorld: DevelopmentWorkflowWorldOwnership;
  }) {
    this.#appRoot = input.appRoot;
    this.#createRunner = input.createRunner;
    this.#parentOwnsWorkflowWorld = input.workflowWorld.kind === "parent-local";
    this.#resolveAdmissionGeneration = input.resolveAdmissionGeneration;
    this.#workflowDispatcher = new DevelopmentWorkflowDispatcher({
      admit: async (generationId) => {
        const lease = await this.#admitWorkflowGeneration(generationId);
        return {
          generation: lease.generation,
          release: lease.release,
          runner: lease.slot.runner,
        };
      },
      onRelease: () => this.#pruneInBackground(),
      transportSecret: this.#transportSecret,
    });
    this.#workflowWorld = this.#createWorkflowWorld(input.workflowWorld);
    this.#httpServer = new DevelopmentWorkerHttpServer({
      admit: async () => {
        const lease = await this.#admit();
        return {
          generation: lease.generation,
          release: lease.release,
          runner: lease.slot.runner,
        };
      },
      handleParentRequest: async (request) => {
        const workflowResponse = await this.#workflowWorld.handleRequest(request);
        return workflowResponse ?? (await this.#controlHandler?.(request));
      },
      transportSecret: this.#transportSecret,
    });
  }

  #createWorkflowWorld(
    ownership: DevelopmentWorkflowWorldOwnership,
  ): ParentDevelopmentWorkflowWorld {
    if (ownership.kind === "worker-configured") {
      return createWorkerOwnedDevelopmentWorkflowWorld();
    }
    return createParentDevelopmentWorkflowWorld({
      agentName: ownership.agentName,
      appRoot: this.#appRoot,
      dispatch: async (request, generationId) =>
        await this.#workflowDispatcher.dispatch(request, generationId),
      hasGeneration: (generationId) => this.#hasGeneration(generationId),
      resolveActiveGenerationId: () => this.#readActiveGeneration().id,
      transportSecret: this.#transportSecret,
    });
  }

  async startWorkflowWorld(): Promise<void> {
    const generations = await readActivatedDevelopmentRuntimeArtifactGenerations(this.#appRoot);
    for (const generation of generations) {
      this.#generationRegistry.set(generation.id, generation);
    }
    if (this.#parentOwnsWorkflowWorld) {
      const references = await this.#workflowWorld.collectGenerationReferences();
      if (!references.protectAll) {
        // Runtime-only generations shared one worker before the restart, so
        // restore one slot per persisted workspace. Restoring per generation
        // would give several slots ownership of the same workspace, and the
        // first one to close would remove it under the others.
        const restoredSlotsByWorkspace = new Map<string, DevelopmentWorkerSlot>();
        for (const generationId of references.generationIds) {
          if (this.#generationSlots.has(generationId)) {
            continue;
          }
          const generation = generations.find((candidate) => candidate.id === generationId);
          if (generation === undefined) {
            throw new Error(
              `Workflow run references missing development generation "${generationId}". ` +
                `Remove ".workflow-data" to discard the app's active local Workflow runs.`,
            );
          }
          const worker = generation.worker;
          if (!isRestorableDevelopmentWorker(worker, this.#appRoot)) {
            throw new Error(
              `Workflow run references development generation "${generationId}" without a restorable worker. ` +
                `Remove ".workflow-data" to discard the app's active local Workflow runs.`,
            );
          }
          const workspaceKey = `${worker.entry}\0${worker.workspaceRoot}`;
          const restoredSlot = restoredSlotsByWorkspace.get(workspaceKey);
          if (restoredSlot !== undefined) {
            this.#recordGeneration(generation, restoredSlot);
            continue;
          }
          const candidate = await this.prepareCandidate({
            dispose: async () => await rm(worker.workspaceRoot, { force: true, recursive: true }),
            entry: worker.entry,
            generation,
            workerData: worker.workerData,
          });
          candidate.slot.state = "retired";
          this.#recordGeneration(generation, candidate.slot);
          restoredSlotsByWorkspace.set(workspaceKey, candidate.slot);
        }
      }
    }
    await this.#workflowWorld.start();
    this.#pruneInBackground();
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#controlHandler = handler;
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener {
    if (!this.#accepting) {
      throw new Error("Development worker server is closed.");
    }
    return this.#httpServer.listen(input);
  }

  async prepareCandidate(input: {
    readonly dispose: () => Promise<void>;
    readonly entry: string;
    readonly generation: DevelopmentWorkerGeneration;
    readonly workerData: Readonly<Record<string, unknown>>;
  }): Promise<DevelopmentWorkerCandidate> {
    if (!this.#accepting) {
      throw new Error("Development worker server is closed.");
    }

    let slot: DevelopmentWorkerSlot | undefined;
    const workerNumber = this.#workerCounter++;
    let runner: DevelopmentWorkerRunner;
    try {
      runner = this.#createRunner({
        appRoot: this.#appRoot,
        entry: input.entry,
        name: `eve-dev-${String(workerNumber)}`,
        onClose: (cause) => {
          if (slot !== undefined) {
            void this.#handleWorkerClose(slot, cause);
          }
        },
        transportSecret: this.#transportSecret,
        workerData: input.workerData,
      });
    } catch (error) {
      try {
        await input.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          "Development worker creation and host cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
    slot = {
      dispose: input.dispose,
      disposed: false,
      entry: input.entry,
      generation: input.generation,
      leases: 0,
      runner,
      state: "candidate",
      workerData: input.workerData,
    };
    this.#slots.add(slot);

    try {
      await runner.waitForReady(DEVELOPMENT_WORKER_READY_TIMEOUT_MS);
    } catch (error) {
      await this.#closeSlot(slot, error);
      throw error;
    }

    if (!this.#accepting) {
      await this.#closeSlot(slot);
      throw new Error("Development worker server closed before candidate readiness.");
    }

    return { slot };
  }

  async promote(candidate: DevelopmentWorkerCandidate): Promise<void> {
    const previousSlot = await this.#gateAdmission(async () => this.#swapCandidate(candidate));
    this.#recordGeneration(candidate.slot.generation, candidate.slot);
    await this.#closeRetiredSlotWithoutFailingCommit(previousSlot);
    this.#pruneInBackground();
  }

  async publishRuntimeGeneration(input: {
    readonly generation: DevelopmentWorkerGeneration;
    readonly publish: () => Promise<DevelopmentWorkerPublication>;
  }): Promise<void> {
    await this.#gateAdmission(async () => {
      const slot = this.#activeSlot;
      if (slot === undefined) {
        throw new Error("Development worker is unavailable for runtime publication.");
      }
      await copyDevelopmentRuntimeArtifactsWorker({
        sourceSnapshotRoot: slot.generation.snapshotRoot,
        targetSnapshotRoot: input.generation.snapshotRoot,
      });
      const publication = await input.publish();
      publication.commit();
      this.#recordGeneration(input.generation, slot);
    });
    this.#pruneInBackground();
  }

  async publishStructuralCandidate(input: {
    readonly candidate: DevelopmentWorkerCandidate;
    readonly publish: () => Promise<DevelopmentWorkerPublication>;
  }): Promise<void> {
    const previousSlot = await this.#gateAdmission(async () => {
      this.#validateCandidate(input.candidate);
      const publication = await input.publish();
      try {
        const slot = this.#swapCandidate(input.candidate);
        publication.commit();
        this.#recordGeneration(input.candidate.slot.generation, input.candidate.slot);
        return slot;
      } catch (error) {
        try {
          await publication.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Development worker publication rollback failed.",
            { cause: error },
          );
        }
        throw error;
      }
    });
    await this.#closeRetiredSlotWithoutFailingCommit(previousSlot);
    this.#pruneInBackground();
  }

  async #gateAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previousPromotion = this.#promotion;
    let finishPromotion: (() => void) | undefined;
    this.#promotion = new Promise<void>((resolve) => {
      finishPromotion = resolve;
    });

    await previousPromotion;
    try {
      if (!this.#accepting) {
        throw new Error("Development worker server is closed.");
      }
      return await operation();
    } finally {
      finishPromotion?.();
    }
  }

  #validateCandidate(candidate: DevelopmentWorkerCandidate): void {
    if (candidate.slot.state !== "candidate" || candidate.slot.runner.closed) {
      throw new Error("Development worker candidate is not ready for promotion.");
    }
  }

  #swapCandidate(candidate: DevelopmentWorkerCandidate): DevelopmentWorkerSlot | undefined {
    this.#validateCandidate(candidate);
    const previousSlot = this.#activeSlot;
    candidate.slot.state = "active";
    this.#activeSlot = candidate.slot;
    this.#wakeActiveWaiters();

    if (previousSlot !== undefined && previousSlot !== candidate.slot) {
      previousSlot.state = "retired";
    }

    return previousSlot;
  }

  async discardCandidate(candidate: DevelopmentWorkerCandidate): Promise<void> {
    if (candidate.slot.state !== "candidate") {
      throw new Error("Only an unpromoted development worker candidate can be discarded.");
    }
    await this.#closeSlot(candidate.slot);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#accepting = false;
    this.#wakeActiveWaiters();

    this.#workflowDispatcher.close();
    await this.#httpServer.close(async () => {
      await this.#prunePromise;
      const workflowReferences = this.#parentOwnsWorkflowWorld
        ? await this.#workflowWorld.collectGenerationReferences()
        : undefined;
      await Promise.all([
        ...[...this.#slots].map(async (slot) => {
          if (
            workflowReferences !== undefined &&
            (workflowReferences.protectAll ||
              this.#readSlotGenerationIds(slot).some((generationId) =>
                workflowReferences.generationIds.has(generationId),
              ))
          ) {
            await this.#stopSlotPreservingWorkspace(slot);
            return;
          }
          await this.#closeSlot(slot);
        }),
        this.#workflowWorld.close(),
      ]);
    });
  }

  async #admit(): Promise<RequestLease> {
    await this.#promotion;
    while (this.#accepting && this.#activeSlot === undefined) {
      await new Promise<void>((resolve) => this.#activeWaiters.add(resolve));
      await this.#promotion;
    }

    const slot = this.#activeSlot;
    if (!this.#accepting || slot === undefined || slot.state !== "active") {
      throw new Error("Development worker is unavailable.");
    }

    const generation = this.#resolveAdmissionGeneration(slot.generation);
    return this.#createLease(slot, generation);
  }

  #createLease(slot: DevelopmentWorkerSlot, generation: DevelopmentWorkerGeneration): RequestLease {
    slot.leases += 1;
    this.#leasedGenerations.set(
      generation.id,
      (this.#leasedGenerations.get(generation.id) ?? 0) + 1,
    );
    let released = false;
    return {
      generation,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        slot.leases -= 1;
        const generationLeases = (this.#leasedGenerations.get(generation.id) ?? 1) - 1;
        if (generationLeases === 0) {
          this.#leasedGenerations.delete(generation.id);
        } else {
          this.#leasedGenerations.set(generation.id, generationLeases);
        }
        void this.#closeRetiredSlot(slot).catch((error) => {
          console.error(`[eve:dev] failed to close retired worker: ${toErrorMessage(error)}`);
        });
      },
      slot,
    };
  }

  async #admitWorkflowGeneration(generationId: string): Promise<RequestLease> {
    await this.#promotion;
    const generation = this.#generationRegistry.get(generationId);
    const slot = this.#generationSlots.get(generationId);
    if (
      !this.#accepting ||
      slot === undefined ||
      (slot.state !== "active" && slot.state !== "retired")
    ) {
      throw new Error("Development worker is unavailable for Workflow delivery.");
    }
    if (generation === undefined) {
      throw new Error(`Workflow run references missing development generation "${generationId}".`);
    }
    return this.#createLease(slot, generation);
  }

  #recordGeneration(generation: DevelopmentWorkerGeneration, slot: DevelopmentWorkerSlot): void {
    this.#generationRegistry.set(generation.id, generation);
    this.#generationSlots.set(generation.id, slot);
  }

  #readActiveGeneration(): DevelopmentWorkerGeneration {
    const slot = this.#activeSlot;
    if (slot === undefined) {
      throw new Error("Development runtime generation is unavailable.");
    }
    return this.#resolveAdmissionGeneration(slot.generation);
  }

  #hasGeneration(generationId: string): boolean {
    const generation = this.#generationRegistry.get(generationId);
    return generation !== undefined && existsSync(generation.runtimeAppRoot);
  }

  #pruneInBackground(): void {
    if (!this.#accepting) {
      return;
    }
    this.#pruneRequested = true;
    if (this.#prunePromise !== undefined) {
      return;
    }
    this.#prunePromise = this.#runScheduledPruning().finally(() => {
      this.#prunePromise = undefined;
      if (this.#pruneRequested) {
        this.#pruneInBackground();
      }
    });
  }

  async #runScheduledPruning(): Promise<void> {
    while (this.#accepting && this.#pruneRequested) {
      this.#pruneRequested = false;
      await this.#prune().catch((error) => {
        console.error(`[eve:dev] failed to prune runtime generations: ${toErrorMessage(error)}`);
      });
    }
  }

  async #prune(): Promise<void> {
    const workflowReferences = await this.#workflowWorld.collectGenerationReferences();
    await Promise.all(
      [...this.#slots].map(async (slot) => await this.#closeRetiredSlot(slot, workflowReferences)),
    );
    const protectedGenerationIds = new Set(this.#leasedGenerations.keys());
    for (const slot of this.#slots) {
      protectedGenerationIds.add(slot.generation.id);
    }
    for (const generationId of workflowReferences.generationIds) {
      protectedGenerationIds.add(generationId);
    }
    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot: this.#appRoot,
      protectAll: workflowReferences.protectAll,
      protectedGenerationIds,
    });
    for (const [generationId, generation] of this.#generationRegistry) {
      if (!protectedGenerationIds.has(generationId) && !existsSync(generation.runtimeAppRoot)) {
        this.#generationRegistry.delete(generationId);
      }
    }
  }

  async #handleWorkerClose(slot: DevelopmentWorkerSlot, cause: unknown): Promise<void> {
    const wasActive = slot.state === "active" && this.#activeSlot === slot;
    const wasRetired = slot.state === "retired";
    if ((!wasActive && !wasRetired) || !this.#accepting) {
      return;
    }

    const generationIds = this.#readSlotGenerationIds(slot);
    slot.state = "closed";
    this.#slots.delete(slot);
    this.#removeSlotGenerationMappings(slot);
    if (wasActive) {
      this.#activeSlot = undefined;
    }
    this.#workflowDispatcher.cancelRunnerExchanges(slot.runner);
    this.#httpServer.cancelRunnerExchanges(slot.runner);

    try {
      if (wasRetired && !(await this.#isSlotProtected(generationIds))) {
        await this.#disposeSlot(slot);
        return;
      }
      slot.disposed = true;
      const candidate = await this.prepareCandidate({
        dispose: slot.dispose,
        entry: slot.entry,
        generation: slot.generation,
        workerData: slot.workerData,
      });
      if (wasActive) {
        await this.promote(candidate);
      } else {
        candidate.slot.state = "retired";
      }
      for (const generationId of generationIds) {
        const generation = this.#generationRegistry.get(generationId);
        if (generation !== undefined) {
          this.#generationSlots.set(generationId, candidate.slot);
        }
      }
    } catch (error) {
      console.error(
        `[eve:dev] worker restart failed after ${toErrorMessage(cause)}: ${toErrorMessage(error)}`,
      );
    }
  }

  async #closeRetiredSlot(
    slot: DevelopmentWorkerSlot,
    workflowReferences?: DevelopmentWorkflowGenerationReferences,
  ): Promise<void> {
    if (
      slot.state === "retired" &&
      slot.leases === 0 &&
      !(await this.#isSlotProtected(this.#readSlotGenerationIds(slot), workflowReferences))
    ) {
      await this.#closeSlot(slot);
    }
  }

  async #isSlotProtected(
    generationIds: readonly string[],
    workflowReferences?: DevelopmentWorkflowGenerationReferences,
  ): Promise<boolean> {
    if (generationIds.some((generationId) => this.#leasedGenerations.has(generationId))) {
      return true;
    }
    const references =
      workflowReferences ?? (await this.#workflowWorld.collectGenerationReferences());
    return (
      references.protectAll ||
      generationIds.some((generationId) => references.generationIds.has(generationId))
    );
  }

  #readSlotGenerationIds(slot: DevelopmentWorkerSlot): readonly string[] {
    return [...this.#generationSlots]
      .filter(([, generationSlot]) => generationSlot === slot)
      .map(([generationId]) => generationId);
  }

  #removeSlotGenerationMappings(slot: DevelopmentWorkerSlot): void {
    for (const [generationId, generationSlot] of this.#generationSlots) {
      if (generationSlot === slot) {
        this.#generationSlots.delete(generationId);
      }
    }
  }

  async #closeSlot(slot: DevelopmentWorkerSlot, cause?: unknown): Promise<void> {
    if (slot.state === "closed") {
      return;
    }
    slot.state = "closed";
    this.#slots.delete(slot);
    this.#removeSlotGenerationMappings(slot);
    if (this.#activeSlot === slot) {
      this.#activeSlot = undefined;
    }
    const cleanup = await Promise.allSettled([slot.runner.close(cause), this.#disposeSlot(slot)]);
    const errors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to close a development worker and its host.");
    }
  }

  async #stopSlotPreservingWorkspace(slot: DevelopmentWorkerSlot): Promise<void> {
    if (slot.state === "closed") {
      return;
    }
    slot.state = "closed";
    this.#slots.delete(slot);
    this.#removeSlotGenerationMappings(slot);
    if (this.#activeSlot === slot) {
      this.#activeSlot = undefined;
    }
    await slot.runner.close();
  }

  async #disposeSlot(slot: DevelopmentWorkerSlot): Promise<void> {
    if (slot.disposed) {
      return;
    }
    slot.disposed = true;
    await slot.dispose();
  }

  async #closeRetiredSlotWithoutFailingCommit(
    slot: DevelopmentWorkerSlot | undefined,
  ): Promise<void> {
    if (slot === undefined) {
      return;
    }
    await this.#closeRetiredSlot(slot).catch((error) => {
      console.error(`[eve:dev] failed to close retired worker: ${toErrorMessage(error)}`);
    });
  }

  #wakeActiveWaiters(): void {
    for (const wake of this.#activeWaiters) {
      wake();
    }
    this.#activeWaiters.clear();
  }
}

function createWorkerOwnedDevelopmentWorkflowWorld(): ParentDevelopmentWorkflowWorld {
  return {
    async close() {},
    async collectGenerationReferences() {
      return { generationIds: new Set(), protectAll: true };
    },
    async handleRequest() {
      return undefined;
    },
    async start() {},
  };
}
