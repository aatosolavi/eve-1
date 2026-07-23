import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A pnpm-packed extension installed with npm mounts in eve and its dist-only tool runs.",
  async test(t) {
    await t.send("Call `gizmo__gizmo_search` with query 'eve'. Report the output.");

    t.succeeded();
    t.calledTool("gizmo__gizmo_search", {
      output: { query: "eve", result: "gizmo-result-for:eve" },
    });
  },
});
