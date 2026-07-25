---
"eve": patch
---

A remote agent's `authorization.required`/`authorization.completed` events now surface on the caller's stream. The callee forwards them to the caller's session-callback URL as `status: "notification"` events; the caller resumes its parked turn and proxies them onto its stream exactly as a local subagent's authorization events — the durable `resumeHook` path, handled in the session workflow, not a best-effort side channel. So a remote subagent that needs a connection authorized mid-run surfaces the sign-in prompt in the caller's channel just like a local one.
