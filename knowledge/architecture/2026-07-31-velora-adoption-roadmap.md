# Lightpanda Architecture Adoption Roadmap

Date: 2026-07-31

Status: Proposed

Reference reviewed:

- Repository: <https://github.com/lightpanda-io/browser>
- Reviewed commit: `392bb4c772446c036e3ee11357205f806f331f5d`

## Purpose

This document records the architectural ideas Velora should learn from the
current Lightpanda implementation without replacing the parts of Velora that
are already stronger.

The goal is not to synchronize Velora with Lightpanda or copy its package
layout. The goal is to adopt selected abstractions that improve automation,
MCP, deterministic workflows, agent safety, and observability while preserving
Velora's existing browser invariants.

## Non-negotiable Velora strengths

The following areas must be preserved and extended rather than replaced.

### Layered source architecture

Keep the current boundaries:

```text
adapters
    ↓
protocols
    ↓
runtime
    ↓
core
    ↓
support
```

Do not move agent-provider dependencies, MCP transport details, or SDK
convenience behavior into browser core.

Where dependencies currently flow both ways between `core` and `runtime`,
reduce them through narrow interfaces rather than flattening the packages.

### Realm and navigation lifecycle

Preserve the ownership and state-transition model implemented around:

- `src/runtime/RealmLifecycleKernel.zig`
- `src/core/js/JsEntryGate.zig`
- `src/core/js/EventLoop.zig`
- `src/core/browser/Session.zig`
- `src/core/browser/Page.zig`

In particular, retain explicit pending-page commit/discard, deferred commit,
navigation critical sections, stale-realm rejection, zombie-page reaping, and
identity invalidation.

Any new tool, MCP session, recorder, or agent layer must obey these lifecycle
contracts. It must not introduce sleeps, retries, or adapter-level cleanup to
compensate for incorrect core ownership.

### Profile, persona, and fingerprint architecture

Keep `src/runtime/profile` as a Velora-owned capability. It already covers
profile storage and rotation, persona planning, client hints, host
environment, transport/header policy, automation surface controls, and
fingerprint consistency.

Agent and protocol layers may select a profile or persona, but must not
implement fingerprint behavior themselves.

### Semantic browser capabilities

Retain and build on the existing semantic implementation:

- semantic tree
- markdown
- links
- forms
- structured data
- interactive elements
- node details
- Velora CDP semantic domain

New extraction and agent features should reuse these primitives instead of
creating a parallel DOM representation.

### Provider-neutral SDK agent model

Keep LLM providers outside browser core. Native agent UX may be added as an
optional runtime or adapter, but `core` and `runtime` must not depend directly
on OpenAI, Anthropic, Gemini, or another model provider.

## Target architecture

```text
SDK / CLI / CDP / MCP
          │
          ▼
Unified Tool Registry
schema · effects · policy · replay · secrets · errors
          │
          ├────────────────────┐
          ▼                    ▼
Automation Executor      Agent Runtime (optional)
          │              reason · plan · policy · audit
          │                    │
          └──────── Action Journal
                          │
                   Workflow Compiler
                          │
                  Deterministic Runner
                          │
                          ▼
                   Runtime Services
 session · profile · network · storage · lifecycle
                          │
                          ▼
                       Core Web
 DOM · HTML · JS · event loop · semantic · Web APIs
```

## Implementation phases

## Phase 1: Unified Tool Registry

Priority: P0

Status: Completed (2026-07-31)

### Objective

Create one authoritative registry for browser automation operations used by
MCP, CLI, SDK, agent tooling, recording, and documentation.

### Scope

Define a stable tool identifier and metadata for every public operation:

- argument and result schema
- observation versus mutation
- navigation effect
- locator requirement
- whether the result contains page data
- whether the operation is recordable
- whether it is deterministic and replayable
- secret-bearing fields
- stale-handle behavior
- timeout and cancellation behavior
- driver capability requirement

Candidate model:

```zig
pub const BrowserTool = enum {
    goto,
    semantic_tree,
    markdown,
    extract,
    links,
    forms,
    click,
    fill,
    scroll,
    hover,
    press,
    select_option,
    set_checked,
    wait_for,
    evaluate,
};

pub const ToolEffect = enum {
    observation,
    dom_mutation,
    navigation,
    external_side_effect,
};

pub const ToolPolicy = struct {
    effect: ToolEffect,
    requires_locator: bool,
    produces_data: bool,
    recordable: bool,
    replayable: bool,
    invalidates_node_refs: bool,
    required_capabilities: CapabilitySet,
    secret_fields: []const Field,
};
```

