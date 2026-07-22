---
"eve": patch
---

Add zero-config local agent run traces to `eve dev`. eve now captures the OpenTelemetry span tree it already emits (turns, steps, model calls, tool calls) into `.eve/traces`, viewable as a live waterfall at `/__traces` (served by the dev server) — click any span to open a detail panel showing its inputs, outputs, prompts, tool arguments/results, token usage, and errors — and from the terminal with the new `eve trace` command (`ls`, `show`, `export`). Traces are standard OTLP/JSON, so `eve trace export` ships them to any OTLP backend. Capture is dev-only and never runs under `eve start`. Message payloads are recorded by default; set `EVE_TRACE_RECORD_INPUTS=0` and/or `EVE_TRACE_RECORD_OUTPUTS=0` to keep prompts, completions, and tool arguments/results off disk.
