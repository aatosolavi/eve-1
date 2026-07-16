---
"eve": patch
---

Distribute extensions as a compiled artifact. `eve extension build` now emits every contribution as a pre-scoped `.mjs` plus a `dist/_ext-manifest.json`, and a consuming agent composes an extension that ships one without recompiling or executing its source. Compatibility is checked by per-capability version stamps recorded at build and validated at the consumer, failing with a clear "rebuild the extension" message on a mismatch. Unbuilt local/workspace extensions still compile from source, so in-progress workspace extensions keep live-reloading under `eve dev`.
