# CDP architecture extraction audit

Status: read-only audit, 2026-11-24. This document intentionally does not change
production source or propose a full rewrite.

## Conclusion

`src/protocols/cdp/CDP.zig` is a valid working integration boundary, but it now
contains four different lifecycles:

1. transport and wire dispatch;
2. one V8/HTTP browser worker;
3. one logical CDP BrowserContext and its Session/Page state;
4. protocol command DTOs and domain dispatch.

The extraction is worthwhile for maintainability and for the later resource
controller, but it is not a cold-start optimization by itself. The safe design
is composition around a narrow host interface, not three structs that directly
import each other.

## Evidence from the current ownership graph

- `Server` stores `*CDP` for both pending transport-only sockets and upgraded
  workers (`src/adapters/server/Server.zig:35-64`). The coordinator must never
  create or touch V8 state.
- `CDP.initTransport` creates the four connection arenas and the WebSocket;
  `initBrowser` later creates `Browser`, `Env`, HTTP client, and inspector
  (`src/protocols/cdp/CDP.zig:99-157`). These are already two distinct phases.
- `CDP.tick` holds `Browser.tick_mutex` while it may run HTTP, macrotasks,
  microtasks, inspector work, and socket reads (`CDP.zig:275-303`). The mutex is
  a serialization guard, not permission to run one V8 isolate concurrently from
  multiple threads.
- `Browser` owns `Env`, `HttpClient`, optional `Session`, page pool, and the
  `tick_mutex` (`src/core/browser/Browser.zig:54-78`). `Session`, `Page`, `Frame`,
  JS contexts, inspector globals, and HTTP callbacks form one nested lifetime.
- `BrowserContext.init` creates `Notification`, `Session`, inspector session,
  node registries, and registers callbacks whose `anyopaque` context is the
  `BrowserContext` itself (`CDP.zig:712-766`).
- `BrowserContext.deinit` must close the Session while the page is walkable,
  drain/abort intercepted requests, stop inspector, release worlds and
  registries, then release notification state (`CDP.zig:768-828`). Reordering
  these steps can leave V8 context or callback UAFs.
- Context disposal is deliberately deferred until command dispatch/evaluation
  unwinds (`CDP.zig:479-540`). Worker recycle is only legal after the context is
  gone and no page/transport callback aliases it (`CDP.zig:554-579`).
- Domains are tightly coupled to `CDP.Command`, `CDP.BrowserContext`, and many
  concrete fields (`src/protocols/cdp/domains/*.zig`). A direct file move would
  create a large, cyclic import change rather than a seam.

## Recommended target shape

```text
CdpConnection
  owns: WsConnection, message/notification/frame arenas,
        command dispatch, protocol IDs, optional BrowserContext
  borrows: BrowserWorker while upgraded

BrowserWorker
  owns: Browser, Env, HttpClient, V8 isolate, worker recycle counters
  owns no socket and no BrowserContext
  runs on exactly one upgraded CDP worker thread

BrowserContext
  owns: CDP target/session metadata, Session, inspector session,
        node/frame registries, isolated worlds, context-scoped arenas
  borrows: BrowserWorker and a narrow CdpContextHost
```

`CdpConnection` should be the only object that knows the wire transport. The
worker should expose lifecycle operations (`init`, `tick`, `close`, `recycle`)
but not send CDP JSON. `BrowserContext` should not import the concrete
connection type; that would recreate the cycle.

### The required seam

Introduce a small host/service contract between `BrowserContext` and the
connection, conceptually:

```text
CdpContextHost
  browser: *Browser
  app/config/profile access needed by Session setup
  context_arena: Allocator
  frame_arena: Allocator
  notification_arena: Allocator
  sendEvent(method, payload, session_id)
  sendInspector(raw_message)
  nextSessionId()
```

The exact Zig representation can be a concrete `ContextHost` struct with
function pointers or a small callback table. Do not use a broad `*CdpConnection`
back-reference as the seam. It would expose transport, dispatch, and mutable
connection state to every context operation and preserve the current coupling.

`Command` should depend on a protocol-facing host interface plus an optional
`*BrowserContext`, rather than embedding `*CDP`. Domain code then asks for
operations (`sendJSON`, `create/dispose context`, `nextSessionId`, `browser`)
instead of reaching through `cmd.cdp.*`.

## What should and should not move

### Good first extraction candidates

- transport lifecycle and wire read/write helpers;
- message arena and JSON input parsing;
- connection-level IDs and target auto-attach state;
- browser worker init/deinit/tick/page-wait/recycle policy;
- context creation/disposal safe-point orchestration;
- `BrowserContext` data and notification callback registration.

### Keep out of `BrowserWorker`

- WebSocket ownership or handshake state;
- CDP session/target IDs;
- `BrowserContext` registries and inspector reply session IDs;
- command dispatch and JSON serialization;
- global admission/resource budget decisions.

