---
"eve": patch
---

`eve extension build` now writes a `dist/_ext-manifest.json` contribution manifest stamped with the building eve version and a contract version for each capability the extension uses. `eve extension init` scaffolds the eve peer range as `>=<installed-version> <1` so beta extensions declare their compatibility floor.
