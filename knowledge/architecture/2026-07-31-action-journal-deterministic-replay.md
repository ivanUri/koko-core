# Action Journals Need Replayable Identity, Not Interaction Transcripts

## Summary

Velora's first deterministic workflow layer records successful automation
operations as versioned structured data. It does not persist MCP transcripts,
model reasoning, native pointers, or backend node IDs. The canonical artifact
can be replayed by the native runtime without invoking a model and can also be
exported as readable JavaScript.

The key architectural decision is that recording eligibility belongs to the
canonical automation operation registry. Protocol handlers may expose aliases,
but aliases do not define independent semantics. A journal accepts an operation
only when the registry marks it recordable and the operation completed
successfully.

## The identity problem

Exploratory browser automation often discovers an element and receives a
backend node ID. That ID is useful inside the current document generation, but
it is not a durable locator. Navigation can destroy the document, its JavaScript
realm, and every node represented by that ID.

Persisting this sequence would therefore be incorrect:

```text
interactiveElements -> backendNodeId 42 -> click(42)
```

The number `42` has meaning only inside the document that produced it. A
workflow loaded later cannot safely resolve it. Treating it as durable identity
would create workflows that appear valid but click arbitrary or missing nodes.

Velora consequently begins with a deliberately narrow replayable set:

| Operation | Replayable | Reason |
|---|---:|---|
| `goto` | yes | URL and wait options can be resolved again |
| `waitForSelector` | yes | CSS selector is resolved in the new document |
| `extract` | yes | extraction schema is resolved against current DOM |
| `click` / `fill` / `hover` | no | current API takes ephemeral backend IDs |
| `evaluate` | no | arbitrary code and side effects are not safely classified |

This is conservative by design. Future semantic or CSS locator types can make
more mutations replayable without weakening the identity invariant.

## Ownership and lifecycle

Each MCP `Server` owns one `ActionJournal`, so HTTP sessions do not share
recording state. Starting a recording clears and frees all prior owned step
data. Stopping only changes the recording state; the resulting workflow remains
available for export. Server teardown releases the journal before destroying
its allocator.

The journal copies the public operation name and its JSON arguments into its
own allocator. It never borrows request-arena memory, which is reset after the
request. This matters because recording spans multiple requests.

Only the successful terminal path appends a step. Validation failures, missing
selectors, navigation errors, timeouts, and other failed exploratory attempts
are omitted. This produces a workflow artifact rather than a debugging log.

## Format and replay contract

The canonical schema begins at version 1:

```json
{
  "version": 1,
  "steps": [
    {
      "tool": "goto",
      "arguments": {
        "url": "https://example.test"
      }
    }
  ]
}
```

`WorkflowRunner` validates the version before executing any step, resolves
public aliases to canonical actions, rejects unknown or non-replayable
operations, and preserves source order. Execution is delegated through a small
executor contract. This keeps parsing and policy independent from the native
browser implementation and leaves room for Chrome or remote executors.

The MCP native executor currently supports navigation, selector waits, and
structured extraction. Its integration test replays a local fixture from an
empty session, proving that the artifact runs without an LLM or third-party
network dependency.

## JavaScript export

JSON remains the source of truth because it has explicit versioning and stable
machine semantics. JavaScript export exists for inspection, onboarding, and
manual editing. It is derived output and must not gain semantics that the JSON
runner cannot represent.

## Failure modes prevented

- Request-arena use-after-free across recording calls.
- Failed actions leaking into the cleaned workflow.
- Backend node IDs silently becoming durable locators.
- Protocol aliases diverging into separate action policies.
- New workflow schema versions executing under old semantics.
- Recording state leaking between MCP sessions.

## Remaining work

The next useful extension is an explicit `ReplayLocator` type with CSS and
semantic strategies, paired with a separate `EphemeralNodeRef`. That can make
click and fill replayable without persisting backend IDs. Secret references,
redaction, cancellation semantics, and Chrome/native driver contract tests are
separate gates and should not be hidden inside the journal.

## Related Knowledge

- [Velora adoption roadmap](2026-07-31-velora-adoption-roadmap.md)
- [SDK smoke tests and workflows](../sdk/2026-06-30-sdk-smoke-and-workflows.md)
