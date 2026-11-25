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

Stylo is the runtime source for computed style, layout-property reads,
visibility, pointer-events, and actionability. The handwritten cascade manager
is no longer a runtime dependency on this branch. CSSOM declaration parsing and
stylesheet/rule object serialization remain because they are Web API object
behavior, not a replacement cascade engine.

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
   pass. The remaining removal is gated on migrating the last layout,
   visibility, pointer-events, and UA-style call sites.

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

The 13-fixture differential suite passes for both Koko and Chromium: adopted
stylesheets, cascade, class mutation, custom properties, dynamic stylesheets,
`!important`, inheritance, inline styles, stylesheet lifecycle, media queries,
pseudo-elements, shadow roots, and CSSOM rule subtypes. The differential runner strips fixture
scripts and executes the same evaluator after navigation so results measure the
CSS engine rather than Koko's current inline-script parsing behavior. The Rust
Stylo unit suite passes 5/5 tests.

A sparse WPT checkout at Stylo revision `0ab78ce9` was used to run a curated
12-file CSS subset through Koko's CLI fetch path (the Go CDP runner currently
checks immediately after `Page.navigate` and races external `testharness.js`).
The pre-CSSOM-fix aggregate was 5/12. Targeted reruns after the current patch
now pass the focused CSSOM cases that were previously failing:

- `inline-style-001`: 5/5 subtests pass, including `margin` shorthand reads.
- `CSSGroupingRule-insertRule`: 7/7 subtests pass, including DOMException
  names/codes for `HierarchyRequestError`.
- `CSSStyleSheet`: 17/17 subtests pass, including legacy `addRule()` /
  `removeRule()`, `rules` alias identity, out-of-range index exceptions, and
  empty-rule serialization.
- `CSSStyleRule`: 10/10; CSSRule constants, `[PutForwards=cssText]`,
  `SameObject` style identity, and typed `parentStyleSheet` pass.
- `CSSConditionRule`: 1/1; `CSSMediaRule` now has the runtime prototype chain
  `CSSMediaRule → CSSConditionRule → CSSRule`.
- `CSSGroupingRule-cssRules`: 1/1; grouping `cssRules` now returns one live
  `CSSRuleList` object instead of a newly allocated JavaScript array.
- `CSSGroupingRule-insertRule-computed`: 1/1; nested insert/delete now
  invalidates the owning stylesheet and recomputes Stylo values.
- `CSSSupportsRule` / `CSSKeyframesRule` / `CSSKeyframeRule`: the new concrete
  prototype subtypes pass the dedicated differential fixture, including
  condition text, live child lists, parent links, keyframe style, append/find/
  delete, and CSSOM serialization.
- `CSSImportRule`: 12/12; href, media list normalization, supports text,
  stylesheet ownership, `parentStyleSheet`, layer imports, and canonical
  `cssText` pass. `CSSStyleSheet.media` now exposes the same live `MediaList`
  model.
- `CSSLayerBlockRule` / `CSSLayerStatementRule`: 9/9; named and anonymous
  layers, nested blocks, statement name lists, and import layer names pass.
- `CSSScopeRule`: 13/13; condition text, start/end selectors, grouping
  prototype, nested rules, and serialization pass.
- `CSSContainerRule`: 2/2; container name/query and condition text pass.
- `CSSRuleList.item()`: exposed as the CSSOM method in addition to indexed
  access, matching grouping-rule WPT expectations.
- `CSSPageRule`: 22/22; selector validation/normalization, empty-rule
  serialization, style declarations, and parent detachment pass.
- `CSSNamespaceRule`, `CSSFontFaceRule`, and `CSSCounterStyleRule`: 1/1 each;
  namespace URI/prefix serialization, newline-free descriptor serialization,
  concrete prototypes, and CSSRule type constants pass.
- `CSSKeyframesRule`: 3/3; name, live/indexed child access, duplicate-key
  lookup semantics, append/delete, and quoted-name serialization pass.
- `CSSKeyframeRule`: 2/2 plus `keyText`: 11/11; `from`/`to`, percentages,
  style `[PutForwards]`, and syntax-error handling pass.
- `CSSKeyframeRule-keyText-edge-cases`: 14/14; direct setters and dynamically
  appended stylesheet cases for `.5%`, `100.0%`, and `1e1%` pass after fixing
  stylesheet registration while document parsing is still active.
- `CSSKeyframesRule-appendRule-invalid`: 4/4; invalid or multiple entries are
  silently ignored as required by the CSS Animations CSSOM contract.
- `CSSKeyframesRule-deleteRule-detach`: 2/2; removed rules release their
  `parentRule` and `parentStyleSheet` links.
- `serialize-media-rule`: 12/12; canonical media condition and nested-rule
  serialization pass.
- `MediaList-parsing`: 13/13; `NotFoundError` now maps to a DOMException and
  medium normalization is covered. `MediaList.html` also passes, including
  the `mediaText = null` DOMString conversion edge case.
- `style-set-cssText`: 3/3; invalid declaration values are ignored while
  valid declarations and `!important` are retained.
- `update-media-feature`: 14/14; update capability values and invalid-value
  handling pass.

`CSSRule-type.html` now passes 14/14 assertions, including the zero-valued
CSSOM type behavior for layer, container, and scope rules.

The remaining curated-suite gaps are `variable-supports-05`, a reftest without a
testharness report, so it needs a visual/reftest comparator before it can be
scored; and `is-default-ns-003`, which currently hits a Koko navigation crash.

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

The latest one-iteration differential test report is
`bench-results/stylo/1795617111721.json`; all 13 Koko/Chromium fixture pairs
passed, including the expanded CSSOM subtype probe. The latest benchmark
report is `bench-results/stylo/1795616948792.json`: Koko measured 15.04 ms
parse, 163.02 ms full style, 2.89 ms incremental, 206.70 ms mutation
invalidation, and 44.30 ms repeated navigation; Chromium measured 27.81 ms,
0.50 ms, 0.20 ms, 0.40 ms, and 16.27 ms respectively. These are
single-process bounded samples; rerun with more iterations before treating
them as release-level performance numbers.
