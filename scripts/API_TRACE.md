# Browser API differential tracer

This diagnostic records selected browser API calls before page scripts run. It
is site-independent and bounded to 20,000 events per JavaScript realm.

The preload wraps JavaScript functions and is therefore observable. Use its
output to compare call flow, return types, exceptions, and coarse timing; do
not use a traced run as evidence that an anti-abuse challenge should pass.

## Capture Chrome

Start a dedicated Chrome instance:

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --no-first-run \
  --user-data-dir=/tmp/chrome-api-trace
```

Then capture:

```sh
node scripts/capture-api-trace.js \
  --cdp http://127.0.0.1:9222 \
  --url https://example.com/ \
  --out exports/api-trace-chrome.json \
  --wait-ms 12000
```

## Capture Velora

Start Velora's CDP server in another terminal:

```sh
./zig-out/bin/velora serve --host 127.0.0.1 --port 9323
```

Capture the same URL:

```sh
node scripts/capture-api-trace.js \
  --cdp http://127.0.0.1:9323 \
  --url https://example.com/ \
  --out exports/api-trace-velora.json \
  --wait-ms 12000
```

## Compare

```sh
node scripts/diff-api-traces.js \
  exports/api-trace-chrome.json \
  exports/api-trace-velora.json
```

The tab-separated report includes API, phase, result type, invocation count,
and average synchronous duration. Redirect it to a `.tsv` file if needed.

Cross-origin frames can be separate CDP targets. The runner collects published
execution contexts, attaches to iframe targets when available, and accepts
diagnostic child snapshots posted by the preload. A browser that does not
publish a navigated child realm through any of these channels will show that
realm as missing rather than silently merging it with the top document.
