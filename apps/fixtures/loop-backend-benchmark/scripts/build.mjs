import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const modelKindEnvironmentName = "EVE_LOOP_BENCHMARK_MODEL_KIND";
const modelKind = process.env[modelKindEnvironmentName];
if (modelKind !== undefined && modelKind !== "deterministic" && modelKind !== "live") {
  throw new Error(
    `${modelKindEnvironmentName} must be "deterministic" or "live"; received ${JSON.stringify(modelKind)}.`,
  );
}

const compileStateDirectory = new URL("../.eve/", import.meta.url);

await rm(compileStateDirectory, { force: true, recursive: true });

const build = spawn("eve", ["build"], {
  env: process.env,
  stdio: "inherit",
});

const exitCode = await new Promise((resolve, reject) => {
  build.once("error", reject);
  build.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`eve build exited after receiving ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
