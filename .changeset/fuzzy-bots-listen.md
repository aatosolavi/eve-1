---
"eve": patch
---

Added `thread.listParticipants()` for Slack thread routing. Messages posted by the installed Slack app are now ignored before reaching message hooks to prevent self-reply loops.
