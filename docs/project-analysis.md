# Velora - Project Analysis

> **Date:** May 19, 2026 | **Version:** 1.0.0-dev | **License:** AGPL-3.0-only

---

## 1. Overview

Velora is an **AI-first headless browser runtime** written in **Zig**, designed for browser automation, AI agents, crawling, testing, and programmable web execution. It intentionally avoids Chromium, building a lightweight, embeddable engine focused on deterministic, multi-session, automation-native execution.

---

## 2. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Core Language | Zig | 0.15.2+ |
| JS Engine | V8 (zig-v8-fork) | 14.0.365.4 / v0.4.5 |
| HTML Parser | html5ever (Rust) | via Cargo |
| HTTP/Network | libcurl | 8.18.0 |
| TLS | BoringSSL | via boringssl-zig |
| HTTP/2 | nghttp2 | 1.68.0 |
| Compression | zlib, Brotli | 1.3.2, 1.2.0 |
| Database | SQLite3 | 3.51.0 |
| IDN | libidn2 | 2.3.8 |
| SDK | TypeScript + Node.js | >= 20 |
| Container | Docker (multi-stage, Debian slim) | - |
| Nix | flake.nix (FHS env) | nixpkgs 25.05 |

---

## 3. Architecture

### 3.1 Layer Stack (Strict Bottom-Up)

```
support/       → Generic utilities (logging, strings, IDs, crash handlers)
    ↑
core/          → Browser engine, DOM, JS bindings, parser, Web APIs, semantic tree
    ↑
runtime/       → Lifecycle, config, arena pools, network, storage, telemetry
    ↑
protocols/     → CDP and MCP protocol implementations
    ↑
adapters/      → CLI and server entrypoints
    ↑
public/        → Stable public API surface
    ↑
velora.zig     → Public facade (API veneer only, no internal imports allowed)
```

### 3.2 Key Rules

- `@import("velora")` is **forbidden** in all internal code (`core/`, `runtime/`, `protocols/`, `support/`, `testing/`)
- `core/` must not import from `runtime/`, `protocols/`, `adapters/`, `public/`
- `runtime/` must not import from `adapters/` or public facade
- `support/` must not import any product layer
- `public/` must not expose internal pointers, JS values, or protocol internals

---

## 4. Source Structure

### `src/core/` — Browser Engine (~296 items)

- **`browser/`** (25 files) — Browser, Session, Frame (~170K lines), Page, URL (~68K), HttpClient (~55K), event/script/style managers, dump/markdown/links/actions/forms/interactive/structured_data extractors
- **`dom/`** (13 files) — Node, Element, Document, DocumentFragment, DOMParser, DOMTreeWalker, DOMException, etc.
- **`js/`** (31 files) — V8 bindings: Env, Context, Isolate, Value, Local, Function, Object, Promise, Module, Snapshot, Platform, Inspector, Scheduler, Caller, bridge
- **`parser/`** (2 files) — HTML parsing
- **`html5ever/`** (5 files) — Rust-based HTML5 parser (Cargo: lib.rs, sink.rs, types.rs)
- **`webapi/`** (219 files) — Web APIs: Window, History, Location, Navigator, Console, Timers, Event/EventTarget, MutationObserver, IntersectionObserver, fetch, WebSocket, Storage, Crypto, Encoding, Streams, Canvas, ~76 HTML element types, ~20 event types
- **`semantic/`** (1 file) — SemanticTree

### `src/runtime/` — Runtime Services (26 files)

- `App.zig` — Lifecycle: init → start/run → stop → deinit
- `Config.zig` (~27K lines) — CLI config: HTTP proxy, timeouts, concurrency, TLS, CDP, logging, storage, WebDriver BiDi, MCP
- `RealmLifecycleKernel.zig` — Realm/execution context isolation
- `ArenaPool.zig` — Memory arena pooling
- `Notification.zig` — Event notification system
- `cookies.zig` — Cookie management
- `network/` (13 files) — HTTP client, WebSocket, fetch, proxy, WebBot auth
- `storage/` (5 files) — localStorage, sessionStorage, SQLite backend
- `telemetry/` (2 files) — Metrics and observability

### `src/protocols/` — Protocol Layer (30 files)

- **`cdp/`** (24 files) — Chrome DevTools Protocol: CDP.zig (~47K), Node.zig, AXNode.zig (~62K), domains/ (Page, Network, Runtime, DOM, Input, etc.)
- **`mcp/`** (5 files) — Model Context Protocol integration for AI agents

### `src/adapters/` — Entrypoints (4 files)

- `cli/main.zig` — CLI entrypoint (velora binary)
- `server/Server.zig` — CDP-compatible HTTP+WebSocket server

