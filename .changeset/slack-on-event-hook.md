---
"eve": patch
---

`slackChannel` accepts a new `onEvent(ctx, event)` hook, invoked for every Slack Events API callback — including event types with no dedicated handler, such as `reaction_added` or `channel_created`. Mentions and DMs still route through `onAppMention` / `onDirectMessage`; `onEvent` observes them without affecting dispatch.
