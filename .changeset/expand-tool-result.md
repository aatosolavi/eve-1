---
"eve": patch
---

New always-on `expand_tool_result` framework tool: when eve truncates an oversized tool result (per-step budget or compaction capping), the annotation now names the tool call id, and the model can retrieve the full output — paged — from the session's durable event stream instead of re-running the tool.
