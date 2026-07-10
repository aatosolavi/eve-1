export const BENCHMARK_MODEL_KIND_ENV = "EVE_LOOP_BENCHMARK_MODEL_KIND";

export type BenchmarkModelKind = "deterministic" | "live";

export function parseBenchmarkModelKind(raw: string | undefined): BenchmarkModelKind {
  if (raw === undefined || raw === "deterministic") return "deterministic";
  if (raw === "live") return "live";

  throw new Error(
    `${BENCHMARK_MODEL_KIND_ENV} must be "deterministic" or "live"; received ${JSON.stringify(raw)}.`,
  );
}
