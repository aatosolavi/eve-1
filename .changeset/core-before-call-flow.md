---
"eve": patch
---

Internal restructuring of the harness step: the pre-call flow (turn-input resolution and prompt assembly) now lives in the engine-neutral core as a port-driven pipeline, with the harness supplying only the effect implementations. No behavioral change.
