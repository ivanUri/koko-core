# Koko Core Architecture

> Canonical orientation document for engineers and coding agents.
>
> Read this file first, then inspect only the subsystem and tests relevant to
> the change. It is an architectural map, not a replacement for source-level
> verification. Update it when ownership, boundaries, build dependencies, or
> major execution paths change.
>
> Last verified: 2026-11-28. Repository: `ivanUri/koko-core`.

## 1. Executive summary

Koko Core is an independent, lightweight, headless browser runtime for web
execution, crawling, testing, automation, and AI agents.

It is not a Chromium wrapper and must not embed Blink or Chromium in the
production runtime. The production engine is:

```text
Zig runtime and authoritative DOM
        +
V8 JavaScript execution
        +
html5ever HTML parsing
        +
libcurl/network and profile services
        +
Rust Stylo CSS style engine
        +
Rust Taffy layout and Parley text measurement
        +
CDP, MCP, and CLI adapters
```

The central design rule is ownership:

- Zig owns the browser lifecycle, DOM, realms, scheduling, navigation, and
  resource ownership.
- V8 owns JavaScript execution inside Koko-owned isolates and contexts.
- Rust owns Stylo, Taffy, and Parley implementation state behind narrow C ABI
  boundaries.
- CDP and MCP project engine state; they must not reimplement browser
  semantics.
- Chromium/Blink is a reference implementation for differential testing only.

## 2. Repository map

```text
src/
  koko.zig                    Public Zig orchestration and fetch entry points
  adapters/
    cli/                      `koko fetch`, `serve`, `mcp`, `profile`, help
    cdp/                      CDP server/transport adapter entry points
  core/
    browser/                  Browser, Session, Page, Frame, navigation,
                              HTTP coordination, StyleEngine, LayoutEngine
    dom/                      Authoritative Zig DOM and DOM wrappers
    parser/                   HTML/XML parser integration and parse lifecycle
    html5ever/                Rust/html5ever bridge and parser callbacks
    js/                       V8 bridge, values, isolates, contexts,
                              scheduler, microtasks, realms
    webapi/                   Window, Document, Element and Web Platform APIs
    layout/                   Rust static library plus Zig C ABI wrapper
    xpath/                    XPath parser/evaluator
    semantic/                 Semantic tree and extraction support
    browser/tests/            Deterministic browser/Web API fixtures
  runtime/
    App.zig                   Process-level services and startup
    Config.zig                CLI/runtime configuration
    network/                  Curl/network policy, cache, connection handling
    storage/                  SQLite/profile-backed state
    profile/                  Persistent profile and fingerprint state
    ResourceController.zig    RSS/VMS/admission/resource policy
    ArenaPool.zig             Reusable arena ownership
  protocols/
    cdp/                      CDP transport, sessions, domains, handles
    mcp/                      MCP server, tools, resources, actions
  support/                    Allocators, logging, native APIs, utilities
  testing/                    Zig test runner, local servers, test helpers
bench/
  runner.mjs                  Deterministic benchmark runner
  adapters/                    Koko/Chromium/other runtime adapters
  suites/                      Startup, navigation, DOM, Stylo, memory, etc.
compatibility/                WebIDL/binding compatibility checks
docs/                         Subsystem design notes and investigations
knowledge/                    Historical decisions, bugs, and test evidence
```

Important existing guides:

- [`CODEBASE_OVERVIEW.md`](CODEBASE_OVERVIEW.md): broad repository tour.
- [`AGENTS.md`](AGENTS.md): mandatory correctness and ownership rules.
- [`docs/stylo-integration.md`](docs/stylo-integration.md): Stylo bridge
  details.
- [`docs/architecture-module-boundaries.md`](docs/architecture-module-boundaries.md):
  module boundary rules.
- [`bench/README.md`](bench/README.md) and [`bench/SPEC.md`](bench/SPEC.md):
  measurement contract.

## 3. Layered architecture