### `src/public/` — Public API (4 files)

- `Runtime.zig` — Stable Runtime wrapper
- `Browser.zig`, `Session.zig`, `Frame.zig` — Public wrappers

### `src/support/` — Utilities (12 files)

- `log.zig`, `string.zig`, `cli.zig`, `crash_handler.zig`, ID generation, etc.

### `src/testing/` — Test Infrastructure (4 files)

- `test_runner.zig` — Custom test runner

---

## 5. Build System

### Build Targets

| Command | Description |
|---------|-------------|
| `zig build` | Default: format check + build debug |
| `zig build run -- serve --host 127.0.0.1 --port 9222` | Run CDP server |
| `zig build test` | Run unit tests |
| `zig build check` | Check compilation |
| `zig build extras` | Build snapshot_creator + legacy_test |
| `zig build snapshot_creator -- src/snapshot.bin` | Generate V8 snapshot |
| `zig build version` | Print version info |

### Build Options

- `-Doptimize=ReleaseFast` / `-Doptimize=Debug`
- `-Dprebuilt_v8_path=<path>` — Use prebuilt V8 library
- `-Dsnapshot_path=<path>` — V8 snapshot path
- `-Dtsan` / `-Dasan` / `-Dcsan` — Sanitizers
- `-Dwpt_extensions` — WPT driver extensions

### Makefile Shortcuts

- `make build` — Release build with V8 snapshot
- `make build-dev` — Debug build
- `make run` / `make run-debug` — Build and run server
- `make test` — Run tests with output filtering

---

## 6. SDK (`sdk/`)

TypeScript-first CDP SDK (`@velora/sdk` v0.1.0), talks directly to Velora over WebSocket CDP:

- **`transport/`** — WebSocket CDP transport with request IDs, timeout handling
- **`cdp/`** — Client/session/event/error layer with flattened session routing
- **`browser/`** — Browser/Page/Context abstraction, wait strategies, network tracking
- **`cli/`** — `velora-fetch` CLI tool

```ts
import { Browser } from "@velora/sdk";
const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "load" });
console.log(await page.content());
await browser.close();
```

---

## 7. Testing

### Unit Tests
- `zig build test` using custom test runner (`src/testing/test_runner.zig`)

### Lifecycle Tests (`tests-lifecycle/`)
- 20+ semantic test scenarios for browser lifecycle correctness
- Each scenario: `index.html` + `expected.json` oracle
- Tests: realm isolation, WindowProxy semantics, navigation ordering, microtask scheduling, mutation observer teardown, custom element lifecycle, iframe detachment, promise navigation, timer navigation, etc.
- Chrome reference runner available (`run-lifecycle-chrome.js`)

### WPT Tests
- Web Platform Tests integration via Playwright (`code-check/wpt-smoke-runner.js`, `wpt-suite-runner.js`)
- `npm run test:wpt:smoke`, `test:wpt:file`, `test:wpt:suite`, `test:wpt:compare`

---

## 8. Docker Deployment

Multi-stage Docker build:
1. **Stage 0:** Build environment (Debian slim + Zig + Rust + V8 prebuilt lib)
2. **Stage 1:** `tini` init system
3. **Stage 2:** Minimal runtime with `velora` binary + CA certs

Exposes port 9222. Uses `tini` as PID 1 for proper signal handling.

```bash
docker run -p 9222:9222 velora
```

---

## 9. Key Design Decisions

1. **Zig over C++/Rust** — Low-level control with modern safety, no GC, compile-time metaprogramming
2. **V8 over custom JS engine** — Full ECMAScript compliance, proven performance
3. **html5ever (Rust) for parsing** — Battle-tested HTML5 parser from Servo
4. **libcurl for networking** — Mature, well-tested HTTP stack with proxy/TLS/HTTP2 support
5. **CDP compatibility** — Interop with existing automation tooling (Playwright can connect)
6. **MCP support** — Native AI agent integration protocol
7. **Strict layer separation** — Prevents circular dependencies, enables embeddability
8. **Realm-aware execution** — Proper execution context isolation for multi-session safety

---

## 10. Current Development Phase

**Architecture stabilization** — The project is refactoring internal dependencies to enforce strict layer boundaries. Priorities:

1. Remove all internal `@import("velora")` usage
2. Stabilize `zig build`
3. Clean ownership and arena/lifecycle leaks
4. Add capability work (images, canvas, video)
5. Expand SDK/API documentation

---

## 11. Use Cases

- AI agents and autonomous browsing
- Browser automation and orchestration
- Crawling and scraping infrastructure
- Workflow automation
- Testing platforms
- Cloud browser runtimes
- Embedded browser execution
- MCP/CDP-based tool integrations
