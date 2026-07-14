---
issue: TBD
status: proposed
last_updated: "2026-07-14"
---

# Aligning eve dev onto the stock Nitro dev server

## Summary

eve currently owns its dev listener, worker transport, and worker lifecycle
(`dev-worker-server.ts` and friends). This proposal replaces that layer with
the stock Nitro dev server plus one upstream contribution, while preserving
the two behaviors that motivated it: authored HMR, and in-flight Workflow
turns finishing on the code that started them.

The reframing that makes this possible: eve's HMR never depended on the
custom dev server. Runtime-only edits publish a new immutable generation
pointer and the same worker serves new behavior through the module map. The
custom server exists only for structural swaps, turn-to-worker pinning, World
ownership, and trusted metadata. Each has a stock-Nitro answer if two
invariants are deliberately relaxed.

## Ownership after the change

```text
eve CLI process (stable)
├── watcher + rebuild coordinator (unchanged)
├── generation store and pointer (unchanged)
├── local Workflow World + queue dispatcher
│      └── deliveries via the public Nitro listener + secret header
└── stock Nitro dev server
       ├── parent proxy (Nitro-owned listener)
       └── ready-gated worker, drained on replacement (upstream)
```

## The four replacements

1. **No-reset structural swaps → upstream drain.** Nitro's dev manager
   already ready-gates reloads. The missing piece is drain: keep the retired
   runner serving its open responses (unbounded — a streaming turn can hold a
   response for minutes) while new admissions go to the ready runner. This is
   a general Nitro/env-runner improvement, not an eve-shaped feature.

2. **Turn pinning → generation modules, not workers.** A resumed turn loads
   tools, skills, instructions, and connections from its run record's
   generation — disk artifacts loadable in any worker. Selection happens
   server-side from the World's run record, so no trusted transport header is
   needed. The worker-bound residue (instrumentation globals, the Nitro step
   bundle) follows the current worker instead of the turn's original one.

3. **World ownership → the CLI process.** The World lives in the CLI process
   (no listener of its own) and dispatches deliveries through the public
   Nitro listener with a per-process secret header. Worker replacement cannot
   reset the queue: an in-flight delivery drains on the old worker; the next
   delivery lands in the new worker on the run's recorded generation.

4. **Control routes and client address.** Control routes ride the stable
   Nitro listener and survive swaps once drain exists. The client address
   falls back to proxy-forwarded headers unless trusted proxy metadata is
   also upstreamed.

## Relaxed invariants (deliberate)

- A turn that straddles a **structural** edit resumes with its original
  authored modules but the current worker's instrumentation and step bundle.
  Runtime-only edits — the overwhelmingly common case — are unaffected.
- Pointer publication and worker swap are no longer one gated transaction;
  stock Nitro controls swap timing, leaving a milliseconds-wide window of
  host/pointer skew during structural reloads.
- The client address is no longer HMAC-signed end to end.

## Unchanged

- Immutable generations, fingerprint classification, build-aside structural
  candidates, and failed-rebuild invisibility (the coordinator drives stock
  Nitro's reload instead of eve's swap).
- Latest-per-turn selection, terminal-release retention, reference-driven
  pruning, and `.workflow-data` recovery — minus worker restoration, which
  paragraph 2 makes unnecessary.

## Deleted

`dev-worker-server`, `dev-worker-http(-server)`, `dev-worker-runner`,
`dev-worker-metadata(+plugin)`, the env-runner vendor, workflow dispatch to
retired workers, and per-generation worker persistence/restoration — roughly
a third of the dev lifecycle stack plus its scenario surface.

## Delivery shape

```text
current stack tip
   |
   +-- A. pin the public dev-server contract (tests only)
        |
        +-- B. server-side generation selection
             |
             +-- C. resume turns on the active worker
                  |
                  +-- D. parent-private World RPC, public-listener deliveries
                       |
                       +-- E. stock Nitro dev server + drained replacement

env-runner drain is upstreamed in parallel and vendored as a patch until released.
```

Every stage keeps the public scenario suites green: `dev-server`,
`dev-server-chaos`, and `dev-server-bun` under `test/scenarios/`. Suites that
assert against the bespoke transport are deleted only in the stage that
deletes their subject, after stage A has re-expressed their behavioral
content against the public server.

## Test parity

Public contract (unchanged through every stage): tool-removal HMR without
worker replacement, structural replacement preserving Nitro route identity,
failed structural candidates staying invisible, streams and control routes
alive during candidate preparation, WebSocket retention across promotion,
startup-generation force-prune recovery, turn retry and restart recovery on
the recorded generation, both chaos sequences, and the bun install/runtime
pair. Stage A adds the public re-expressions below; each must pass against
the current stack before any migration stage lands.

| Implementation-level assertion (deleted with its subject)                                  | Public re-expression                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker crash terminates an admitted streaming response                                     | Chaos: an open channel stream settles within a bounded deadline after `/chaos/crash`, and the server recovers                               |
| Active stream cannot block shutdown                                                        | Chaos: SIGTERM with an open stream exits gracefully well before the harness kill fallback                                                   |
| Keep-alive connections survive promotion                                                   | Lifecycle: a kept-alive socket serves a second request on the same connection across a structural replacement                               |
| Signed client address; spoofed metadata replaced                                           | Lifecycle: a channel echoes `requestIp` as the socket peer even when the request carries forged metadata and forwarding headers             |
| Candidate/lease bookkeeping (dispose-on-failure, idempotent close, retired-worker release) | Internal resource hygiene with no public failure mode beyond the above; covered by the failed-candidate, shutdown, and chaos contract tests |
| Restores one retired worker per shared workspace                                           | Subject deleted in stage C; restart recovery of the referenced generations stays covered by the public restart scenario                     |

Deliberate contract change, stage C only: a turn that resumes after a
**structural** promotion keeps its generation's authored modules but observes
the current worker's instrumentation and step bundle. The Stage 5 scenarios'
tool-marker assertions are unchanged; their instrumentation-marker assertions
flip to the current worker's value, with the relaxation noted inline.

## Sequencing

1. **A — contract tests.** Add the public re-expressions above; no runtime
   changes.
2. **B — selection.** Per-request artifact sources resolve from the pointer
   inside the worker; queue deliveries resolve from the run record via the
   World. Metadata carries only the client address.
3. **C — active-worker turns.** Delete retired-worker dispatch, worker
   persistence, and startup worker restoration; apply the deliberate contract
   change.
4. **D — World transport.** The World stays in the CLI process behind a
   private local RPC endpoint; queue deliveries flow through the public
   listener with the delivery secret.
5. **E — stock dev server.** Replace the parent transport with
   `createDevServer` plus drained runner replacement (vendored env-runner
   patch, upstream PR in flight); the coordinator triggers stock reloads for
   structural candidates; delete the transport modules and their suites.
