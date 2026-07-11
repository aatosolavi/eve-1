import {
  createSampleId,
  type BenchmarkTarget,
  type RuntimeKind,
  type SampleId,
} from "#internal/loop-benchmark/contract.js";

export const LOOP_BENCHMARK_RUNTIME_ENV = "EVE_LOOP_BENCHMARK_RUNTIME";
export const LOOP_BENCHMARK_RECORD_PATH_ENV = "EVE_LOOP_BENCHMARK_RECORD_PATH";
export const LOOP_BENCHMARK_SAMPLE_ID_HEADER = "x-eve-benchmark-sample-id";
export const LOOP_BENCHMARK_TARGET_ENV = "EVE_LOOP_BENCHMARK_TARGET";

/** Reads the optional append-only raw-record destination. */
export function readLoopBenchmarkRecordPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const path = environment[LOOP_BENCHMARK_RECORD_PATH_ENV]?.trim();
  return path === undefined || path === "" ? undefined : path;
}

/** Reads the selected benchmark runtime without changing eve's default runtime. */
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

/** Reads an explicit benchmark target, then falls back to Vercel's deployment environment. */
export function readLoopBenchmarkTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BenchmarkTarget {
  const explicit = environment[LOOP_BENCHMARK_TARGET_ENV]?.trim();
  if (explicit === "local" || explicit === "vercel") return explicit;
  if (explicit !== undefined && explicit !== "") {
    throw new TypeError(
      `${LOOP_BENCHMARK_TARGET_ENV} must be "local" or "vercel"; received "${explicit}".`,
    );
  }
  return environment.VERCEL_ENV === undefined ? "local" : "vercel";
}

/** Reads the optional client-created sample identity at HTTP ingress. */
export function readLoopBenchmarkSampleId(headers: Headers): SampleId | undefined {
  const raw = headers.get(LOOP_BENCHMARK_SAMPLE_ID_HEADER)?.trim();
  return raw === undefined || raw === "" ? undefined : createSampleId(raw);
}
