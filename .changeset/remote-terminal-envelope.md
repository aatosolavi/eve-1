---
"eve": minor
---

Remote-agent session callbacks now carry an event envelope discriminated by `event.status`. The terminal callback (`status: "termination"`, `session.completed`/`session.failed`) resumes the parked parent turn as before; `"notification"`, `"working"`, and `"input_required"` are reserved on the wire and rejected by the terminal route for now. The callback wire shape changed: caller and callee deployments must both run this version.
