# registry-extension

Proves a source-backed extension works when installed with a registry-style
node_modules layout.

The workspace `extensions` fixture consumes its extensions via `workspace:*`,
and pnpm links a workspace package's dependencies inside the package directory
— so bare imports in extension source (e.g. `import { z } from "zod"`) resolve
from anywhere. A registry install does not get that layout: pnpm copies the
package into the virtual store and its dependencies are store _siblings_, only
resolvable from the package's real location.

`vendor/gadget-extension` is deliberately not a workspace package (the
workspace glob is `e2e/fixtures/*`, one level). Depending on it with the
`file:` protocol makes pnpm copy it into the virtual store like a registry
package, reproducing the sibling-dependency layout without publishing anything.
