---
"eve": patch
---

A remote agent's non-terminal progress (message, reasoning, and step events) now surfaces on the caller's stream, wrapped as `subagent.event`. The callee forwards progress to the caller's `:events` ingestion URL, which appends it to the caller's durable stream without waking or replaying the caller's main workflow run — the best-effort progress lane, kept off the main run's journal by design. Delivery is fire-once: a closed stream (finished session) drops silently.
