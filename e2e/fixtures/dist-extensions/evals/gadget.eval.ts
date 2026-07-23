import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A pnpm-packed extension installed with npm loads from dist and its dependency-backed tool runs.",
  async test(t) {
    await t.send("Call `gadget__gadget_echo` with message 'eve'. Report the output.");

    t.succeeded();
    t.calledTool("gadget__gadget_echo", {
      output: { message: "eve", reply: "gadget-reply:eve" },
    });
  },
});
