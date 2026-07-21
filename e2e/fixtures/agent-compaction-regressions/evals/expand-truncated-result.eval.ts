import { defineEval } from "eve/evals";

import { EXPANSION_MARKER } from "../constants";

export default defineEval({
  description: "A truncated tool result's full output is retrievable from the session stream.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: expand-truncated-result]",
        "Call emit-oversized-output once; its result will be truncated.",
        "Then retrieve the full output with expand_tool_result and report",
        "TRUNCATED_OUTPUT_EXPANDED once the payload tail is visible.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("emit-oversized-output", { count: 1 });
    t.calledTool("expand_tool_result", { count: 1 });
    t.messageIncludes(EXPANSION_MARKER);
  },
});
