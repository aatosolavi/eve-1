---
"eve": patch
---

Add the inert task-mode foundation for background tasks (Slice 1 of the background-tasks plan): durable MCP-aligned task records owned by per-task actor runs, guarded notification fan-out to session-driver callback endpoints, and driver-side routing that wakes a parked session with a terminal task outcome or re-emits an `input_required` task's requests without running a turn. Nothing user-facing elects background execution yet — the creation path is internal-only.
