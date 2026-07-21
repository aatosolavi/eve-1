---
"eve": patch
---

Each model step's combined tool output is now bounded relative to the compaction threshold; oversized results are truncated with a note to the model, keeping at least ~20 steps between compactions.
