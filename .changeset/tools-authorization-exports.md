---
"eve": patch
---

`eve/tools` now exports the tool authorization API: `requestAuthorization`, `getAuthorizationResult`, `getHookUrl`, and `isAuthorizationSignal` (with the `AuthorizationChallenge`, `AuthorizationResult`, and `AuthorizationSignal` types). A tool's `execute` can suspend the turn on an external authorization callback and read the parsed callback on re-execution.
