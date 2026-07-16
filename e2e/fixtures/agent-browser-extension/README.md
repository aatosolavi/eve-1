# agent-browser extension fixture

This fixture proves that a published third-party eve extension can mount,
bundle, and execute its tools in eve's sandbox on both local Docker and Vercel.
The sandbox template pre-installs agent-browser and Chromium using the
extension's public bootstrap helpers.

The eval drives a real browser against an inline `data:` document. This keeps
the test deterministic and self-contained while covering navigation, an
accessibility snapshot, ref-based interaction, JavaScript evaluation, and
browser cleanup.
