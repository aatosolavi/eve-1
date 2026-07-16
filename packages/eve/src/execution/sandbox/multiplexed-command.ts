import type { SandboxProcess } from "#shared/sandbox-session.js";
import { createSandboxOutputObserver } from "#execution/sandbox/output-events.js";

type OutputName = "stderr" | "stdout";

interface MultiplexedCommand<Log extends { readonly data: string }> {
  kill(): PromiseLike<void>;
  logs(): AsyncIterable<Log>;
  wait(): PromiseLike<{ readonly exitCode: number }>;
}

interface OutputChannel {
  readonly stream: ReadableStream<Uint8Array>;
  close(): void;
  enqueue(chunk: Uint8Array): void;
  error(cause: unknown): void;
}

function createOutputChannel(): OutputChannel {
  let canceled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
    start(value) {
      controller = value;
    },
  });

  return {
    stream,
    close() {
      if (!canceled) {
        controller.close();
      }
    },
    enqueue(chunk) {
      if (!canceled) {
        controller.enqueue(chunk);
      }
    },
    error(cause) {
      if (!canceled) {
        controller.error(cause);
      }
    },
  };
}

/**
 * Adapts a detached command with one tagged log iterator to a sandbox process
 * with independent stdout and stderr streams.
 */
export function adaptMultiplexedCommandToSandboxProcess<
  Log extends { readonly data: string },
>(input: {
  readonly command: MultiplexedCommand<Log>;
  readonly getOutput: (log: Log) => OutputName;
  readonly sandboxId?: string;
}): SandboxProcess {
  const encoder = new TextEncoder();
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const outputs: Record<OutputName, OutputChannel> = { stderr, stdout };
  const observer =
    input.sandboxId === undefined ? undefined : createSandboxOutputObserver(input.sandboxId);

  const logsDone = (async () => {
    try {
      for await (const log of input.command.logs()) {
        const output = input.getOutput(log);
        observer?.write(output, log.data);
        outputs[output].enqueue(encoder.encode(log.data));
      }
      stdout.close();
      stderr.close();
    } catch (error) {
      stdout.error(error);
      stderr.error(error);
      throw error;
    } finally {
      observer?.close("stdout");
      observer?.close("stderr");
    }
  })();
  // The streams surface log failures immediately; retain the rejection for wait().
  void logsDone.catch(() => undefined);

  let waitPromise: Promise<{ exitCode: number }> | undefined;
  let killPromise: Promise<void> | undefined;

  return {
    stderr: stderr.stream,
    stdout: stdout.stream,
    wait() {
      return (waitPromise ??= Promise.resolve().then(async () => {
        const finished = await input.command.wait();
        await logsDone;
        return { exitCode: finished.exitCode };
      }));
    },
    kill() {
      return (killPromise ??= Promise.resolve().then(() => input.command.kill()));
    },
  };
}
