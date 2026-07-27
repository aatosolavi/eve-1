---
"eve": patch
---

Every session stream event now carries a stable `meta.id`. The id is a sortable, `evt_`-prefixed ULID minted once when the event is written to the durable stream, so reconnecting from a cursor, rewinding to `startIndex=0`, or replaying a finished session all return the same id for the same event — making it safe to use as a primary key when persisting events (`on conflict (id) do nothing`). Channel adapters, the durable stream, and authored hooks now all observe the same envelope, so a hook can use `event.meta.id` to make its own side effects idempotent. Events read from a stream are typed as the new `StampedHandleMessageStreamEvent`, which guarantees `meta` is present.
