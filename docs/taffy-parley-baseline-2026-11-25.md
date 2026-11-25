# Taffy/Parley baseline — 2026-11-25

Command:

```sh
node bench/suites/taffy-parley-differential.mjs \
  --koko-bin zig-out/bin/koko \
  --baseline koko-cdp,chromium-cdp \
  --warmup 1 --iterations 3 \
  --timeout-ms 20000 --allow-mismatches \
  --output /tmp/koko-taffy-parley-baseline-v2.json
```

The binary was the current `zig-out/bin/koko` on branch
`feat/taffy-parley-layout`. The probe used four local HTML fixtures and no
live network requests.

## Differential result

| Fixture | Result | Main observation |
| --- | --- | --- |
| `layout-flex-grid.html` | `mismatch` | Koko flex item widths were `600, 600, 600` px; Chromium produced `143.5, 269, 143.5` px. Koko grid items were all `640` px wide instead of `100, 168, 336` px tracks. |
| `layout-text.html` | `mismatch` | Koko returned one unwrapped Latin client rect (`674.629` px); Chromium returned three line rects (`272.984`, `287.281`, `110.297` px). |
| `layout-geometry.html` | `mismatch` | Koko and Chromium agreed on several fixed dimensions, but box placement and border-box metrics differed: outer top `48` vs `13` px, inner left `11` vs `41` px, and outer client width `400` vs `394` px. |
| `layout-lifecycle.html` | `pass` | Both runtimes produced `64` nodes and checksum `35030` on every measured navigation. |

Both runtimes returned a probe result; there were no CDP errors or
unsupported API statuses. The differential status is still failing for the
first three fixtures because geometry, track sizing, line breaking, and
computed layout values differ materially.

The report recorded different default CDP viewport sizes (`1280x720` for Koko
and `756x469` for Chromium). The fixture dimensions are fixed, so the main
flex/grid/text mismatches are independent of viewport width, but future layout
benchmarks should force the same emulated viewport before treating absolute
page coordinates as a release gate.

## Repeated navigation timing

Three measured lifecycle navigations followed one warmup on a reused CDP
session. Values below are medians of the three measured records:

| Baseline | End-to-end cycle | Navigation | Navigate ACK | Browser-side probe |
| --- | ---: | ---: | ---: | ---: |
| Koko | 46.446 ms | 42.552 ms | 35.630 ms | 0.096 ms |
| Chromium | 13.470 ms | 11.852 ms | 6.949 ms | 0.000 ms |

The lifecycle script itself is correct in both runtimes, so this is a
navigation/lifecycle baseline, not evidence that Koko already performs valid
layout or Parley text shaping.

## Next acceptance gates

1. Connect Taffy layout results to flex/grid/block geometry and rerun this
   probe until the first three fixtures are `pass` within the 0.5 CSS-pixel
   tolerance.
2. Connect Parley measurement and line breaking, then require the text fixture
   to produce matching client-rect counts and dimensions.
3. Add a fixed emulated viewport to both adapters or the probe before making
   absolute-coordinate comparisons a hard CI gate.
4. Repeat the run with ReleaseFast and larger samples before publishing
   performance comparisons.
