---
"eve": patch
---

Fixed `eve dev` leaking sandbox processes (microsandbox VMs, docker containers) on shutdown. The dev server tracked which sandbox backends were initialized in an in-memory registry that the worker thread and the CLI parent did not share, so the parent's Ctrl+C cleanup always saw an empty set and stopped nothing. Shutdown now always sweeps every backend for sandboxes tagged with the dev run's id.
