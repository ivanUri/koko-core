# Koko Codebase Overview

> This document gives engineers and coding agents a reliable starting point
> before they modify Koko. It is an orientation guide, not a substitute for
> reading the relevant implementation, its callers, tests, and architecture
> notes. Read [`AGENTS.md`](AGENTS.md) before making changes.

## 1. What Koko Is

Koko is an AI-first, headless browser runtime written primarily in Zig. It
implements its own browser engine instead of embedding Chromium and is designed
for automation, agents, crawling, testing, and programmable web execution.

The project focuses on:

- deterministic navigation and event ordering;
- explicit browser, session, page, frame, and JavaScript-realm lifecycles;
- DOM, HTML, CSS/layout, Web API, storage, and networking behavior;
- CDP-compatible automation and MCP-native agent integration;
- persistent browser profiles and fingerprint configuration;
- lower-level control than a Chromium wrapper can provide.

Koko is not intended to be a desktop-browser replacement. Its primary product
surface is programmable browser infrastructure.

The repository currently contains roughly 500 Zig source files. The largest
subsystem is `src/core/webapi/`, followed by the browser, DOM, JavaScript,
network, profile, and protocol implementations.

## 2. Architectural Model

The source tree is organized into five main layers:

```text
Adapters / entry points
        |
Protocols (CDP and MCP)
        |
Browser runtime and services
        |
Core browser engine
        |
Support libraries and native dependencies
```

The directory layout is:

| Directory | Responsibility |
|---|---|
| `src/core/` | Browser behavior: pages and frames, DOM, parsing, V8 bindings, Web APIs, XPath, semantic trees, and browser actions. |
| `src/runtime/` | Process-level services: configuration, networking, storage, telemetry, profiles, lifecycle coordination, notifications, and arena pooling. |
| `src/protocols/` | Automation-facing protocols: CDP domains and MCP tools/resources. |
| `src/adapters/` | Executable entry points: CLI command dispatch and the CDP WebSocket server. |
| `src/public/` | Experimental Zig wrapper API. It is not yet the primary supported product API. |
| `src/support/` | Shared primitives, logging, crash handling, native interfaces, strings, allocators, and utility code. |
| `src/testing/` | Deterministic unit/integration test harness, local HTTP/WebSocket servers, and test runner. |
| `src/browser/tests/` | Local HTML fixtures used by browser, Web API, CDP, MCP, and lifecycle tests. |
| `src/data/` | Generated or embedded data, including the public suffix list. |

The actual dependency graph confirms these boundaries: the CLI, CDP, and MCP
packages are entry layers with mostly outbound calls, while `browser`, `dom`,
`js`, `webapi`, `network`, and `profile` are the high-fan-in engine packages.
CDP is the broadest protocol adapter because it coordinates browser, DOM,
JavaScript, network, profile, and Web API state.

## 3. Runtime Ownership

Understanding ownership is more important than memorizing individual functions.
The main runtime objects are:

```text
App
├── Network
├── Storage and telemetry services
├── ArenaPool
└── configuration and embedded resources

Browser
├── V8 environment / isolate
└── Session
    ├── notification and scheduler state
    └── Page / top-level Frame
        ├── Document and DOM tree
        ├── Window and JavaScript realm
        ├── EventManager
        ├── parser and script managers
        └── child Frames
```

Important ownership rules:

- `App` owns process-wide services and the shared arena pool.
- A `Browser` owns its V8 isolate and must be created, used, and destroyed on
  the same thread.
- A `Session` owns browsing-session state, including pages, cookies, scheduling,
  and protocol-visible page selection.
- A page/frame generation owns its document, realm, event state, resource
  handles, and navigation-scoped work.
- Navigation invalidates stale document/realm state. Code must not retain
  pointers or callbacks across generations without an explicit validity
  contract.
- Every acquired arena, response, listener, task, handle, and native resource
  must have one owner and one terminal release path.

Do not repair ownership defects with sleeps, retries, exporter cleanup, or
post-processing. Fix the component that owns the violated invariant.

## 4. Executable Modes and Public Surfaces

The executable entry point is `src/adapters/cli/main.zig`. Configuration and
command parsing live in `src/runtime/Config.zig`.

Koko supports these command modes:

| Command | Purpose |
|---|---|
| `koko fetch` | Navigate one page, wait for a lifecycle condition, and optionally dump HTML, Markdown, or another supported representation. |
| `koko serve` | Run the CDP-compatible HTTP/WebSocket server. |
| `koko mcp` | Run an MCP server over stdio, optionally with a local CDP endpoint. |
| `koko profile` | Create, list, import, export, and manage persistent browser profiles. |
| `koko help` / `koko version` | CLI metadata and usage. |

