import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

export interface DevelopmentWorkerGeneration {
  readonly id: string;
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
}

export interface DevelopmentWorkerRunner {
  readonly closed: boolean;
  close(cause?: unknown): Promise<void>;
  fetch(request: Request): Promise<Response>;
  upgrade(input: {
    readonly node: {
      readonly head: Buffer;
      readonly req: IncomingMessage;
      readonly socket: Socket;
    };
  }): Promise<void>;
  waitForReady(timeout: number): Promise<void>;
}

export interface DevelopmentWorkerRunnerFactoryInput {
  readonly appRoot: string;
  readonly entry: string;
  readonly name: string;
  readonly onClose: (cause?: unknown) => void;
  readonly transportSecret: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export type DevelopmentWorkerRunnerFactory = (
  input: DevelopmentWorkerRunnerFactoryInput,
) => DevelopmentWorkerRunner;

export type DevelopmentWorkerState = "candidate" | "active" | "retired" | "closed";

export interface DevelopmentWorkerSlot {
  disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly entry: string;
  readonly generation: DevelopmentWorkerGeneration;
  leases: number;
  readonly runner: DevelopmentWorkerRunner;
  state: DevelopmentWorkerState;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export interface DevelopmentWorkerCandidate {
  readonly slot: DevelopmentWorkerSlot;
}

export interface DevelopmentWorkerPublication {
  commit(): void;
  rollback(): Promise<void>;
}

export interface DevelopmentWorkerListener {
  close(): Promise<void>;
  readonly node: { readonly server: Server };
  ready(): Promise<void>;
  readonly url: string | undefined;
}

export interface DevelopmentWorkerServer {
  close(): Promise<void>;
  discardCandidate(candidate: DevelopmentWorkerCandidate): Promise<void>;
  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener;
  prepareCandidate(input: {
    readonly dispose: () => Promise<void>;
    readonly entry: string;
    readonly generation: DevelopmentWorkerGeneration;
    readonly workerData: Readonly<Record<string, unknown>>;
  }): Promise<DevelopmentWorkerCandidate>;
  promote(candidate: DevelopmentWorkerCandidate): Promise<void>;
  publishRuntimeGeneration(input: {
    readonly generation: DevelopmentWorkerGeneration;
    readonly publish: () => Promise<DevelopmentWorkerPublication>;
  }): Promise<void>;
  publishStructuralCandidate(input: {
    readonly candidate: DevelopmentWorkerCandidate;
    readonly publish: () => Promise<DevelopmentWorkerPublication>;
  }): Promise<void>;
  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void;
  startWorkflowWorld(): Promise<void>;
}

export type DevelopmentWorkflowWorldOwnership =
  | { readonly agentName: string; readonly kind: "parent-local" }
  | { readonly kind: "worker-configured" };
