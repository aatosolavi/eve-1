---
"eve": patch
---

Distribute extensions as source-free, npm-standard packages. `eve extension build` now transactionally emits the contribution tree as one code-split graph (shared extension source lands once under `dist/_chunks/`, preserving module identity across contributions), plus declarations, skill resources, and a capability-stamped manifest; installed packages consume that artifact while workspace packages continue compiling live source. The consuming build enforces the extension's build eve as a compatibility floor, so an extension using newer eve APIs fails at build time instead of crashing mid-session.
