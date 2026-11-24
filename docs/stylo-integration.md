# Stylo integration

Koko keeps one authoritative DOM in Zig. Stylo owns CSS parsing, selector
matching, cascade, inheritance, custom properties, media evaluation, and
computed-style data through a small Rust bridge. Layout and painting remain
Zig responsibilities.

## Current branch status

This branch has completed the build/ABI and lifecycle phase: the pinned Stylo
bridge parses and stores stylesheet sets, synchronizes opaque node metadata,
tracks invalidation generations, and links into the Koko executable. The
callback-backed `TElement` traversal and computed-style flush are still gated;
until that adapter is complete, computed-style reads report the explicit Stylo
status and use Koko's differential legacy path. No fabricated Stylo values are
returned, and the legacy path must be removed after cascade parity is proven.

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
   elements, CSSOM mutation, and invalidation against Chromium/WPT fixtures.
5. Remove the redundant handwritten cascade after parity and performance gates
   pass. The old engine is not a permanent parallel implementation.

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
