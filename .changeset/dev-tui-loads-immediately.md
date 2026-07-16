---
"eve": patch
---

`eve dev` now paints the interactive shell immediately when starting a local server, and reports build, agent connection, and active-run recovery as progress inside the shell instead of as console preamble. The prompt stays gated until startup finishes, and startup failures surface in the shell with their recovery context.
