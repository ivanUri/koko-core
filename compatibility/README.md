# Koko WebIDL compatibility framework

This directory contains compatibility tooling only. It is not linked into the
Koko production binary and does not embed Blink or Chromium.

The framework uses four evidence layers:

1. WebIDL inventories from pinned WebRef/Blink-compatible `.idl` checkouts.
2. A structured Koko source inventory of `JsApi` and `bridge` declarations.
3. Side-effect-free runtime surface snapshots from Chromium and Koko through
   the existing CDP adapters.
4. Deterministic behavior/WPT results with explicit outcome classifications.

## Quick start

```sh
npm run compatibility:test

# Use a local WebIDL checkout or a deterministic fixture.
node compatibility/cli.mjs inventory webidl \
  --input compatibility/fixtures/webidl \
  --source fixture --output /tmp/koko-webidl.json

node compatibility/cli.mjs inventory koko \
  --root . --output /tmp/koko-api.json

node compatibility/cli.mjs report \
  --expected /tmp/koko-webidl.json \
  --actual /tmp/koko-api.json \
  --output compatibility/reports/local.json \
  --markdown compatibility/reports/local.md

# Generate WebIDL conversion probes for a fixture operation.
node compatibility/cli.mjs binding-cases \
  --interface Event --operation initEvent \
  --output /tmp/event-binding-cases.json
```

The fixture is only a parser regression input; it is not a compatibility
baseline. Run `node compatibility/cli.mjs update-upstream` to fetch the pinned
source repositories. The command records commit IDs and a content hash in
`upstream/manifest.json`; large checkouts remain ignored by Git.

Runtime surface collection reuses `bench/adapters/`:

```sh
node compatibility/cli.mjs introspect \
  --engines chromium-cdp,koko-cdp \
  --chrome-bin /path/to/chrome \
  --koko-bin ./zig-out/bin/koko \
  --output compatibility/reports/surface.json
```

WPT execution is intentionally an adapter boundary. A WPT checkout and its
local test server are required; missing environments are reported as
`UNSUPPORTED` or `HARNESS_ERROR`, never as passing tests.

## Schemas and status rules

Stable IDs are based on source/interface/member identity. API presence,
binding correctness, behavior verification, and test coverage are separate
fields. The report never collapses them into one compatibility percentage.

API statuses are `IMPLEMENTED_VERIFIED`, `IMPLEMENTED_UNVERIFIED`, `PARTIAL`,
`MISSING`, `STUB`, `INCORRECT`, `UNSUPPORTED_BY_DESIGN`, `NOT_APPLICABLE`, and
`UNKNOWN`.

Test statuses are `PASS`, `FAIL`, `TIMEOUT`, `CRASH`, `SKIP`, `EXPECTED_FAIL`,
`UNSUPPORTED`, `NOT_RUN`, and `HARNESS_ERROR`.

## Upstream policy

Chromium is a reference implementation and runtime oracle, not the
specification authority. WebRef/WPT and the relevant specification decide
whether a Chromium/Koko difference is a defect. No website hostname, URL,
framework, DOM shape, or CSS class is used in production logic.

## Current limitations

- Initial upstream checkouts are not committed; the first reproducible run must
  initialize `upstream/manifest.json` locally or in CI cache.
- Full WPT execution depends on an external WPT checkout and local server.
- Runtime surface collection requires built Koko and a locally available
  Chromium executable.
- The Koko inventory reports registration metadata; meaningful behavior still
  requires binding and differential tests.
- Binding probes are generated from WebIDL conversion contracts and must be
  executed by a suite module through `differential --suite`; the generator does
  not claim an API is correct merely because a probe file exists.