```text
External clients and agents
        |
        +-- TypeScript Koko SDK (separate repository)
        +-- CDP clients
        +-- MCP clients
        +-- CLI users
        v
Adapters and protocols
  src/adapters/       src/protocols/cdp/       src/protocols/mcp/
        |
        v
Browser runtime kernel
  App -> Browser -> Session -> Page -> Frame
        |
        +-- navigation/network/resource loading
        +-- V8 realm and scheduler
        +-- authoritative DOM and parser
        +-- Web APIs and events
        +-- StyleEngine -> Stylo
        +-- LayoutEngine -> Taffy + Parley
        v
Native/runtime services
  libcurl, SQLite, V8, html5ever, Stylo, Taffy, Parley, platform APIs
```

The dependency direction is intentional: protocol code may call the engine;
the engine must not depend on CDP/MCP behavior. Exporters and benchmarks must
observe engine state rather than repair it after the fact.

## 4. Runtime ownership tree

```text
App
├── process configuration
├── Network / HTTP policy / cache
├── profile and persistent storage services
├── telemetry and notifications
├── ArenaPool
└── ResourceController
    └── Browser
        ├── V8 isolate/environment
        └── Session
            ├── scheduler and session state
            ├── cookies/profile view
            └── Page
                └── top-level Frame
                    ├── Document
                    │   └── authoritative Zig DOM tree
                    ├── Window and Web APIs
                    ├── JavaScript realm / V8 context
                    ├── parser and script managers
                    ├── StyleEngine / Stylo bridge
                    ├── LayoutEngine / Taffy / Parley bridge
                    └── child frames and browsing contexts
```

### Ownership invariants

1. The Zig DOM is the only authoritative DOM. Rust does not own a duplicate
   DOM tree; it receives stable node IDs and synchronous callback data.
2. A Browser owns its V8 isolate. Isolate and context operations are
   thread-affine and must not be shared between unrelated sessions.
3. A document/realm generation owns its callbacks, tasks, resources, wrappers,
   styles, layout handles, and navigation state.
4. Navigation, teardown, cancellation, timeout, and shutdown must all have a
   terminal release path. Stale callbacks must fail the generation/owner check
   before touching a new realm.
5. Caches are derived state. Every cache needs an explicit key, owner,
   generation/font dependency, bound, and invalidation rule.
6. A protocol handle is generation-scoped. It must never silently resolve to a
   node or realm from a replaced document.

## 5. Main website execution pipeline

The normal execution path is:

```text
CLI / CDP / MCP request
  -> App.init
  -> Browser.init (V8 environment, snapshot, process services)
  -> Browser.newSession
  -> Session/Page/Frame creation
  -> Frame.navigate
  -> URL and network policy
  -> HttpClient/libcurl DNS, connection, TLS, request, response
  -> response body buffering and deferred parse scheduling
  -> html5ever parser callbacks
  -> Zig DOM construction
  -> script discovery/loading and V8 compile/evaluate
  -> scheduler tasks and microtask checkpoints
  -> DOM mutations/events/observers
  -> StyleEngine invalidation and Stylo preparation as needed
  -> optional Taffy/Parley layout flush for geometry-dependent APIs
  -> DOM query, CSSOM, text extraction, semantic extraction, or serialization
  -> lifecycle wait and deterministic teardown
```

Relevant implementation anchors:

| Stage | Primary source | Key symbols/areas |
|---|---|---|
| Process startup | `src/runtime/App.zig` | `App.init`, storage/network/resource services |
| CLI entry | `src/adapters/cli/main.zig`, `src/koko.zig` | command parsing and fetch orchestration |
| Browser/session | `src/core/browser/Browser.zig`, `Session.zig`, `Page.zig` | isolate, session, page ownership |
| Navigation | `src/core/browser/Frame.zig`, `URL.zig` | `navigate`, commit/abort/teardown |
| HTTP | `src/core/browser/HttpClient.zig`, `src/runtime/network/` | request admission, curl callbacks, body delivery |
| HTML | `src/core/parser/`, `src/core/html5ever/` | deferred parse, parser callbacks, DOM creation |
| JavaScript | `src/core/js/`, `ScriptManager.zig` | V8 values, contexts, compile/eval, microtasks |
| Scheduling | `src/core/js/Scheduler.zig`, frame tick paths | tasks, timers, observers, checkpoints |
| DOM/Web APIs | `src/core/dom/`, `src/core/webapi/` | node identity, wrappers, events, CSSOM |
| Style | `src/core/browser/StyleEngine.zig`, Rust `stylo_bridge` | stylesheet and DOM invalidation |
| Layout | `src/core/browser/Frame.zig`, `src/core/layout/` | Taffy node projection, Parley measurement |
| Extraction | `src/core/browser/dump.zig`, `markdown.zig`, `semantic/` | HTML, Markdown, structured output |

