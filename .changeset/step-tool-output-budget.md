---
"eve": patch
---

Each model step's combined tool output is now budgeted relative to the compaction threshold, and oversized results are truncated with a note to the model. At typical thresholds, the budget targets roughly 20 tool-heavy steps per window while retaining a 2,000-token minimum for useful tool feedback.