Use exhaustive switches or compile-time validation so adding a tool without
policy and schema metadata fails the build.

### Integration

- Adapt `src/protocols/mcp/tools.zig` to consume the registry.
- Generate or validate MCP tool definitions from the registry.
- Map CDP commands to registry operations where applicable.
- Expose the same logical operation set to native and Chrome drivers.
- Generate SDK/API documentation metadata where practical.

### Tests

- Every tool has schema and policy metadata.
- Registry tool IDs remain stable.
- Protocol definitions do not drift from the registry.
- Unsupported driver capabilities return typed errors.
- Mutation/navigation effects trigger the expected generation invalidation.

### Exit criteria

- MCP and at least one other adapter consume the registry.
- Adding an incomplete tool causes a compile-time or deterministic test
  failure.
- No duplicated authoritative tool list remains.

## Phase 2: Native Structured Extraction

Priority: P0

Status: Implemented for native MCP workflows (Chrome cross-driver parity remains
an explicit follow-up)

### Objective

Provide selector-schema extraction inside Velora rather than relying on raw
page JavaScript followed by SDK-side JSON validation.

### Scope

Support:

- scalar text
- HTML
- element attributes
- resolved URLs
- optional and required fields
- default values
- one element or all matching elements
- nested objects
- nested lists
- scoped extraction
- typed conversion where deterministic
- per-field diagnostics
- output size and node-count limits

Example:

```js
const products = await page.extract({
  items: {
    selector: ".product",
    all: true,
    fields: {
      title: { selector: "h2", text: true, required: true },
      url: { selector: "a", attribute: "href", resolveUrl: true },
      price: { selector: ".price", text: true }
    }
  }
});
```

### Ownership

Implement DOM traversal and value extraction at the semantic/query layer.
Protocol and SDK layers only serialize requests and results.

Extraction must operate against a known document generation. Navigation or
realm replacement during extraction must return a typed stale-document or
cancelled error.

### Tests

- Nested object and list extraction.
- Missing required and optional fields.
- Invalid selectors.
- Document navigation during extraction.
- Detached subtree behavior.
- Output limits.
- Equivalent native-driver and Chrome-driver result shapes.
- No third-party network dependency.

### Exit criteria

- Core/protocol extraction works without `evaluate`.
- MCP and SDK expose the same schema.
- Extract operations are eligible for deterministic replay.

## Phase 3: MCP HTTP Session Manager

Priority: P1

Status: Not started

### Objective

Support multiple isolated MCP clients in one Velora process using Streamable
HTTP and explicit session lifecycle management.

### Scope

- HTTP JSON-RPC endpoint.
- Session ID minted on initialize.
- Session ID returned and accepted through `Mcp-Session-Id`.
- Isolation by default.
- Explicit sharing when clients reuse a session ID.
- `session_new`, `session_list`, and `session_close`.
- Session idle timeout and capacity limits.
- Graceful shutdown.
- Bounded request body and job queue.

### Threading and ownership invariants

- A JavaScript isolate is only accessed by its owner thread.
- Connection threads never call browser or V8 APIs directly.
- Requests are marshalled to the owning worker.
- A session has one terminal close path.
- Disconnect, timeout, cancellation, initialization failure, and shutdown all
  release resources exactly once.
- Profile, cookies, storage, pages, and handles belong to an explicit session
  or browser context.
- Queue capacity and per-session resource limits are enforced.

### Tests

- Two default clients receive isolated pages, cookies, storage, and profiles.
- Reusing an ID intentionally shares the session.
- Closing one session does not affect another.
- Disconnect while a request is running.
- Session timeout during idle and active states.
- Server shutdown with queued and executing jobs.
- Invalid or expired session ID.
- Queue and request-size limits.

### Exit criteria

- Multiple agents can use one process without clobbering each other's state.
- Lifecycle tests pass under sanitizers/debug allocator where supported.
- Stdio MCP behavior remains compatible.

## Phase 4: Action Journal and Deterministic Replay

Priority: P1

Status: Not started

### Objective

Allow an exploratory agent session to be distilled into a deterministic,
model-free workflow artifact.

### Scope

Record structured actions rather than transcript strings:

