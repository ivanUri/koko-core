# Stylo integration

Koko keeps one authoritative DOM in Zig. Stylo owns CSS parsing, selector
matching, cascade, inheritance, custom properties, media evaluation, and
computed-style data through a small Rust bridge. Layout and painting remain
Zig responsibilities.

## Current branch status

The Stylo bridge, callback-backed DOM adapter, CSSOM integration, scoped
ShadowRoot styles, mutation invalidation, UA stylesheet, and teardown lifecycle
are active on this branch. `getComputedStyle()`, layout-property reads,
visibility, pointer-events, accessibility pruning, and rendered `innerText`
now consume Stylo computed values. Computed-style failures return an empty CSSOM
value plus an explicit diagnostic; no legacy value synthesis remains.

The handwritten `StyleManager` parser, selector matcher, specificity/cascade,
custom-property store, visibility resolver, pointer-events resolver, and layout
property resolver were removed after the differential gate passed. CSSOM
declaration parsing and stylesheet/rule object serialization remain because
they are Web API object behavior, not a replacement cascade engine.

## Ownership contract

- A `Frame` owns one style-engine instance.
- Rust stores style data and stylesheet state, never a second DOM tree.
- DOM identity is represented at the boundary by stable Koko node handles.
- DOM reads are callback-based and are only performed on the single-threaded
  owner thread during the first integration stage.
- Rust strings are copied into a Koko-owned arena before they are exposed to
  CSSOM or layout.
- CSSOM and DOM mutation paths invalidate the same engine generation.
- Navigation and frame teardown destroy the engine before the owning DOM arena.

## Rollout stages

1. Compile and link the pinned Stylo bridge with an explicit C ABI.
2. Synchronize stylesheets and DOM metadata while retaining the existing
   `StyleManager` for differential validation.
3. Flush Stylo computed values through `getComputedStyle()` and layout reads.
4. Compare cascade, inheritance, custom properties, media queries, pseudo
   elements, CSSOM mutation, UA defaults, shadow scopes, and invalidation
   against Chromium fixtures.
5. Remove the redundant handwritten cascade after parity and performance gates
   pass. Completed on this branch; the old engine is not retained at runtime.

## Safety constraints

The ABI must never allow Rust panics to unwind into Zig. Unsupported operations
return an explicit status; they must not return fabricated computed values.
Parallel traversal stays disabled until the DOM callback contract is proven
thread-safe. FFI calls should be batched around stylesheet and subtree updates
to avoid per-selector crossings.

## Build target policy

The Rust archive follows Koko's existing Cargo/static-library build. Build
integration must use an exact Stylo release or commit, a locked dependency
graph, and an explicit Rust target mapping for every supported Zig target.
Generated Cargo `target/` directories are build artifacts and must not be
committed.

## Validation and performance snapshot

The bounded matrix passes for both Koko and Chromium: selector combinators,
`!important`, custom properties, pseudo-elements, dynamic stylesheet mutation,
inline mutation, UA defaults, shadow scopes, and navigation teardown. The Rust
Stylo unit suite passes 5/5 tests. A WPT corpus/server is not present in this
checkout, so the external WPT gate remains pending; the local runner and
Chromium CDP adapters are available.

Using the same bounded workload (`32` CSS rules, `32` nodes, one style read),
the current cached-generation implementation measured approximately:

| Workload | Before | Current | Delta |
| --- | ---: | ---: | ---: |
| Full style read | 38.3 ms | 10.0 ms | -73.9% |
| Incremental style read | 7.2 ms | 10.2 ms | +41.7% |
| Startup | 258.4 ms | 183.6 ms | -29.0% |
| Ready RSS | 95.4 MiB | 96.7 MiB | +1.3 MiB |

The measurements are single-process bounded samples; rerun the benchmark with
more iterations before treating them as release-level performance numbers.
