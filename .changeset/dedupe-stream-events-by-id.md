---
"eve": patch
---

Stream consumers now drop re-delivered events by their stable `meta.id`
instead of guessing from payload content. `EveAgentStore` (and so the React,
Vue, and Svelte bindings) no longer double-applies an `initialEvents` prefix
that the live stream replays, and the dev TUI no longer renders a subagent's
transcript twice when its child stream reopens.
