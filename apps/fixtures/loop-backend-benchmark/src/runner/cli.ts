import { randomUUID } from "node:crypto";

import { parseRunnerConfig } from "./config.js";
import {
  runHostedBenchmarkCommand,
  runLocalBenchmarkCommand,
  runSandboxBenchmarkCommand,
} from "./commands.js";
import { LocalRuntimeServerGroup } from "./local-servers.js";
import { writeJsonlRecord } from "./jsonl.js";
import { runBenchmarkMatrix } from "./matrix.js";
import { SandboxRuntimeServerGroup } from "./sandbox-servers.js";
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
    const serverGroup = new SandboxRuntimeServerGroup();
    const removeSignalCleanup = installBenchmarkServerSignalCleanup({
      cleanupFailureLabel: "Vercel Sandbox",
      cleanupLabel: "the Vercel Sandbox benchmark servers",
      host: processSignalHost,
      serverGroup,
      writeDiagnostic(message) {
        process.stderr.write(message);
      },
    });
    try {
      await runSandboxBenchmarkCommand(config, {
        createRunId: randomUUID,
        runMatrix: runBenchmarkMatrix,
        serverGroup,
        writeRecord: writeJsonlRecord,
      });
    } finally {
      removeSignalCleanup();
    }
    return;
  }

  const serverGroup = new LocalRuntimeServerGroup();
  const removeSignalCleanup = installLocalServerSignalCleanup({
    host: processSignalHost,
    serverGroup,
    writeDiagnostic(message) {
      process.stderr.write(message);
    },
  });
  try {
    await runLocalBenchmarkCommand(config, {
      createRunId: randomUUID,
      runMatrix: runBenchmarkMatrix,
      serverGroup,
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
