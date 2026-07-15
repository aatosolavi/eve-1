---
"eve": patch
---

Custom channel sends now accept `turnPolicy: "queue" | "steer"`, allowing replacement input to redirect an active logical turn at its next safe boundary. Route handlers also receive token-addressed `cancelTurn()` for stopping active work without a replacement message.
