import { defineAgent } from "eve";

import { deterministicBenchmarkModel } from "../src/deterministic-model.js";
import { BENCHMARK_MODEL_KIND_ENV, parseBenchmarkModelKind } from "../src/model-kind.js";

const modelKind = parseBenchmarkModelKind(process.env[BENCHMARK_MODEL_KIND_ENV]);
const build = {
  externalDependencies: ["@temporalio/testing", "@temporalio/worker"],
};

export default modelKind === "live"
  ? defineAgent({
      build,
      model: "openai/gpt-5.4",
    })
  : defineAgent({
      build,
      model: deterministicBenchmarkModel,
      modelContextWindowTokens: 16_384,
    });
