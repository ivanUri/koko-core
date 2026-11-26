# Taffy/Parley layout benchmark contract

`bench/suites/taffy-parley-differential.mjs` is the first layout/text
validation lane for the `feat/taffy-parley-layout` branch. It is intentionally
independent from the existing Stylo suites and changes no runtime code.

## Workloads

The loopback fixtures are deterministic and are served identically to Koko and
direct Chromium CDP:

- `layout-flex-grid.html`: fixed-size flex and grid containers, tracks, gaps,
  borders, padding, and child rectangles.
- `layout-text.html`: fixed-width wrapping, line rectangles, whitespace,
  `direction: rtl`, and Unicode text.
- `layout-geometry.html`: nested margin/padding/border boxes and the geometry
  API values used by layout-dependent DOM code.
- `layout-lifecycle.html`: deterministic DOM construction and a repeated
  navigation/teardown loop on one CDP session.

The probe records `getBoundingClientRect()`, `getClientRects()`, computed
layout properties, offset/client/scroll metrics, `elementFromPoint()`, text
measurements, navigation timing, and the lifecycle checksum. Numeric geometry
comparison allows at most 0.5 CSS px; missing APIs are reported as
`unsupported`, and other differences are reported as `mismatch`.

## Reproducible command

Build the Koko binary under test, then run:

```sh
node bench/suites/taffy-parley-differential.mjs \
  --koko-bin zig-out/bin/koko \
  --baseline koko-cdp,chromium-cdp \
  --warmup 1 --iterations 3 \
  --output bench-results/taffy-parley/<run-id>.json
```

Use `--allow-mismatches` when collecting an initial baseline before Taffy and
Parley are connected. The command still writes every observation and exits
non-zero by default when a fixture is unsupported, errors, or differs from
Chromium. It never contacts a live site.

## Interpreting the report

`tests[]` is the compatibility result for each fixture. Each baseline includes
the navigation timing and the browser-side probe duration. `lifecycle[]`
contains every warmup and measured repeated navigation, including the
navigation ACK and the post-navigation layout/text probe. Keep warmups in the
raw report; calculate p50/p95 only from measured records when comparing builds.

This lane is not a replacement for WPT. It is a small, reviewable smoke test
for the integration boundary. Follow-up WPT coverage should include flexbox,
grid, CSS sizing, inline formatting, Unicode/bidi, and DOM geometry APIs.

## Baseline limitations

The probe is expected to expose gaps until the layout milestone is complete.
Typical failures to classify explicitly are fabricated or zero geometry,
missing `getClientRects()`/`elementFromPoint()`, unsupported flex/grid
computed values, and text metrics that do not reflect line breaking. A passing
navigation checksum alone does not prove that layout or text shaping ran.
