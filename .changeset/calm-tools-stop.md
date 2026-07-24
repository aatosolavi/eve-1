---
"eve": patch
---

Agents now stop retry loops after 10 consecutive failed tool calls by default, configurable with `limits.maxConsecutiveToolErrors`, without limiting healthy tool-heavy runs. Conversation turns fail recoverably at the limit, while task runs and subagents return a terminal error.
