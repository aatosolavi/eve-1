import { defineEval } from "eve/evals";

import { OVERSIZED_TRUNCATION_MARKER } from "../constants";

export default defineEval({
  description: "Oversized per-step tool output is truncated with a model-visible annotation.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: oversized-step-truncation]",
        "Call emit-oversized-output exactly once.",
        "Its result is deliberately larger than the per-step tool budget.",
        "Report OVERSIZED_OUTPUT_TRUNCATION_OBSERVED once the truncation annotation is visible.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    // One execution is enough: the harness truncates the result at attach time,
    // and the mock model only reports the marker after seeing the annotation in
    // its request messages.
    t.calledTool("emit-oversized-output", { count: 1 });
    t.messageIncludes(OVERSIZED_TRUNCATION_MARKER);
  },
});
