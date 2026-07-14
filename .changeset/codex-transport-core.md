---
"eve": patch
---

Add `experimental_chatgpt` under the new `eve/models/openai` subpath: it returns an AI SDK language model billed to the ChatGPT subscription, defaults to `gpt-5.6-sol` with a 200,000-token context window, and supports either the local Codex login or a generation-aware auth provider for hosted processes. Expiring or rejected ChatGPT credentials now refresh automatically, with one bounded retry for replayable requests; direct provider API request errors also surface their upstream message when one is available.
