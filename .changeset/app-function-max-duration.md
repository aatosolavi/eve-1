---
"eve": patch
---

The deployed app function's `maxDuration` is now raised to `"max"`, matching the workflow function, so long-lived session event streams are cut at the plan's maximum window instead of the shorter platform default.
