---
"eve": patch
---

Internal restructuring of the harness step: the complete generate-step flow — turn-input resolution, prompt assembly, call preflight, the model call with its recovery pipeline and failure decision tree, and settlement — now lives in the engine-neutral core as a port-driven program, with the harness supplying only the effect implementations. No behavioral change.
