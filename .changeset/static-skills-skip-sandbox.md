---
"eve": patch
---

Listing or loading static skills no longer requires opening a sandbox. The new `read_skill_file` tool progressively reads nested Markdown from static or dynamic skills; static files use compiled data, while dynamic skills and non-Markdown package files remain sandbox-backed.
