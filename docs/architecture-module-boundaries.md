# Koko Core module-boundary audit

Status: read-only audit, 2026-11-24. No source implementation was changed by
this audit.

## Executive finding

`src/koko.zig` is currently both the build module root and a broad internal
umbrella. Every `pub const` in that file is exported by the `koko` Zig module,
so it is a de-facto public API even when the exported value is an internal
implementation type. The most actionable coupling defect is the reverse import
in `src/adapters/server/Server.zig`:

```text
src/koko.zig -> adapters/server/Server.zig -> @import("koko")
```

`build.zig:82` explicitly enables this cycle with
`mod.addImport("koko", mod)`. That is a useful compatibility escape hatch, but
it makes the server depend on the entire umbrella and prevents the dependency
graph from expressing the actual server boundary.

The safe first cut is to remove the umbrella dependency from `Server.zig` and
replace only the symbols it uses with direct imports. Do not perform a blanket
replacement in the CLI or legacy test targets: those are executable roots that
mix many types from the umbrella, and a partial conversion can introduce
duplicate module/type identities or leave the public facade inconsistent.

## Current umbrella surface

`src/koko.zig:2-39` exports the following groups:

| Group | Current exports | Boundary assessment |
|---|---|---|
| Nominal public facade | `Runtime` | Intended public API, but not currently enforced by a dedicated consumer test. |
| Core browser implementation | `Browser`, `Session`, `Frame`, `URL`, `dump`, `markdown`, `links`, `actions`, `forms`, `interactive`, `structured_data` | Internal implementation types are exported directly. This is public in Zig terms, but not a stable abstraction boundary. |
| Runtime | `Config`, `App`, `Network`, `Notification`, `RealmLifecycleKernel`, `cookies`, `profile_session`, `profile_cmd` | Used by the CLI and server; keep available until a narrower application facade exists. |
| Server/protocol | `Server`, `CDP`, `MCP`, `mcp`, `ToolRegistry`, `ActionJournal`, `WorkflowRunner` | Operational APIs; `Server` and `CDP` are especially coupled to internal lifecycle types. |
| Support | `io`, `sync`, `net`, `timer`, `log`, `crash_handler`, `String`, `js` | Mostly implementation utilities. Exporting them leaks process-global/runtime details. |
| Build | `build_config` | A named build-module dependency, not a file import. |

There is no separate package module that exposes only `src/public/*`. The
`public/` directory is a nominal facade, while the root exports the internal
`core/browser/*` types under the shorter names `Browser`, `Session`, and
`Frame`. Consumers therefore cannot infer from the root name whether they are
using the facade or the implementation type.

The facade also needs a contract test before it can be treated as the stable
API. For example, `src/public/Runtime.zig:21` calls `App.init(allocator)` while
the current implementation signature is `App.init(allocator, config)` at
`src/runtime/App.zig:62`. Because Zig analyzes declarations lazily, this kind
of stale method can remain hidden until a consumer instantiates or calls it.

## Reverse umbrella imports

### High-confidence safe cut: `Server.zig`

`src/adapters/server/Server.zig:1` imports `koko`. The actual uses are:

| Current use | Direct dependency |
|---|---|
| `v.App` | `@import("../../runtime/App.zig")` |
| `v.Config` | `@import("../../runtime/Config.zig")` |
| `v.log` | `@import("../../support/log.zig")` |
| `v.net` | `@import("../../support/net.zig")` |
| `v.io` | `@import("../../support/io.zig")` |
| `v.build_config` | Keep `@import("build_config")`; it is supplied by `build.zig` and has no relative-file equivalent. |

`CDP`, `WsConnection`, `CDPClient`, `sync`, `posix`, and datetime are already
direct imports in the same file. The proposed refactor is therefore local and
mechanical: replace the five symbol aliases and the two `v.io` calls, remove
the umbrella import, and leave all public function signatures unchanged.

Why this cut is safe:

1. `src/koko.zig` imports `Server.zig`, so the current umbrella import is a
   genuine reverse edge.
2. The server does not need the umbrella's browser/export convenience API.
3. `Server` is already a concrete internal adapter type; no consumer-facing
   type needs to be migrated as part of this cut.
4. Removing this edge makes `mod.addImport("koko", mod)` unnecessary for the
   server path, although it should not be removed until all other consumers
   have been checked.

### High-confidence safe cut: `Sighandler.zig`