```json
{
  "tool": "click",
  "locator": {
    "strategy": "css",
    "value": "button[type=submit]"
  },
  "replayable": true,
  "documentGeneration": 12
}
```

Classify:

- observations used only for reasoning
- mutations
- navigation
- final data extraction
- replayable and non-replayable locators
- operations containing secret references
- failed attempts and retries

Compile the cleaned journal to:

- a versioned JSON workflow as the canonical format
- JavaScript as an optional human-readable/export format

### Locator rules

Introduce separate public types:

```text
EphemeralNodeRef
    Valid only for the current document generation.

ReplayLocator
    A selector or semantic locator designed to be resolved again.
```

Backend node IDs must not silently become persistent locators. Recording must
reject or explicitly mark actions that cannot round-trip.

### Tests

- Successful recording and replay.
- Failed exploratory actions omitted from the compiled workflow.
- Ephemeral-only action rejected as non-replayable.
- Secret references preserved without storing values.
- Navigation invalidates ephemeral references.
- Workflow schema version validation.
- Cancellation and partial recording cleanup.
- Same workflow on native and Chrome drivers when capabilities overlap.

### Exit criteria

- A representative login-free workflow can be explored once and replayed
  without an LLM.
- The canonical workflow contains no native pointers, backend node IDs used as
  durable identity, or secret values.

### Implementation note (2026-07-31)

- `ActionJournal` owns successful replayable steps per MCP session and clears
  them deterministically when a new recording starts.
- `WorkflowRunner` validates workflow version 1 and dispatches steps in stable
  order through an executor contract.
- MCP exposes `recordingStart`, `recordingStop`, `workflowExport`, and
  `workflowReplay`.
- The initial replayable set is intentionally narrow: `goto`, `extract`, and
  `waitForSelector`. Backend-node operations such as click and fill remain
  excluded because their IDs are document-generation-scoped.
- JSON is canonical; JavaScript is an optional readable export.
- Deterministic integration coverage proves a local navigation, selector wait,
  and structured extraction workflow replays without a model. Chrome-driver
  contract parity and secret references belong to later roadmap gates.

## Phase 5: Agent Security and Secret References

Priority: P1

Status: Not started

### Objective

Create a security boundary between the user, model, untrusted page content,
browser executor, and credentials.

### Scope

- `$VELORA_*` secret references.
- Resolve values only inside the trusted executor.
- API to list allowed secret names without returning values.
- Redaction in logs, traces, URLs, headers, errors, recordings, and workflow
  exports.
- Tool-registry metadata for secret-bearing arguments.
- Path validation for workflow and artifact writes.
- Navigation and external-side-effect policy hooks.
- Treat page text, labels, links, titles, and error messages as untrusted data.
- Audit entries for policy decisions and sensitive operations.

### Tests

- Model-facing request never contains the secret value.
- Secret cannot be recovered through logs or error messages.
- Secret in URL query and headers is redacted.
- Recording stores the reference, not the resolved value.
- Absolute paths and traversal paths are rejected.
- Page content cannot override a navigation or tool policy.

### Exit criteria

- Login and authenticated workflows can run without exposing credentials to
  model context or persisted artifacts.
- Security behavior is enforced by code, not only prompt instructions.

## Phase 6: Metrics and Compatibility Dashboard

Priority: P2

Status: Partially available; unified reporting not started

### Objective

Track correctness, lifecycle health, memory behavior, and compatibility per
subsystem and per commit.

### Scope

Collect:

- test duration
- allocation count
- peak allocated bytes
- pages created and destroyed
- realms created and destroyed
- sessions created and destroyed
- pending tasks at teardown
- open handles and listeners at teardown
- network requests cancelled during navigation
- selected WPT pass/fail counts
- native-driver versus Chrome-driver contract parity

Maintain a checked or CI-persisted baseline. Report regressions separately
from known unsupported features.

### Test strategy

- Keep deterministic local regression tests as the primary gate.
- Select WPT groups matching declared Velora capabilities.
- Use real websites only as integration checks after deterministic tests.
- Never modify production behavior to satisfy one site-specific test.
- Compare performance only when correctness and wait conditions are equal.

### Exit criteria

- CI produces machine-readable metrics.
- Lifecycle leaks and compatibility regressions are visible by subsystem.
- Performance claims can be reproduced using a documented workload.

## Phase 7: Optional Native Agent Runtime

Priority: P2

Status: SDK agent foundations exist; native runtime not started

