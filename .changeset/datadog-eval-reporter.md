---
"eve": patch
---

Add a `Datadog()` eval reporter for Datadog LLM Observability. It attaches each eval assertion directly to its runtime OpenTelemetry span without requiring `dd-trace`.
