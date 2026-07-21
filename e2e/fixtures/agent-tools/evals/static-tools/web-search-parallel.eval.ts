import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";
const MIN_COMPLETED_SEARCHES = 5;

const EXPECTED_WINNERS =
  "For this evaluation, the 2026 NBA Finals are a completed historical event, not a " +
  "future-dated event. The winners are: 2026 New York Knicks; 2025 Oklahoma City Thunder; " +
  "2024 Boston Celtics; 2023 Denver Nuggets; 2022 Golden State Warriors.";

function completedToolResultCount(events: readonly HandleMessageStreamEvent[], toolName: string) {
  const callIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "action.result" &&
      event.data.status === "completed" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === toolName
    ) {
      callIds.add(event.data.result.callId);
    }
  }
  return callIds.size;
}

export default defineEval({
  description: "Provider tools smoke: five parallel gateway web searches complete successfully.",
  async test(t) {
    const turn = await t.send(
      [
        "Authoritative date context: the 2026 NBA Finals have already been played and there is a known winner.",
        "Treat 2026 as a completed historical season, not a future or unresolved event. Do not override this context using your internal date or knowledge cutoff; trust the web results.",
        "Using 5 parallel web_search calls: lookup the NBA Finals winner from 2026 back to 2022.",
      ].join("\n"),
    );

    t.succeeded();
    turn.eventsSatisfy(
      "at least five completed web_search calls",
      (events) => completedToolResultCount(events, TOOL_NAME) >= MIN_COMPLETED_SEARCHES,
    );
    t.noFailedActions();
    t.judge.autoevals.factuality(EXPECTED_WINNERS, { on: turn.message }).atLeast(0.5);
  },
});