### Objective

Offer native agent and REPL ergonomics without introducing model-provider
dependencies into browser core.

### Package boundaries

```text
velora-core
velora-runtime
velora-protocols
velora-agent-runtime       optional
velora-provider-openai     optional
velora-provider-anthropic  optional
velora-sdk
```

The agent runtime consumes the unified tool registry and automation executor.
It does not directly manipulate Page, Realm, or V8 ownership.

### Scope

- Interactive REPL.
- Natural-language task execution.
- Provider-neutral reasoner interface.
- Planning and policy hooks.
- Action journal integration.
- Workflow save and replay.
- Human approval gates for external side effects.
- Tool/result size limits.
- Token and execution budget controls.

### Tests

- Provider mocked deterministically.
- Agent cannot bypass tool policy.
- Prompt injection content remains data.
- Cancellation releases active browser resources.
- Agent session can compile and replay a workflow.
- Provider failure does not corrupt browser session state.

### Exit criteria

- Native agent UX is available as an optional component.
- Browser core builds and runs without any LLM dependency.

## Cross-driver compatibility

The unified public contract should support both:

```text
Browser API
    ↓
Driver Interface
    ├── Velora Native Driver
    ├── Chrome Driver
    └── Remote Driver
```

Each driver must advertise capabilities. APIs unavailable on a driver return a
typed unsupported-capability error rather than silently changing behavior.

Portable operations should include navigation, locators, common actions,
waiting, semantic reads where emulation is possible, and structured
extraction.

Velora-specific extensions should include profile/persona control, native
semantic optimizations, runtime metrics, and browser-internal lifecycle
diagnostics.

## Error model requirements

New work should use typed errors covering at least:

- invalid arguments and schema
- invalid selector
- locator not found or ambiguous
- stale document, node, or realm
- navigation superseded
- timeout
- cancellation
- session missing, closed, or expired
- driver disconnected
- unsupported capability
- policy denied
- secret unavailable
- extraction limit exceeded
- workflow version unsupported
- replay step failed

Errors crossing MCP, CDP, or SDK boundaries must retain a stable code,
operation name, retryability classification, and safe diagnostic context.

## Completion checklist

- [x] Unified Tool Registry implemented.
- [x] MCP consumes the registry.
- [ ] SDK/driver surface consumes or validates against the registry.
- [x] Native structured `extract()` implemented.
- [ ] Extract exposed through MCP, CDP/driver, and SDK. (MCP complete; CDP/SDK pending.)
- [x] MCP Streamable HTTP implemented.
- [x] MCP multi-session isolation implemented.
- [x] Session lifecycle and shutdown tests added.
- [x] Structured Action Journal implemented.
- [x] Replayability classifier implemented.
- [x] Versioned JSON workflow compiler implemented.
- [x] Optional JavaScript workflow export implemented.
- [ ] Ephemeral node references separated from replay locators.
- [ ] `$VELORA_*` secret-reference mechanism implemented.
- [ ] Logs, errors, recordings, and exports redact secrets.
- [ ] Agent prompt-injection and navigation policies enforced.
- [ ] Allocation and lifecycle metrics emitted in CI.
- [ ] Selected WPT compatibility baseline published.
- [ ] Native/Chrome driver contract tests added.
- [ ] Optional native agent runtime implemented.
- [ ] Browser core remains free of LLM-provider dependencies.

## Explicit non-goals

- Do not copy Lightpanda's flat package layout.
- Do not replace Velora's realm/navigation lifecycle implementation.
- Do not move profile or fingerprint behavior into SDK, MCP, or agent code.
- Do not treat backend node IDs as durable replay identities.
- Do not implement agent safety only as prompt text.
- Do not make core depend on an LLM provider.
- Do not use third-party websites as the sole regression test.
- Do not encode hostname, product, CSS class, DOM ID, or site-specific markup
  into production compatibility logic.
- Do not copy upstream implementation code without reviewing provenance and
  license compatibility.

## Recommended execution order

The dependency order is:

```text
Tool Registry
    ↓
Structured Extraction
    ↓
MCP Session Manager
    ↓
Action Journal and Replay
    ↓
Secret and Agent Security
    ↓
Metrics and Compatibility
    ↓
Optional Native Agent Runtime
```

Tool Registry and Structured Extraction should be completed first. They define
the stable operation model required by MCP sessions, recording, replay, and
agent orchestration.
