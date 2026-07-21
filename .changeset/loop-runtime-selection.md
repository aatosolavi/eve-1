---
"eve": patch
---

`eve dev` and `eve start` accept an experimental `--loop <inline|workflow|temporal>` flag (env: `EVE_LOOP`) that selects which loop runtime serves sessions. The default remains the production Workflow runtime; inline and Temporal run locally only.
