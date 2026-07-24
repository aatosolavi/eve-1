---
"eve": patch
---

Agents can set `limits.maxConsecutiveToolErrors` to stop retry loops after repeated failed tool calls without limiting healthy tool-heavy runs. Conversation turns fail recoverably at the limit, while task runs and subagents return a terminal error.