The main supported automation surfaces are:

1. **CDP server** — implemented in `src/protocols/cdp/` and exposed by
   `koko serve`.
2. **MCP server** — implemented in `src/protocols/mcp/` and exposed by
   `koko mcp`.
3. **CLI fetch path** — implemented by `src/koko.zig::fetch` and the CLI
   adapter.
4. **TypeScript SDK** — maintained in the separate
   [`ivanUri/koko-sdk`](https://github.com/ivanUri/koko-sdk) repository and
   communicates with the engine through CDP.

The wrappers under `src/public/` are experimental. Some methods are thin
wrappers while others are incomplete; do not assume this directory represents
the production SDK contract.

## 5. Navigation and Page Execution Flow

A typical `koko fetch` operation follows this path:

```text
CLI main
  -> Config.parseArgsInPlace
  -> App.init
  -> fetch worker thread
  -> Browser.init
  -> Browser.newSession
  -> Session.createPage
  -> Frame.navigate
  -> network request pipeline
  -> response and HTML parser
  -> DOM construction
  -> script scheduling and V8 execution
  -> event loop / microtask checkpoints
  -> Runner.wait
  -> optional selector, click, or script wait
  -> HTML / Markdown / semantic output
  -> profile persistence and deterministic teardown
```

Key components to inspect for navigation-related work:

| Concern | Primary implementation area |
|---|---|
| Browser/session/page lifecycle | `src/core/browser/Browser.zig`, `Session.zig`, `Page.zig`, `Frame.zig` |
| URL parsing and mutation | `src/core/browser/URL.zig` |
| HTTP scheduling and transfers | `src/core/browser/HttpClient.zig`, `src/runtime/network/` |
| HTML parsing | `src/core/parser/`, `src/core/html5ever/` |
| JavaScript realms and V8 | `src/core/js/`, frame realm lifecycle code |
| Tasks and microtasks | `src/core/js/Scheduler.zig`, runner and frame tick paths |
| DOM events and activation | `EventManager.zig`, `InputController.zig`, `src/core/webapi/event/` |
| Cookies and storage | `src/core/webapi/storage/`, `src/runtime/storage/` |
| Persistent profiles | `src/runtime/profile/`, `src/runtime/profile_session.zig` |
| Serialization and extraction | `dump.zig`, `markdown.zig`, `src/core/semantic/` |

## 6. Protocol Architecture

### CDP

`src/protocols/cdp/CDP.zig` coordinates connections, targets, sessions, and
domain dispatch. Individual domains live under
`src/protocols/cdp/domains/`.

CDP is an adapter over engine state. A protocol fix should remain in CDP only
when the engine already behaves correctly and the defect is specifically in
CDP representation, identity, serialization, or command semantics. If the DOM,
navigation, event, network, or lifecycle behavior itself is wrong, fix the core
owner and keep CDP as a faithful projection.

### MCP

The MCP server lives under `src/protocols/mcp/`. It exposes navigation,
evaluation, extraction, semantic-tree, form, and browser-action tools. Actions
such as click, fill, hover, press, select, check, scroll, and selector waits must
delegate to browser-level behavior rather than reproduce DOM semantics in the
protocol layer.

MCP node identifiers are protocol handles over live engine nodes. They must be
treated as generation-scoped and invalidated when their owning page or document
is replaced.

## 7. Profiles, Fingerprints, and Network Policy

Persistent profile behavior is implemented in `src/runtime/profile/` and
`src/runtime/profile_session.zig`. Runtime profile data is stored under a
Chrome-style user-data directory and can include cookies, local storage,
fingerprint assets, HTTP behavior, and navigation policy.

Repository-level profile data lives under:

- `browser/fingerprints/` — fingerprint bundles and captured assets;
- `browser/policies/` — declarative runtime policies and policy plugins.

Profile and anti-detect behavior must remain declarative and site-independent.
Never add production branches based on a hostname, product name, DOM shape, or
third-party challenge implementation. A site may expose a browser defect, but
the fix must be stated as a browser, networking, lifecycle, or serialization
invariant.

## 8. Building and Testing

### Build

```bash
zig build
```

The executable is written to:

```text
zig-out/bin/koko
```

Common local commands:

```bash
./zig-out/bin/koko fetch --dump html https://example.com/
./zig-out/bin/koko serve --host 127.0.0.1 --port 9222
./zig-out/bin/koko mcp
./zig-out/bin/koko profile list
```

Use `koko help` or inspect `src/runtime/Config.zig` for the authoritative
option list. Do not guess option names from old scripts or notes.

Koko currently targets Zig 0.15.2. `build.zig` defaults to stripped binaries,
including Debug builds, as a workaround for Zig/LLVM debug-type crashes. For a
diagnostic build, `-Dstrip=false` may provide better stack information, but it
can re-expose the compiler issue documented in
[`knowledge/codebase-map/build-and-dependencies.md`](knowledge/codebase-map/build-and-dependencies.md).

### Unit and Integration Tests

```bash
zig build test
```

`src/koko.zig` uses `std.testing.refAllDecls` so the build discovers tests
through the imported source graph. The custom runner supports:

```bash
TEST_FILTER='NavigationPlanner' zig build test
TEST_VERBOSE=0 zig build test
```

Tests that need browser behavior should use deterministic local fixtures and
the infrastructure in `src/testing/`. Do not make a third-party website the
only regression test.

Recommended validation order:

1. run the smallest deterministic test that reproduces the invariant;
2. run the relevant subsystem or filtered tests;
3. run the complete `zig build test` suite;
4. use a real website only as an integration check.

## 9. Debugging Guidance

For runtime behavior, start with structured logs:

```bash
./zig-out/bin/koko fetch \
  --dump html \
  --log-level debug \
  --log-dir /tmp/koko-log \
  https://example.com/
```

Useful evidence includes:

- request start, headers, response completion, cancellation, and connection
  release in network logs;
- frame and navigation generations;
- realm creation and destruction;
- task queue and microtask checkpoints;
- retained arenas or handles during teardown;
- protocol request/response traces when the engine result and protocol result
  differ.

Do not infer an anti-bot or fingerprint failure solely from a blank page, a
timeout, or an HTTP status. First establish whether the network transfer,
parser, script scheduler, event loop, and lifecycle reached their expected
terminal states.

Because default binaries are stripped, a panic may not include source line
information. Use an unstripped build when it compiles reliably, or run the
binary under LLDB and correlate the result with structured logs and deterministic
tests.

## 10. Engineering Rules

[`AGENTS.md`](AGENTS.md) is authoritative. The essential rules are:

- Read the relevant implementation, surrounding callers, lifecycle ownership,
  existing tests, and architecture/bug notes before changing code.
- State the violated web-platform or browser invariant before implementing a
  browser-behavior fix.
- Fix the lowest correct, site-independent abstraction.
- Never branch on a website hostname, URL, product name, CSS selector, DOM
  shape, or framework fingerprint.
- Preserve success, failure, cancellation, navigation, timeout, shutdown, and
  stale-realm terminal paths.
- Give every resource exactly one owner and one terminal release path.
- Define cache keys, generations, and invalidation contracts explicitly.
- Add deterministic regression coverage for every fix.
- Report remaining failures separately; do not hide them with sleeps,
  retries, fallback CSS, DOM rewriting, or exporter post-processing.

If a proposed fix cannot be explained without naming the site that exposed it,
redesign the fix around the underlying browser invariant.

## 11. Repository Map

| Path | Contents |
|---|---|
| `knowledge/` | Architecture decisions, bug investigations, browser research, automation notes, and technical write-ups. |
| `knowledge/codebase-map/` | Deeper subsystem maps covering the core engine, runtime/networking, protocols/adapters, build system, and known invariants. |
| `docs/` | User-facing installation, packaging, TLS, and benchmark documentation. |
| `scripts/` | Development utilities for exporting pages, profiles, fingerprints, benchmarks, and bulk checks. |
| `browser/` | Declarative fingerprint bundles and runtime policies. |
| `packaging/` | Distribution and Homebrew packaging files. |
| `vendor/` | Vendored native dependencies and local patches. |
| `dist/` | Packaged release artifacts when present. |
| `exports/`, `export-logs/` | Generated integration outputs and logs; these are evidence/artifacts, not engine source. |
| `.koko-cache/` | Large bootstrapped dependency cache, including V8/depot_tools data. |
| `.zig-cache/` | Regenerable Zig build cache. |
| `.github/workflows/` | Release and repository automation. |

The Node.js files in this repository support development and export tooling;
the browser engine itself is the Zig binary.

## 12. Documentation Maintenance

Update this overview when:

- a major subsystem or public execution mode is added or removed;
- ownership boundaries or navigation/realm lifecycle architecture changes;
- CDP, MCP, or the supported SDK surface changes materially;
- build or test entry points change;
- profile or storage architecture changes.

Record focused bug investigations under `knowledge/bugs/` and architectural
decisions under `knowledge/architecture/`. Before documenting a newly discovered
failure, search those directories for existing work on the same invariant.
