# Architecture

Velora is a refactored fork of Velora. The engine direction stays the same: a lightweight headless browser written in Zig. The architecture is different: internal code must not depend on the public facade.

The goal is to make the project usable as a browser runtime platform, not only as one executable.

## Core Rule

`src/velora.zig` is an API veneer only.

It may re-export stable public types, but it must not become a shared dependency hub for internal code. No internal module should import it with `@import("velora")`.

## Dependency Direction

Dependencies flow upward from low-level utilities to product entrypoints:

```text
support
  ^
core
  ^
runtime
  ^
protocols
  ^
adapters
  ^
public facade
```

The practical target is:

```text
support -> support only
core -> core + support
runtime -> runtime + core + support
protocols -> protocols + runtime + core + support
adapters -> adapters + protocols + runtime + public
public facade -> public re-exports only
```

## Layer Responsibilities

| Layer            | Owns                                                        | Must not do                                                          |
| :--------------- | :---------------------------------------------------------- | :------------------------------------------------------------------- |
| `support/`       | Generic utilities: logging, strings, ids, crash helpers     | Import `core`, `runtime`, `protocols`, `adapters`, or public facade  |
| `core/`          | Browser engine, DOM, JS, parser, Web APIs, semantic tree    | Import `runtime`, `protocols`, `adapters`, `public`, or `velora` |
| `runtime/`       | Lifecycle, config, arena pools, network, storage, telemetry | Import CLI/server adapters or public facade                          |
| `protocols/`     | CDP, MCP, automation/control protocols                      | Become the owner of engine behavior                                  |
| `adapters/`      | CLI and server entrypoints                                  | Own browser, network, storage, or engine logic                       |
| `public/`        | Stable SDK wrapper types                                    | Expose internal pointers, JS values, or protocol/runtime internals   |
| `velora.zig` | Public facade/re-export surface                             | Contain engine logic or be imported by internal code                 |
| `testing/`       | Test infrastructure and fixtures                            | Leak into production runtime code                                    |

## Forbidden Imports

These are architecture violations:

```text
core -> velora
core -> public
core -> runtime
core -> protocols
core -> adapters
runtime -> velora
runtime -> public
runtime -> adapters
support -> core/runtime/protocols/adapters/public/velora
```

The most important forbidden pattern is:

```zig
const lp = @import("velora");
```

inside internal files such as `src/core/**`, `src/runtime/**`, `src/protocols/**`, `src/support/**`, and `src/testing/**`.

## Why This Matters

Importing the facade from internal code inverts the dependency graph:

```text
core
  v
velora.zig
  v
public/runtime/core
```

That creates hidden coupling and can cause issues such as:

- duplicate type identity
- runtime cast failures
- circular graphs
- accidental rebuild cascades
- lifecycle behavior that depends on import order

## Correct Import Style

Internal code imports the specific module it needs, from the same layer or a lower layer.

Bad:

```zig
const lp = @import("velora");
const Node = lp.Node;
```

Good:

```zig
const Node = @import("../../dom/Node.zig");
const log = @import("../../../support/log.zig");
```

The exact relative path depends on the file location, but the dependency direction must stay valid.

## Public API Boundary

The stable API surface should stay small:

- `Runtime`
- `Browser`
- `Session`
- `Frame`
- `Config`
- `fetch`
- public errors

Public wrappers may hold internal state privately, but they must not expose internal pointers or low-level engine types directly.

Do not expose:

- JS runtime values
- DOM internals
- protocol node internals
- runtime service structs
- raw network/storage internals

## Ownership Rules

Ownership must be explicit at layer boundaries:

- `runtime/` owns lifecycle-level resources.
- `core/` owns engine objects and DOM/JS state.
- `public/` owns wrapper lifetime and forwards operations into runtime/core through stable methods.
- `adapters/` allocate/configure/start/stop, but do not own engine logic.
- `protocols/` translate external control messages into runtime/core operations.

When in doubt, keep ownership in the lower layer and expose a narrow operation instead of exposing the object.

## Lifecycle Rules

Runtime lifecycle should be centralized:

```text
init -> start/run -> stop -> deinit
```

Layer expectations:

- `adapters/` parse input and call public/runtime APIs.
- `runtime/` coordinates services and engine lifecycle.
- `core/` executes browser behavior and does not know how it was started.
- `protocols/` attach to a running runtime/session; they do not bootstrap the entire application unless an adapter asks them to.

## Stabilization Checklist

Use this checklist before adding new features:

- [ ] `rg '@import\("velora"\)' src` returns no internal violations.
- [ ] `core/` has no imports from `runtime/`, `protocols/`, `adapters/`, or `public/`.
- [ ] `runtime/` has no imports from `adapters/` or public facade.
- [ ] `support/` has no product-layer imports.
- [ ] `public/` does not expose internal pointers or JS values.
- [ ] `zig build` passes.
- [ ] Unit tests pass or known failures are documented.

## Current Priority

The current project phase is architecture stabilization. Dependency cleanup comes before new feature work.

Recommended order:

1. Remove internal `@import("velora")` usage.
2. Stabilize `zig build`.
3. Clean ownership and arena/lifecycle leaks.
4. Add capability work such as images, canvas, and video.
5. Expand SDK/API documentation after the boundaries compile cleanly.