### What is eager versus lazy

- Browser/V8 process initialization is eager at browser startup.
- HTTP transfers and curl easy handles are created lazily when work arrives.
- HTML parsing is deferred until the response body is owned by the document
  parse path.
- DOM construction and script execution happen during navigation and scheduled
  execution.
- `textContent`, DOM queries, and static HTML serialization do not inherently
  require layout.
- `getComputedStyle()` requires style preparation but should not require Taffy
  layout unless the queried API has geometry semantics.
- Geometry APIs such as `getBoundingClientRect`, `offsetWidth`, client/scroll
  dimensions, hit testing, and observers that depend on geometry synchronously
  flush layout.
- `innerText` can require style/visibility and line/layout-related behavior;
  do not treat it as equivalent to `textContent`.

Do not add a layout flush to a non-geometric API merely because it is
convenient. Do not remove a flush from an API whose Web Platform semantics
require current geometry.

## 6. DOM, parser, V8, and Web API boundaries

### DOM and parser

The DOM implementation in `src/core/dom/` owns node identity, parent/child
links, attributes, text, document ownership, shadow roots, wrappers, and
mutation notifications. html5ever is used for standards-oriented HTML
tokenization/tree construction, but the resulting tree is a Zig tree.

When changing a mutation:

1. update the authoritative Zig DOM;
2. emit the correct mutation/style/layout/lifecycle invalidation;
3. queue observers/events according to the scheduler contract;
4. ensure detached/replaced realms reject stale work;
5. add a deterministic fixture covering success and teardown.

### V8 and realms

`src/core/js/` converts between V8 values and Zig Web API wrappers. Realm and
context lifetime is tied to Frame/document generations. JavaScript callbacks,
Promise reactions, timers, workers, MessagePorts, MutationObservers, and
network completions must check their owning realm before dispatch.

Do not solve reentrancy or lifecycle bugs with sleeps, retries, or delayed
cleanup. Fix task ownership and generation checks at the scheduler/resource
owner.

## 7. CSS and layout architecture

```text
Zig DOM + CSSOM mutation
        |
        v
StyleEngine.zig
  DOM generation + stylesheet generation
  Stylo C ABI and stable node IDs
        |
        v
Rust layout static library: src/core/layout/
  Stylo: parsing, selector matching, cascade, inheritance, computed values
  Taffy: layout tree and geometry computation
  Parley: text shaping/measurement adapter
        |
        v
Zig Frame geometry snapshots and Web API results
```

### Stylo ownership and invalidation

`StyleEngine.zig` owns the per-frame bridge handle and generation bookkeeping.
The Rust Stylo bridge owns parsed stylesheet and stylist state, but it does not
own the DOM.

Two generations must remain conceptually separate:

- DOM generation: node/attribute/text/tree/document changes.
- Stylesheet generation: stylesheet source/order/scope, CSSOM rule mutation,
  adopted stylesheet, media/environment, or shadow-scope changes.

Ordinary DOM mutations must preserve parsed stylesheet and StylistStore state.
Actual stylesheet changes may rebuild or replace stylesheet state. Restyle and
selector invalidation must still account for inheritance, sibling/structural
selectors, `:has()`, pseudo-classes, shadow scopes, adopted stylesheets, and
fragment target state.

Primary sources:

- `src/core/browser/StyleEngine.zig`
- `src/core/browser/style_engine/abi.zig`
- `src/core/browser/Frame.zig::invalidateStyleEngine`
- `src/core/stylo/lib.rs`, `dom_adapter.rs`, and `stylist_store.rs`
- `src/core/layout/build.rs` generates namespaced bridge modules under Cargo's
  `OUT_DIR`; they are not checked-in source files.

### Taffy and Parley ownership

