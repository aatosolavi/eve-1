---
"eve": patch
---

Internal restructuring of the harness step: the complete generate-step flow — turn-input resolution, prompt assembly, call preflight, the model call with its recovery pipeline and failure decision tree, usage accounting, and the trace envelope — now lives in the engine-neutral core as a program over dependency-shaped ports (capabilities and facets), with the harness supplying only primitives. No behavioral change.
