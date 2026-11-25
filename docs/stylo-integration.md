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

The boolean ABI callbacks for computed `visibility` and `pointer-events` are
now wired end-to-end. Layout and actionability still use the serialized
computed-value path so CSSOM, layout, and interaction observe one Stylo result.

Adopted stylesheet arrays are also checked for live JS mutations. Direct
operations such as `document.adoptedStyleSheets.length = 0` and
`shadowRoot.adoptedStyleSheets.pop()` do not invoke the property setter, so the
bridge fingerprints the current sheet identities before reusing a cached Stylo
stylesheet snapshot. Shadow scopes read the live JS array during preparation;
the native list remains an ownership/lifetime index.

## Build target policy

The Rust archive follows Koko's existing Cargo/static-library build. Build
integration must use an exact Stylo release or commit, a locked dependency
graph, and an explicit Rust target mapping for every supported Zig target.
Generated Cargo `target/` directories are build artifacts and must not be
committed.

## Validation and performance snapshot

The 12-fixture differential suite passes for both Koko and Chromium: adopted
stylesheets, cascade, class mutation, custom properties, dynamic stylesheets,
`!important`, inheritance, inline styles, stylesheet lifecycle, media queries,
pseudo-elements, and shadow roots. The differential runner strips fixture
scripts and executes the same evaluator after navigation so results measure the
CSS engine rather than Koko's current inline-script parsing behavior. The Rust
Stylo unit suite passes 5/5 tests.

A sparse WPT checkout at Stylo revision `0ab78ce9` was used to run a curated
12-file CSS subset through Koko's CLI fetch path (the Go CDP runner currently
checks immediately after `Page.navigate` and races external `testharness.js`).
The pre-CSSOM-fix aggregate was 5/12. Targeted reruns after the current patch
now pass the two focused CSSOM cases that were previously failing:

- `inline-style-001`: 5/5 subtests pass, including `margin` shorthand reads.
- `CSSGroupingRule-insertRule`: 7/7 subtests pass, including DOMException
  names/codes for `HierarchyRequestError`.
- `CSSStyleSheet`: 6/17 subtests pass; stylesheet registration and initial
  `cssRules` behavior pass. Remaining failures cover legacy `addRule()` /
  `removeRule()`, CSSRuleList same-object identity, and index semantics.
- `style-set-cssText`: stylesheet lookup and initial declaration pass; invalid
  value filtering still needs work.

The remaining curated-suite gaps include live media-query CSSOM parsing in
`update-media-feature`. `variable-supports-05` is a reftest without a
testharness report, so it needs a visual/reftest comparator before it can be
scored; `is-default-ns-003` currently hits a Koko navigation crash.

This is a real WPT signal, not a completion gate: the WPT corpus is curated,
not the full suite, and the remaining failures are explicitly tracked below.

The full Zig test step currently includes unrelated iframe/history/network
regressions that time out in this checkout. Stylo-specific DOM lifecycle and
navigation-teardown tests pass, as do the targeted Rust and differential suites.

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
