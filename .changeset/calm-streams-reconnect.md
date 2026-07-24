---
"eve": patch
---

Client session streams now cancel and reconnect open connections that stop delivering bytes, resuming from the last durable cursor so buffered terminal events can still reach callers.
