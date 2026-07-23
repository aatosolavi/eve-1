---
"eve": patch
---

Added `resolveSubscription` to the Slack channel for durable thread subscription policy. Unsubscribed threads retain their eve session and history, ignore admitted messages before model execution, and resume when the policy returns `"subscribed"`.
