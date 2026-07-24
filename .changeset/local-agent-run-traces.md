---
"eve": patch
---

Add zero-config local agent run traces to `eve dev`. A private, provider-neutral instrumentation pipeline records session, turn, model, and tool activity into `.eve/traces` without capturing Workflow spans or replacing authored instrumentation; inspect runs at `/__traces` or with `eve trace ls`, `show`, and `export`. Capture is dev-only, uses standard OTLP/JSON, and records message payloads by default; set `EVE_TRACE_RECORD_INPUTS=0` and/or `EVE_TRACE_RECORD_OUTPUTS=0` to keep prompts, completions, and tool arguments/results off disk.
