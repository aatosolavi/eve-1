---
"eve": patch
---

The dev TUI's rendering model is overhauled end to end.

**Prose & reasoning.** Markdown renders through a real GFM parser (width-fitted tables, code blocks, task lists, links). Reasoning defaults to a one-line thinking indicator that updates in place, persisting as `○ Thought for 12s` only for long thoughts (`--reasoning full` restores the streaming trace).

**Tool activity.** Every builtin tool gets semantic activity copy (`Fetch <url>`, `Run <command>`, `Search <query>`). An in-flight batch accumulates as one counted header with its newest calls behind a `│` rail, then collapses to a single past-tense line (`▪ Fetched 30 URLs`) once settled — failures keep their itemized per-call error rail. `write_file` renders a real line diff, and rejected tool approvals show as denied instead of successful.

**Prompt & panels.** `ask_question` opens a numbered overlay above the input (number keys select, Esc dismisses), committing as `? question ⎿ answer`. `todo` drives a pinned panel above the input instead of transcript blocks. An empty prompt shows a quiet `›` mark with rotating suggestions, never submits, and stays anchored during a turn — a draft typed mid-turn carries into the next prompt.

**Turns & sessions.** Completed turns close with a `└ Done in <duration>` coda (token flow, context fill) when the turn was long or expensive, and a mid-conversation session replacement marks the context cut with a `┌── Session restarted, clear context.` boundary line.

**Subagents & logs.** Subagent calls render as `※ subagent(<name>)` sections windowed to the most recent activity, closing on a corner that reports `Done` when the final message arrives. Captured server output renders as continuous `○ stderr` / `○ stdout` stream sections anchored at their newest write, with history behind an `… (N more)` count and the stored-diagnostics pointer.

**Status bar.** Names the model's actual routing and credential: `via ai-gateway(oidc:<project>)`, `via ai-gateway(api-key)`, or `via <provider>⌝` for a directly-authored endpoint.
