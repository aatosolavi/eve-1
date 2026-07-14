import { createWorkflowWorkerRequest } from "#internal/nitro/host/dev-worker-http.js";
import type {
  DevelopmentWorkerGeneration,
  DevelopmentWorkerRunner,
} from "#internal/nitro/host/dev-worker-server-types.js";
import { wrapDevelopmentWorkflowResponse } from "#internal/nitro/host/development-workflow-response.js";

interface DevelopmentWorkflowExchange {
  cancel(): void;
  readonly runner: DevelopmentWorkerRunner;
}

export interface DevelopmentWorkflowLease {
  readonly generation: DevelopmentWorkerGeneration;
  release(): void;
  readonly runner: DevelopmentWorkerRunner;
}

export class DevelopmentWorkflowDispatcher {
  readonly #activeExchanges = new Set<DevelopmentWorkflowExchange>();
  readonly #admit: (generationId: string) => Promise<DevelopmentWorkflowLease>;
  readonly #onRelease: () => void;
  readonly #transportSecret: string;

  constructor(input: {
    readonly admit: (generationId: string) => Promise<DevelopmentWorkflowLease>;
    readonly onRelease: () => void;
    readonly transportSecret: string;
  }) {
    this.#admit = input.admit;
    this.#onRelease = input.onRelease;
    this.#transportSecret = input.transportSecret;
  }

  async dispatch(request: Request, generationId: string): Promise<Response> {
    const lease = await this.#admit(generationId);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      lease.release();
      this.#onRelease();
    };
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    const workerRequest = createWorkflowWorkerRequest({
      generation: lease.generation,
      request: new Request(request, { signal }),
      secret: this.#transportSecret,
    });
    const exchange: DevelopmentWorkflowExchange = {
      cancel() {
        cancellation.abort(new Error("Development Workflow delivery was cancelled."));
        release();
      },
      runner: lease.runner,
    };
    this.#activeExchanges.add(exchange);
    try {
      const response = await lease.runner.fetch(workerRequest);
      return wrapDevelopmentWorkflowResponse(response, () => {
        this.#activeExchanges.delete(exchange);
        release();
      });
    } catch (error) {
      this.#activeExchanges.delete(exchange);
      release();
      throw error;
    }
  }

  cancelRunnerExchanges(runner: DevelopmentWorkerRunner): void {
    for (const exchange of this.#activeExchanges) {
      if (exchange.runner === runner) {
        exchange.cancel();
        this.#activeExchanges.delete(exchange);
      }
    }
  }

  close(): void {
    for (const exchange of this.#activeExchanges) {
      exchange.cancel();
    }
    this.#activeExchanges.clear();
  }
}
