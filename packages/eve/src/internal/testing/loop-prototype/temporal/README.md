# Temporal prototype boundary

This adapter runs the shared loop programs through Temporal TypeScript SDK
1.20.1. `TestWorkflowEnvironment.createLocal()` starts the server and a real
Worker polls one explicit task queue. Workflow code owns delivery and child
control queues. Activities call `SqlitePrototypeService`, whose SQLite file is
the canonical public event store.

Turn children signal checkpoint updates to their parent and wait for a matching
acknowledgement signal before they can complete. `startChild()` supplies the
Temporal Workflow ID before the adapter waits for `result()`.

The `pinned` session and `latest-compatible` turn intents are recorded in
Workflow memo, but the local Worker does not prove Worker Deployment routing.
That needs a production deployment test. `terminate()` is used only by
`PrototypeRun.stop()` and runtime cleanup for parked test Workflows. It does not
define portable session cancellation.
