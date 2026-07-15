---
issue: https://github.com/vercel/eve/issues/843
status: proposed
last_updated: "2026-07-15"
---

# Structured local diagnostics

## Summary

Local authoring failures cross discovery, Rolldown, Nitro, the harness, Workflow, and the TUI. Each
layer currently decides independently whether to print a message, a structured object, or a full
stack. That makes one root failure appear several times and exposes generated paths that do not tell
the author what to change.

Introduce one eve-owned diagnostic contract at those boundaries. The originating boundary assigns a
stable code and diagnostic ID, preserves bounded detail locally, and emits one terse stderr line.
Downstream failure events carry the same ID instead of re-logging the throwable. `eve sessions
<session-id>` can then join persisted session metadata with its local diagnostics; `eve sessions ls`
continues to list sessions. These commands and the diagnostic store are local-only.

This is a presentation and evidence-retention change. It must not turn expected failures into
successes, suppress unknown failures, or change retry and session-settlement behavior.

## Terms

- **Failure**: a runtime outcome, such as a failed tool call, step, turn, session, build, or rebuild.
- **Diagnostic**: eve's stable description of a condition: code, severity, summary, ownership,
  remediation, and a reference to local detail.
- **Log record**: operational evidence. It may be verbose and is not a user-facing contract.
- **Projection**: another representation of the same root failure, such as `step.failed` followed by
  `turn.failed` and `session.failed`.

Keeping these separate is the main invariant: a failure may have several projections but one local
diagnostic.

## Observable contract

Every originating boundary produces this eve-owned shape before rendering or persistence:

```ts
interface LocalDiagnostic {
  readonly version: 1;
  readonly diagnosticId: string;
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly phase: "discovery" | "compile" | "startup" | "rebuild" | "turn";
  readonly scope:
    | { readonly kind: "application" }
    | { readonly kind: "session"; readonly sessionId: string; readonly turnId?: string };
  readonly summary: string;
  readonly action?: string;
  readonly source?: { readonly path: string; readonly line?: number; readonly column?: number };
  readonly detail?: Readonly<Record<string, unknown>>;
}
```

The type is internal. Stable codes and the CLI rendering are the compatibility surface.

stderr renders one line per root diagnostic:

```text
[eve:tool] Tool "echo" failed: failure (tool/execution-failed, <diagnostic-id>)
```

The summary names the authored object and the condition. When present, the action is appended to the
same line after an em dash and says what the author can do next. Stack traces, cause chains,
generated-module code frames, provider bodies, and structured fields do not render inline. Unknown
failures still get a fallback summary and a local detail record.

## Ownership and flow

```text
upstream error or warning
          │
          ▼
originating boundary adapter ── classify from structured fields ──► catalog entry
          │                                                      (code, text, action)
          ├─ persist bounded, redacted detail ──► local diagnostic store
          ├─ render one stderr line
          └─ propagate diagnosticId ────────────► failure-event projections
                                                   │
                                                   └─ no second stderr record
```

The boundary that first has both the original value and eve context owns classification:

| Boundary                         | Context available                                      | Scope       |
| -------------------------------- | ------------------------------------------------------ | ----------- |
| Discovery                        | diagnostic code and authored source path               | application |
| Authored-module / Rolldown build | upstream warning code, generated origin, authored slot | application |
| Dev startup and rebuild          | app root and build phase                               | application |
| Tool and model execution         | session, turn, tool/model identifiers, original error  | session     |
| Workflow terminal handling       | session and existing diagnostic ID                     | session     |
| TUI / client transport           | target and session ID only when creation succeeded     | matching    |

Failures before session creation remain application-scoped. The system must not invent a session ID
to make them fit `eve sessions`. Their stderr line points directly to the local detail file.

## Diagnostic catalog

The catalog is a registry of stable diagnostic definitions, not a list of literal upstream message
strings. Each entry owns:

- a stable slash-delimited code;
- severity and summary/action templates;
- the structured discriminator used at its boundary;
- which context fields and detail are safe to persist;
- focused fixtures for known and fallback behavior.

