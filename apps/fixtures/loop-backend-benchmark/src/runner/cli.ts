import { randomUUID } from "node:crypto";

import { parseRunnerConfig } from "./config.js";
import {
  runHostedBenchmarkCommand,
  runLocalBenchmarkCommand,
  runSandboxBenchmarkCommand,
} from "./commands.js";
import { LocalRuntimeServerHost } from "./local-servers.js";
import { writeJsonlRecord } from "./jsonl.js";
import { completeBenchmarkRun, executeBenchmarkSamples } from "./matrix.js";
import { SandboxRuntimeServerHost } from "./sandbox-servers.js";
import {
  installBenchmarkServerSignalCleanup,
  installLocalServerSignalCleanup,
  type BenchmarkSignalHost,
} from "./signals.js";

async function main(argv: readonly string[]): Promise<void> {
  const [mode, ...args] = argv;
  if (mode !== "local" && mode !== "hosted" && mode !== "sandbox") {
    throw new Error("Expected benchmark mode 'local', 'hosted', or 'sandbox'.");
  }

  const config = parseRunnerConfig({ argv: args, environment: process.env, mode });
  if (config.mode === "hosted") {
    await runHostedBenchmarkCommand(config);
    return;
  }

  if (config.mode === "sandbox") {
    const serverHost = new SandboxRuntimeServerHost();
    const removeSignalCleanup = installBenchmarkServerSignalCleanup({
      cleanupFailureLabel: "Vercel Sandbox",
      cleanupLabel: "the Vercel Sandbox benchmark host",
      host: processSignalHost,
      serverHost,
      writeDiagnostic(message) {
        process.stderr.write(message);
      },
    });
    try {
      await runSandboxBenchmarkCommand(config, {
        completeRun: completeBenchmarkRun,
        createRunId: randomUUID,
        executeSamples: executeBenchmarkSamples,
        serverHost,
        writeRecord: writeJsonlRecord,
      });
    } finally {
      removeSignalCleanup();
    }
    return;
  }

  const serverHost = new LocalRuntimeServerHost();
  const removeSignalCleanup = installLocalServerSignalCleanup({
    host: processSignalHost,
    serverHost,
    writeDiagnostic(message) {
      process.stderr.write(message);
    },
  });
  try {
    await runLocalBenchmarkCommand(config, {
      createRunId: randomUUID,
      completeRun: completeBenchmarkRun,
      executeSamples: executeBenchmarkSamples,
      serverHost,
      writeRecord: writeJsonlRecord,
    });
  } finally {
    removeSignalCleanup();
  }
}

const processSignalHost: BenchmarkSignalHost = {
  exit(code) {
    process.exit(code);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
  once(signal, listener) {
    process.once(signal, listener);
  },
};

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
