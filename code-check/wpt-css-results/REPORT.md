# WPT CSS Report — Velora (2026-07-22)

## Summary

| Metric | Value |
|--------|------:|
| Date | 2026-07-22 |
| Engine | Velora 1.0.2 (`d89ac287` base + local harness tooling) |
| Host | Windows + WSL2 Ubuntu, `zig build -Doptimize=ReleaseFast` |
| WPT source | Sparse clone of [web-platform-tests/wpt](https://github.com/web-platform-tests/wpt) |
| Runner | [lightpanda-io/demo](https://github.com/lightpanda-io/demo) `wptrunner` over CDP |
| Suites selected | `css/css-syntax`, `css/cssom`, `css/css-variables` (first **40** matching files) |
| **Ran** | **40** |
| **Pass** | **1** |
| **Fail** | **39** |
| — real assertion fails | 33 |
| — harness incomplete | 6 |
| Crashes | 0 |

**Pass file**

- `/css/css-syntax/non-ascii-codepoints.html`

## Artifacts

| File | Description |
|------|-------------|
| [`failures.txt`](failures.txt) | All non-pass test paths (39) |
| [`failures.real.txt`](failures.real.txt) | Assertion / functional fails only (33) |
| [`failures.incomplete.txt`](failures.incomplete.txt) | Harness never completed (6) |
| [`failures.detail.txt`](failures.detail.txt) | Per-file failing subtests + messages |
| [`selected-tests.txt`](selected-tests.txt) | Exact list of 40 tests run |
| [`results.json`](results.json) | Full wptrunner JSON |
| [`summary.txt`](summary.txt) | Machine-readable counts |

## Failed tests (all)

```
/css/css-syntax/anb-serialization.html
/css/css-syntax/anb-parsing.html
/css/css-syntax/at-rule-in-declaration-list.html
/css/css-syntax/cdc-vs-ident-tokens.html
/css/css-syntax/charset-is-not-a-rule.html
/css/css-syntax/charset/page-windows-1251-charset-attribute-bogus.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-1250-charset-attribute-windows-1253.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-bogus-charset-attribute-windows-1250.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-utf16-ascii-only.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-bogus.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-utf16.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-utf16be.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-windows-1250-in-utf16be.html
/css/css-syntax/charset/page-windows-1251-css-at-charset-windows-1250-in-utf16.html
/css/css-syntax/charset/page-windows-1251-css-http-bogus-at-charset-windows-1250.html
/css/css-syntax/charset/page-windows-1251-css-http-bogus.html
/css/css-syntax/charset/page-windows-1251-css-http-windows-1250-at-charset-windows-1253.html
/css/css-syntax/charset/page-windows-1251-css-utf8-bom.html
/css/css-syntax/charset/page-windows-1251-css-no-decl.html
/css/css-syntax/custom-property-rule-ambiguity.html
/css/css-syntax/charset/page-windows-1252-http-windows-1251-css-utf8-bom.html
/css/css-syntax/decimal-points-in-numbers.html
/css/css-syntax/declarations-trim-whitespace.html
/css/css-syntax/escaped-eof.html
/css/css-syntax/ident-three-code-points.html
/css/css-syntax/inclusive-ranges.html
/css/css-syntax/input-preprocessing.html
/css/css-syntax/invalid-nested-rules.html
/css/css-syntax/serialize-consecutive-tokens.html
/css/css-syntax/serialize-escape-identifiers.html
/css/css-syntax/trailing-braces.html
/css/css-syntax/unclosed-constructs.html
/css/css-syntax/unclosed-url-at-eof.html
/css/css-syntax/unicode-range-selector.html
/css/css-syntax/urange-parsing.html
/css/css-syntax/url-whitespace-consumption.html
/css/css-syntax/whitespace.html
/css/css-variables/css-variable-change-style-001.html
/css/css-syntax/var-with-blocks.html
```

## Themes in assertion failures

| Theme | Examples | Observed behavior |
|-------|----------|-------------------|
| **An+B serialize / parse** | `anb-parsing.html`, `anb-serialization.html` | Keeps author form (`odd`, `+1`, `1n + 1`) instead of CSS-serialized form (`2n+1`, `1`, `n+1`); weak parse-error rejection for spaced tokens |
| **Charset / encoding** | `charset/page-windows-1251-*.html` | `@charset` / HTTP charset / BOM interactions not aligned with WPT expectations |
| **Syntax edge cases** | `escaped-eof`, `unclosed-*`, `trailing-braces`, `whitespace` | Tokenizer/parser recovery and EOF rules incomplete |
| **CSS variables** | `css-variable-change-style-001.html` | Style invalidation / cascade update for custom properties |

Sample detail (`anb-serialization.html`):

```
expected "n+1" but got "1n + 1"
expected "2n+2" but got "2n + 2"
expected "0" but got "0n + 0"
```

## Harness incomplete (not pure CSS bugs)

These timed out or never reached testharness completion:

```
/css/css-syntax/charset/page-windows-1251-css-no-decl.html
/css/css-syntax/charset/page-windows-1252-http-windows-1251-css-utf8-bom.html
/css/css-syntax/ident-three-code-points.html
/css/css-syntax/inclusive-ranges.html
/css/css-syntax/serialize-escape-identifiers.html
/css/css-syntax/var-with-blocks.html
```

## Infrastructure notes

1. **Classic script ordering** — Velora can run inline scripts before external `testharness.js` finishes loading. Without a wait wrapper, tests throw `test is not defined` and the suite never completes.
2. **Workaround** — `scripts/wpt-css-preprocess.py` wraps inline scripts so they poll until `test` / `assert_true` exist.
3. **testharnessreport.js** — use lightpanda patch (`report` global) for wptrunner progress/completion probes.
4. **WSL build path** — binary is Linux ELF (`zig-out/bin/velora-linux` / `~/velora/zig-out/bin/velora`) with `LD_LIBRARY_PATH` pointing at `vendor/curl-impersonate/linux`.

## How to re-run

```bash
# In WSL (after tools + sparse WPT under /root/wpt-css-work):
sed -i 's/\r$//' /mnt/d/velora/scripts/wpt-css-run-failsonly.sh
MAX_TESTS=40 FILTERS='css/css-syntax css/cssom css/css-variables' \
  bash /mnt/d/velora/scripts/wpt-css-run-failsonly.sh

# Failures only:
cat /mnt/d/velora/code-check/wpt-css-results/failures.txt
```

Related knowledge note: [`knowledge/bugs/2026-07-22-wpt-css-syntax-suite.md`](../../knowledge/bugs/2026-07-22-wpt-css-syntax-suite.md)