The current RSS high-water calculation is process-level despite the
`worker_*` naming (`CDP.zig:542-552, 581-587`). A future global resource
controller must remain above workers/connections; extraction must not turn this
ambiguous per-worker policy into another hidden owner.

### Keep together inside `BrowserContext` initially

Keep `Session`, node registry/search list, isolated worlds, inspector session,
notification handlers, frame-session map, captured response bodies, and
context-scoped emulation/interception state together for the first extraction.
They all share the same safe disposal boundary and callback lifetime. Splitting
these into separate services before the context seam is tested would increase
UAF risk without reducing meaningful coupling.

Do not extract `IsolatedWorld` into a worker-wide pool object. It owns V8
contexts and identities that are tied to a frame/context and must be destroyed
before the parent frame/context and isolate.

## Thread and V8 invariants

1. A pending connection owns transport only. No `Env`, `Browser`, inspector, or
   context allocation occurs before WebSocket upgrade.
2. One upgraded connection has one worker thread and one V8 isolate. All V8,
   inspector, Session/Page/Frame, and browser tick operations stay on that
   owner thread. `tick_mutex` remains a defensive serialization guard.
3. The handshake coordinator may only poll transport and mutate pending
   admission lists. It must not call `initBrowser`, `tick`, or domain dispatch.
4. `BrowserContext.deinit` runs while the Browser/Env is alive, after pending
   HTTP/interception callbacks are stopped and before inspector/session state is
   released.
5. Deferred context disposal cannot free Session/Page/Frame while command-owned
   fields, a V8 evaluation, a native transfer, or a notification callback still
   aliases them.
6. Worker recycle is legal only with no active context, no pending/zombie page
   transfer, no live inspector session, and no callback that can re-enter the
   old isolate. The new Browser/Env must be fully initialized before it is
   published.
7. A connection/worker/context back-reference must never outlive the owner;
   callback registration must be undone before the callback context is freed.
8. `WsConnection.deinit`, `Browser.deinit`, `BrowserContext.deinit`, and socket
   close remain ordered and idempotent on all partial-init error paths.

## Safe extraction commit order

Keep each step buildable and behavior-preserving:

1. **Characterization seam:** add lifecycle/ownership comments and tests for
   transport-only init, upgrade, context dispose, recycle, and shutdown. No
   type movement yet.
2. **Host contracts:** add `ContextHost`/protocol-facing callbacks and route
   `Command` send/event/session-ID operations through them while retaining
   compatibility aliases in `CDP.zig`.
3. **Extract `BrowserWorker`:** move only Browser init/deinit, tick/page-wait,
   and recycle. Keep the connection as the callback context until tests prove
   the worker has no transport dependency.
4. **Extract `BrowserContext`:** move the struct and notification/inspector
   callbacks behind `ContextHost`. Keep `CDP.BrowserContext` as a temporary
   alias so domains and tests migrate incrementally.
5. **Extract `CdpConnection`:** move transport, dispatch, connection IDs, and
   context safe-point orchestration. Keep `CDP.zig` as a compatibility facade.
6. **Migrate domains/imports:** replace `CDP.Command` and concrete field access
   with the narrow protocol types. Only after the import graph is acyclic should
   the facade be removed or reduced to public API exports.

Do not combine steps 3-5 into one commit. If a regression appears, the owner
boundary is otherwise impossible to identify.

## Invariant and regression tests

Add tests at the seam before moving implementation:

- transport-only connection never initializes V8 and deinitializes safely;
- failed transport/browser/context partial initialization releases every owned
  arena, notification, socket, and pool slot;
- handshake coordinator cannot make V8 allocations under a pending flood;
- one connection creates at most one live BrowserContext and rejects stale or
  foreign session IDs;
- dispose during `Runtime.evaluate`, navigation commit, intercepted request,
  or native transfer is acknowledged but freed only at the safe point;
- notification and inspector callbacks are silent/invalidated after context
  disposal and never target a recycled worker;
- recycle is rejected with an active context and succeeds after complete
  disposal; the new isolate has no old Session/Page/Context registrations;
- server shutdown drains pending transports and upgraded workers without a
  leaked socket, active thread, callback, or pool entry;
- debug-only owner-thread assertions cover `tick`, dispatch, context lifecycle,
  inspector send, and worker recycle;
- benchmark smoke gates retain cold-start, heavy-site, context-recycle, RSS/VMS,
  and admission metrics. Extraction must not be accepted on compile success
  alone.

## Final recommendation

Proceed with extraction, but treat it as a lifecycle/coupling refactor, not a
performance feature. The first production-value seam is `ContextHost` plus a
separate `BrowserWorker`; the global resource controller should remain above
both. Do not build a prewarm pool until these ownership and thread invariants
are explicit and tested.
