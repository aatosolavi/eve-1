import { loadDeclaration } from "../_shared.mjs";

/**
 * The trace SDK is vendored so eve can register a global `TracerProvider`
 * with its own `SpanProcessor` (local trace capture in `eve dev`). Only
 * `@opentelemetry/api` is vendored otherwise, and `trace.getTracer(...)`
 * returns a no-op tracer until a provider is registered.
 *
 * Shares the `workflow` chunk group with `@opentelemetry/api` and
 * `@ai-sdk/otel` so the API singleton is deduplicated into one shared chunk.
 * If the SDK bundled its own copy of the API, `trace.setGlobalTracerProvider`
 * here would target a different global than the one `tool-loop.ts` reads.
 *
 * `@opentelemetry/api` is intentionally NOT external: leaving it in-group
 * lets rolldown dedupe it. The transitive `@opentelemetry/{core,resources,
 * semantic-conventions}` deps are bundled in.
 */
export default {
  packageName: "@opentelemetry/sdk-trace-base",
  compiledPath: "@opentelemetry/sdk-trace-base",
  chunkGroup: "workflow",
  entry: "build/esm/index.js",
  declaration: await loadDeclaration("@opentelemetry/sdk-trace-base.d.ts"),
};
