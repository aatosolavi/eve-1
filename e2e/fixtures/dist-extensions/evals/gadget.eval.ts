import { defineEval } from "eve/evals";

export default defineEval({
  description: "An extension published with pnpm and installed with npm loads from dist and runs.",
  async test(t) {
    await t.send("Call `gadget__gadget_echo` with message 'eve'. Report the output.");

    t.succeeded();
    t.calledTool("gadget__gadget_echo", {
      output: { message: "eve", reply: "gadget-reply:eve" },
    });
  },
});
