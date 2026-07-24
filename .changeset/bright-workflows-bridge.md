---
"eve": patch
---

Allow Next.js apps to expose a build-time allowlist of application-owned workflows to eve tools. `startNextWorkflow()` now dispatches directly through the separate Workflow World selected by `withWorkflow()`, without importing the workflow function into eve or using an HTTP bridge.