Match native error classes, error names, compiler warning codes, provider status fields, and authored
slot identity before considering message text. A regex over rendered stderr is not a valid primary
classifier. Unknown values use the boundary's fallback code and retain their upstream code in detail.

Initial entries should cover the failures that motivated this plan:

| Code                               | Structured discriminator                                  | Terse result                                                        |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `authoring/missing-default-export` | authored slot plus Rolldown `IMPORT_IS_UNDEFINED` warning | Name the authored file and required export; omit generated paths    |
| `tool/execution-failed`            | AI SDK `tool-error` output                                | Name the tool and original error message once                       |
| `model/gateway-authentication`     | existing gateway error name/status fields                 | Preserve the current credential-specific remediation                |
| `<phase>/unknown`                  | no known discriminator                                    | One bounded summary; keep upstream code, stack, and cause in detail |

An empty `agent/instrumentation.ts` remains an authored-contract failure. The change is that the
compiler reports the authored file and the missing default export once, rather than dumping two
warnings against generated `compiled-artifacts-instrumentation.mjs` files.

## Local detail storage

Diagnostics use an append-only, versioned local store under `.eve/diagnostics/`. Records are keyed by
application or session scope and written by one process-specific writer file, avoiding concurrent
append ownership. Readers merge writer files by timestamp and diagnostic ID. A truncated final line
is ignored, and retention is bounded by bytes and age so repeated dev sessions cannot grow the store
without limit.

Persisted detail may include the error name, stack, cause chain, upstream code, tool name, tool call
ID, phase, and source location. Before persistence, eve must redact known credential fields and cap
recursive depth and byte length. It must not store prompts, tool inputs/results, provider response
bodies, authorization headers, continuation tokens, or environment values.

Session inspection reads this store only after resolving the requested ID from the local Workflow
World. It shows session metadata first, then diagnostics newest first. Listing sessions does not scan
or summarize diagnostic files. No deployed or remote process writes to this local store.

## Deduplication

The originating boundary creates `diagnosticId`. Every projection carries it in the existing
structured `details` object. Sinks deduplicate by that ID, not by `{ code, message }`: two independent
failures with identical text must remain distinct, while a `step.failed` → `turn.failed` →
`session.failed` cascade renders once.

If an older or third-party event has no diagnostic ID, the TUI keeps its current bounded fallback
key. That compatibility path is removed once every eve-owned producer supplies an ID.

## Adding a catalog entry

1. Capture the raw upstream value in the narrowest deterministic fixture.
2. Identify the first eve boundary with the original value and authored/session context.
3. Choose a structured discriminator and stable code; do not start from rendered text.
4. Define one summary, optional action, safe detail fields, and ownership scope.
5. Pin the terse stderr line, persisted record, source remapping, and unknown fallback in tests.
6. Verify that retry, protocol events, and session settlement are unchanged.

This makes new messages reviewable as compatibility changes instead of scattered catch-site copy.

## Acceptance cases

- A handled authored tool exception emits one terse stderr line without a stack. Its local
  session-scoped detail retains the stack/cause and tool identifiers.
- An empty instrumentation module still fails, but reports one authored-path diagnostic and no
  generated-module warning dump.
- Unknown compiler warnings and thrown values remain visible through a fallback diagnostic and local
  detail; they are never silently discarded.
- A failure cascade produces one stderr record and one diagnostic ID across all stream projections.
- Startup failures remain application-scoped; session failures are queryable by exact local session
  ID.
- Diagnostic persistence contains no prompt, tool payload, provider body, token, header, or
  environment value.

## Out of scope

- Fixing the instrumentation export case specifically.
- Changing authored tool, model retry, Workflow retry, or session-settlement semantics.
- Remote or deployed diagnostics, log drains, tracing backends, and support upload.
- A public diagnostics API or authored diagnostic registration.
- Replacing protocol failure events with the local diagnostic format.

## Delivery

Implement boundary adapters and the store in one focused PR, then migrate originating producers one
boundary at a time without leaving dual logging paths. The first implementation PR should include
the catalog entries and acceptance cases above; later entries follow the documented addition process.
