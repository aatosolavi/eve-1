---
"eve": patch
---

Tool calls whose arguments arrive as a raw JSON string — including the empty string some provider-executed tools send for argument-less calls — are now parsed instead of failing the turn with `Failed to parse tool-call arguments`.
