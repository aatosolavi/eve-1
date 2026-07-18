---
"eve": patch
---

`slackChannel` accepts a new `onEvent(ctx, event)` hook, invoked for Slack Events API callbacks with no dedicated handler — such as `reaction_added` or `channel_created`. Events a top-level handler already covers (`app_mention`, IM `message`, interactivity) never reach it.