`src/adapters/cli/Sighandler.zig:20` uses only `v.log` and `v.sync`. Replace
them with direct imports of `../../support/log.zig` and
`../../support/sync.zig`. This file is not imported by `src/koko.zig`, so it
does not participate in the root cycle. Keep this as a separate small commit
from the server cut.

### Medium-confidence cut: `test_runner.zig`

`src/testing/test_runner.zig:16-18,32-33,223,393` uses only `sync`, `timer`,
and `io` from the umbrella. Direct support imports are conceptually safe and
do not cross core browser type boundaries. Validate with the actual
`zig build test` target because this file is injected as the test runner by
`build.zig:224`, rather than being a normal source dependency of the root
module.

### Keep umbrella usage for now: CLI and legacy test roots

`src/adapters/cli/main.zig` consumes a mixed set of types and functions:
`App`, `Browser`, `Config`, `Server`, `Network`, `Notification`, `FetchOpts`,
`fetch`, MCP, profile helpers, support globals, and build metadata. It is the
application composition root, so using the package facade there is reasonable.
Do not replace individual imports such as `App` or `Browser` while retaining
`fetch` and `FetchOpts` from `koko`; that is the high-risk partial-conversion
case.

`src/main_legacy_test.zig` similarly mixes `Config`, `App`, the internal
`Browser`/`Session`/`Frame` types, `js`, logging, and IO. Leave it on the
umbrella until it is either retired or migrated as one coherent executable
facade.

`src/main_snapshot_creator.zig` uses only `koko.js`. It could use a direct
`core/js/js.zig` import, but this is low value and should be done only if the
project decides that every executable root must avoid the umbrella.

## Circular-dependency risks

The relevant current edges are:

```text
build.zig
  └─ module "koko" -> src/koko.zig
       ├─ -> adapters/server/Server.zig
       │    └─ -> module "koko"       (current reverse edge)
       ├─ -> runtime/App.zig
       ├─ -> protocols/cdp/CDP.zig
       └─ -> support/*

CLI/test executable roots
  └─ -> module "koko"                  (normal package-consumer edge)
```

The server reverse edge is the only confirmed umbrella cycle in the current
source scan. `src/runtime/telemetry/telemetry.zig:25` imports a file named
`runtime/telemetry/koko.zig`; that is a local file import, not the named
umbrella module, and should not be treated as the same dependency.

Do not remove `mod.addImport("koko", mod)` solely because `Server.zig` is
fixed. Remove it only after a compile check proves that no source still uses
`@import("koko")` from inside the `koko` module. The current source scan finds
the server as the important internal case; executable roots still legitimately
consume the named module.

## Recommended boundary model

Use three layers rather than one giant umbrella:

```text
public facade (stable, small)
  -> application facade (CLI/server composition)
      -> internal core/runtime/protocol modules
          -> support and platform modules
```

Rules for the next refactor:

1. Internal modules must not import the root umbrella.
2. Executable roots may import the application facade, but should not expose
   support globals as part of their own API.
3. `src/public/*` should be either made build-tested and authoritative, or
   removed from the claimed public story; keeping two competing `Browser`,
   `Session`, and `Frame` surfaces is misleading.
4. Keep `build_config` as an explicit named module dependency.
5. Export fewer implementation modules from `src/koko.zig` only in a planned
   API transition; removing a `pub const` is a breaking change for Zig package
   consumers.

## Integration order for the lead

1. Refactor `Server.zig` to direct imports only. Run `zig fmt --check`,
   `zig build check`, and the CDP/handshake tests.
2. Refactor `Sighandler.zig` separately. Run the executable check.
3. Optionally refactor support-only imports in `test_runner.zig`. Run the real
   test target, not only the library check.
4. Add a small public-facade compile test that constructs `Runtime`, `Browser`,
   `Session`, and `Frame`; this will expose the stale facade/API mismatch.
5. Only after those checks consider shrinking root exports or changing
   `build.zig` module wiring.

## Test matrix

The minimum validation for the safe cuts is:

```text
zig fmt --check src/adapters/server/Server.zig src/adapters/cli/Sighandler.zig
zig build check
zig build test
zig build extras
node --test bench/tests/*.test.mjs
```

The first three checks catch import resolution and type identity issues. The
extras target covers `snapshot_creator` and `legacy_test`, which are separate
roots in `build.zig`. The Node tests are not a substitute for Zig module
compilation, but protect the runtime behavior after the dependency-only edit.
