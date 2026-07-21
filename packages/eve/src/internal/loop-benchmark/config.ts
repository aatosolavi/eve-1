import type { RuntimeKind } from "#internal/loop-benchmark/contract.js";

export const LOOP_BENCHMARK_RUNTIME_ENV = "EVE_LOOP_BENCHMARK_RUNTIME";
export const LOOP_BENCHMARK_TEMPORAL_DB_ENV = "EVE_LOOP_BENCHMARK_TEMPORAL_DB";
export const LOOP_BENCHMARK_TEMPORAL_UI_PORT_ENV = "EVE_LOOP_BENCHMARK_TEMPORAL_UI_PORT";

export interface LoopBenchmarkTemporalDevServerOptions {
  readonly dbFilename?: string;
  readonly uiPort?: number;
}

/**
 * Reads optional observability settings for the local Temporal dev server:
 * a SQLite persistence file and a Web UI port. Both default to off, which
 * keeps the server in-memory and headless.
 */
export function readLoopBenchmarkTemporalDevServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LoopBenchmarkTemporalDevServerOptions {
  const dbFilename = environment[LOOP_BENCHMARK_TEMPORAL_DB_ENV]?.trim();
  const rawUiPort = environment[LOOP_BENCHMARK_TEMPORAL_UI_PORT_ENV]?.trim();

  let uiPort: number | undefined;
  if (rawUiPort !== undefined && rawUiPort !== "") {
    uiPort = Number(rawUiPort);
    if (!Number.isInteger(uiPort) || uiPort <= 0 || uiPort > 65_535) {
      throw new TypeError(
        `${LOOP_BENCHMARK_TEMPORAL_UI_PORT_ENV} must be a port number; received "${rawUiPort}".`,
      );
    }
  }

  return {
    ...(dbFilename === undefined || dbFilename === "" ? {} : { dbFilename }),
    ...(uiPort === undefined ? {} : { uiPort }),
  };
}

/** Reads the selected loop runtime without changing eve's default runtime. */
export function readLoopBenchmarkRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeKind | undefined {
  const raw = environment[LOOP_BENCHMARK_RUNTIME_ENV]?.trim();
  if (raw === undefined || raw === "") return undefined;

  if (raw === "inline" || raw === "workflow" || raw === "temporal") {
    return raw;
  }

  throw new TypeError(
    `${LOOP_BENCHMARK_RUNTIME_ENV} must be "inline", "workflow", or "temporal"; received "${raw}".`,
  );
}