`src/core/layout/lib.rs` is the single Rust static library linked by Koko. It
owns Taffy nodes, typed layout contexts, Parley font/text state, and bounded
measurement caches. Zig owns stable DOM-to-layout identity and calls the C ABI
in `src/core/layout/layout.h` through `LayoutEngine.zig`.

Current layout synchronization behavior:

- Taffy node handles are retained across flushes where possible.
- Style, text, text-style, and child-list setters skip equivalent values.
- Layout flush still traverses the live DOM and computes the layout tree
  broadly; it is not yet dependency-aware incremental synchronization.
- Computed style projection is still largely string-based across the Zig/Rust
  boundary. CSSOM serialization must remain string-compatible even if a future
  typed layout batch ABI is added.
- Parley measurement cache keys include text/style/layout inputs, but font
  discovery/loading generation must remain part of future invalidation work.

Never add a second permanent CSS/layout engine. Keep any legacy path only for
validated differential testing, then remove it after the replacement passes
correctness gates.

### Diagnostic metrics

`window.__kokoStyleEngine` is a nonstandard diagnostic surface. It exposes:

- Stylo: stylesheet rebuilds/parses/bytes, DOM invalidations, restyled nodes,
  computed cache hit/miss, FFI calls, copied bytes.
- Layout: computations, style/text/children updates and skips, Parley cache
  hit/miss/eviction counters.

The diagnostic object is for benchmarks and debugging, not Web Platform
compatibility. Do not use it as a production behavior dependency.

## 8. Network, storage, profiles, and resources

- `src/runtime/network/` and `src/core/browser/HttpClient.zig` own transfer
  scheduling, curl handles, HTTP policy, cache, redirects, headers, body
  ownership, and cancellation.
- `src/runtime/storage/` owns SQLite/profile persistence and storage state.
- `src/runtime/profile/` owns persistent profile bundles, cookies, local state,
  fingerprint inputs, and policy configuration.
- `ResourceController.zig` owns process-level admission and RSS/VMS/resource
  policy. It must not silently alter browser semantics to improve a benchmark.
- `ArenaPool.zig` and frame/call arenas must have one owner and a terminal
  release/reset path.

Network and profile behavior must remain declarative and site-independent.
Never branch on hostname, product name, framework, CSS class, DOM ID, or page
markup shape.

## 9. Protocols and external APIs

### CDP

CDP lives under `src/protocols/cdp/`. `CDP.zig` coordinates transport,
connections, targets, sessions, and domain dispatch. Domain implementations
should be faithful projections of the engine.

Policy: freeze CDP feature expansion unless a CDP defect directly blocks core
testing or exposes a confirmed core lifecycle failure. Do not move browser
semantics into CDP just to raise a protocol benchmark score.

### MCP

MCP lives under `src/protocols/mcp/`. Tools for navigation, evaluation,
extraction, semantic trees, forms, and actions must delegate to core browser
behavior. MCP handles are generation-scoped and must not outlive their owning
page/document.

### CLI and SDK

`src/adapters/cli/main.zig` exposes fetch/server/MCP/profile commands. The
TypeScript SDK is a separate repository and communicates through CDP; do not
couple core internals to SDK implementation details.

## 10. Testing and benchmark workflow

### Standard commands

```bash
# Normal build
zig build

# ReleaseFast production-like build
zig build -Doptimize=ReleaseFast

# Full Zig tests
zig build test -Doptimize=ReleaseFast

# Rust layout tests
cargo test --manifest-path src/core/layout/Cargo.toml

# Deterministic benchmark
zig build benchmark -Doptimize=ReleaseFast -- \
  --suite startup,navigation,session-lifecycle,dom-js \
  --baseline koko-cdp --warmup 5 --iterations 30
```

Use the exact same binary/profile/workload/resource policy for before/after
comparisons. Record raw JSONL and the generated Markdown report. A one-sample
quick run is for smoke testing, not for claiming a performance regression or
improvement.

### Test priority

1. Focused unit tests for the changed owner.
2. Deterministic local HTML/browser regression fixture.
3. Rust layout tests when Stylo/Taffy/Parley is involved.
4. Full `zig build test`.
5. Relevant WPT and Chromium differential tests with matched viewport,
   lifecycle, and wait conditions.
