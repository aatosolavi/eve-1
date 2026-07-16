---
"eve": patch
---

Tool calls whose arguments the model emits as unparsable JSON (e.g. a truncated `ask_question` call) no longer crash the turn and fail the session. The parse error is fed back to the model as a tool result so the agent can retry and recover. This includes `final_output`: a truncated structured-output call now retries instead of silently terminating the run with the raw malformed string as its output.
