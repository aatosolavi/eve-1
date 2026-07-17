---
"eve": patch
---

Extensions installed with a registry-style store layout (e.g. from npm with pnpm) now work in `eve dev` and `eve eval`. Bare imports in extension code resolve from the package's real location when the dev generation relocates it, instead of failing with `UNRESOLVED_IMPORT`/`ERR_MODULE_NOT_FOUND`.
