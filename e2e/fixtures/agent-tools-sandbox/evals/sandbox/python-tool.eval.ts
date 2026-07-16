import { defineEval } from "eve/evals";

// The `run_python` authored tool grabs a live sandbox via `ctx.getSandbox()`,
// writes a generated script with `writeTextFile`, and executes it with `run`.
// A correct sum proves the full authored-sandbox path works end-to-end with a
// real Python interpreter, not a simulated shell.
export default defineEval({
  description: "Sandbox: an authored tool runs real Python via ctx.getSandbox().",
  async test(t) {
    await t.send(
      "Use the `run_python` tool to compute the sum of these integers: 2, 3, and 4. " +
        "Reply with just the resulting number.",
    );

    t.succeeded();
    // A correct sum proves the authored-sandbox path ran real Python. The
    // exact input shape is the model's choice (it may pass the integers
    // differently), so assert on the result, not the argument encoding.
    t.calledTool("run_python", {
      output: { sum: 9 },
    });
    t.messageIncludes(/\b9\b/);
  },
});
