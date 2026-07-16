export class InlineRunStoppedError extends Error {
  constructor() {
    super("Inline prototype run stopped.");
    this.name = "InlineRunStoppedError";
  }
}

interface PendingRead<Value> {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: Value) => void;
}

export class AsyncQueue<Value> {
  readonly #pending: PendingRead<Value>[] = [];
  readonly #values: Value[] = [];
  #failure: Error | null = null;

  push(value: Value): void {
    if (this.#failure !== null) return;

    const pending = this.#pending.shift();
    if (pending === undefined) {
      this.#values.push(value);
      return;
    }

    pending.resolve(value);
  }

  async shift(): Promise<Value> {
    if (this.#failure !== null) throw this.#failure;

    if (this.#values.length > 0) {
      const value = this.#values.shift();
      if (value === undefined) throw new Error("Queued value disappeared.");
      return value;
    }

    return await new Promise<Value>((resolve, reject) => {
      this.#pending.push({ reject, resolve });
    });
  }

  stop(error: Error): void {
    if (this.#failure !== null) return;

    this.#failure = error;
    this.#values.length = 0;
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }
}
