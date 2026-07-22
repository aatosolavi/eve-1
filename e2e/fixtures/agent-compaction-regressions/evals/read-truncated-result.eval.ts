import { defineEval } from "eve/evals";

import { READ_BACK_MARKER } from "../constants";

export default defineEval({
  description: "A truncated tool result's full output is retrievable from the session stream.",
  async test(t) {
    const turn = await t.send(
      [
        "[case: read-truncated-result]",
        "Call emit-oversized-output once; its result will be truncated.",
        "Then retrieve the full output with read_tool_result and report",
        "TRUNCATED_OUTPUT_READ_BACK once the payload tail is visible.",
      ].join("\n"),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("emit-oversized-output", { count: 1 });
    // The mock walks nextOffsetChars pages until the tail sentinel appears,
    // so the marker also proves the pagination contract; the page count
    // depends only on the fixed payload size.
    t.messageIncludes(READ_BACK_MARKER);
  },
});
