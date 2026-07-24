---
"eve": patch
---

Internal restructuring of the step execution path: the complete flow — the durable-step entrypoint (context restore, authorization completion, delivery resolution, outcome projection) and the generate step it runs (turn-input resolution, prompt assembly, the model call with recovery and the failure decision tree, usage accounting, trace envelope) — now lives in the engine-neutral core as programs over dependency-shaped ports, with the runtime supplying only primitives. Engines compose the core entrypoint directly (the turn-step-operation indirection is gone), and the core boundary is now mechanically enforced as "no runtime imports; type-only imports permitted" so implementation modules can begin migrating into core. No behavioral change.
