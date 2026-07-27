---
"eve": patch
---

Harden `web_fetch` against SSRF by requiring HTTPS and rejecting non-public destinations across DNS resolution and redirects.
