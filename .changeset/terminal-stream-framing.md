---
"eve": patch
---

Session event streams are now guaranteed to end in a terminal boundary event: when a settled workflow run's durable log ends without one (for example after a platform-level cancellation), the stream appends a synthesized `session.failed` or `session.completed` derived from the run status. The deployed app function's `maxDuration` is also raised to `"max"`, so long event streams are cut at the plan's maximum window instead of the platform default.
