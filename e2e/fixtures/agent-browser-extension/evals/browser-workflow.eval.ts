import { defineEval } from "eve/evals";

const RESULT_TOKEN = "agent-browser-e2e-ok-Q7M";
const PAGE_HTML = [
  "<!doctype html>",
  "<title>agent-browser eve fixture</title>",
  '<main><h1>Browser extension fixture</h1><button type="button"',
  ` onclick="document.body.dataset.result='${RESULT_TOKEN}'">Activate fixture</button></main>`,
].join("");
const PAGE_URL = `data:text/html;base64,${Buffer.from(PAGE_HTML).toString("base64")}`;
const EVALUATE_EXPRESSION = "document.body.dataset.result";

export default defineEval({
  description:
    "The agent-browser extension navigates, snapshots, interacts with, and evaluates a self-contained page.",
  async test(t) {
    await t.send(
      [
        "Perform this browser tool sequence exactly once and in this order:",
        `1. Call \`browser__navigate\` with action \`goto\` and this exact URL: ${PAGE_URL}`,
        "2. Call `browser__snapshot` with `interactiveOnly` set to true.",
        "3. Find the `Activate fixture` button ref in the snapshot and call `browser__click` with that ref.",
        `4. Call \`browser__evaluate\` with the exact expression \`${EVALUATE_EXPRESSION}\`.`,
        "5. Call `browser__close`.",
        "Reply with only the value returned by `browser__evaluate`.",
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("browser__navigate", {
      input: { action: "goto", url: PAGE_URL },
      count: 1,
    });
    t.calledTool("browser__snapshot", {
      input: { interactiveOnly: true },
      output: includesText("Activate fixture"),
      count: 1,
    });
    t.calledTool("browser__click", {
      input: { selector: /^@e\d+$/u },
      count: 1,
    });
    t.calledTool("browser__evaluate", {
      input: { expression: EVALUATE_EXPRESSION },
      output: includesText(RESULT_TOKEN),
      count: 1,
    });
    t.calledTool("browser__close", { count: 1 });
    t.toolOrder([
      "browser__navigate",
      "browser__snapshot",
      "browser__click",
      "browser__evaluate",
      "browser__close",
    ]);
    t.maxToolCalls(5);
    t.messageIncludes(RESULT_TOKEN);
  },
});

function includesText(expected: string): (value: unknown) => boolean {
  return (value) => JSON.stringify(value)?.includes(expected) === true;
}