6. Real websites only as integration evidence, never as the sole regression
   test.

Current local evidence at the last architecture verification:

- Rust layout crate: 23/23 tests passed.
- Full ReleaseFast suite: 796/835 passed, 39 failed, 122 skipped.
- Remaining failures are concentrated in iframe/document lifecycle,
  scheduler/microtask ordering, Worker/PromiseRejection, CSSStyleSheet, ICE,
  and some CDP/MCP cases. Treat these as backlog evidence, not as permission
  to weaken assertions.

WPT availability and external runner configuration must be checked before
claiming WPT results. Do not report a suite as passed when it was unavailable.

## 11. Known bottlenecks and safe priorities

### Highest-value architectural work

1. Make layout synchronization dependency-aware: stable DOM/layout mapping,
   dirty style/structure/text/viewport tracking, affected-ancestor/sibling
   propagation, and safe node removal/reparenting.
2. Reduce Stylo-to-Taffy string serialization and per-property FFI calls with a
   batched typed projection that preserves CSS unit and inheritance semantics.
3. Add deterministic mutation-heavy layout benchmarks that read diagnostic
   metrics and measure full versus incremental flush cost.
4. Add font-loading/discovery generation to Parley cache invalidation and use a
   bounded eviction policy that does not invalidate unrelated entries.
5. Fix lifecycle/scheduler failures in the owning Frame/realm/task component;
   do not patch them in CDP or exporters.

### Work that is already separated

- Ordinary DOM invalidation does not imply stylesheet snapshot reconstruction.
- CSSOM/stylesheet/adopted-sheet changes use stylesheet invalidation paths.
- CSSOM reads and geometry/layout preparation are distinct paths.
- Taffy and Parley are not production layout substitutes for Zig DOM ownership.

## 12. Change protocol for future agents

Before editing:

1. Read this file and `AGENTS.md`.
2. Use codebase-memory to locate the symbol, callers, call path, and ownership
   boundary. If the index is stale, read the source and re-index before making
   broad claims.
3. Inspect the implementation, callers, terminal cleanup paths, related tests,
   and architecture/bug notes.
4. State the broken invariant and reproduce it with a deterministic fixture.

While editing:

1. Assign one owner to each subsystem and avoid overlapping architectural
   rewrites.
2. Keep C ABI changes narrow, explicit, versioned, and batch-oriented.
3. Preserve one authoritative DOM and one production implementation of each
   responsibility.
4. Coalesce invalidations, but never remove required inheritance, selector,
   geometry, lifecycle, or teardown behavior.
5. Do not add site-specific logic, fake values, no-op APIs, sleeps, retries, or
   benchmark-only branches.

After editing:

1. Run formatting and focused tests.
2. Build once in the intended profile, then run the selected full validation
   batch against that binary.
3. Compare actual pass/fail counts and benchmark distributions, not anecdotes.
4. Record changed files, removed/retained implementations, limitations,
   performance counters, and remaining failures.
5. Update this document when the architectural truth changes.

## 13. Quick routing table

| Task | Start here | Do not start in |
|---|---|---|
| Navigation/teardown | `Frame.zig`, `Page.zig`, `Session.zig`, scheduler | CDP exporter |
| HTML parsing/DOM | `parser/`, `html5ever/`, `dom/` | Markdown/HTML dump |
| JavaScript/Promise/timer | `src/core/js/`, Frame realm lifecycle | MCP/CDP wrappers |
| CSS selector/cascade | `StyleEngine.zig`, Stylo bridge, CSSOM | Taffy layout |
| Layout/geometry | `Frame.flushLayout`, `LayoutEngine.zig`, Rust `lib.rs` | Synthetic geometry helpers |
| Text shaping | Rust `parley_adapter.rs`, layout measurement path | DOM text serializer |
| CSSOM | `src/core/webapi/css/`, StyleEngine invalidation | Protocol response formatter |
| IndexedDB/storage | `src/core/webapi/idb.zig`, runtime storage | CDP Storage domain |
| CDP parity | `src/protocols/cdp/domains/` only after core check | Core DOM implementation |
| Benchmark quality | `bench/runner.mjs`, `bench/suites/`, `bench/SPEC.md` | Ad hoc real-site timing |
