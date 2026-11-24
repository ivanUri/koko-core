# Phase 1 benchmark contract

Phase 1 answers four narrow questions:

1. How long until a newly launched runtime returns a validated first local document?
2. How long does a reused runtime take to navigate deterministic small, medium, and dynamic documents to `DOMContentLoaded`?
3. How much time does the public client lifecycle require to create and dispose an isolated session?
4. What is whole-process-tree idle RSS at increasing session density?

The canonical comparator is Chromium over raw flattened CDP. Playwright Chromium is an optional secondary comparator. This is not a claim that Koko implements Chromium's renderer, GPU, extension, or full web-platform surface.

Each raw result conforms to `result-schema.json`. Warmup observations are marked, not deleted. Summary latency distributions contain successful measured observations only, while attempts, failures, and success rate always include measured failures. Environment data makes optimization mode and binary identity auditable.

Phase 2 includes deterministic concurrent navigation, reused-session long-run,
network lifecycle, DOM/JavaScript and representative agent-workload lanes.
The network lane covers tiny/large/redirect/delayed/streaming/resource-burst
and cancellation fixtures. The DOM/JS lane covers create/mutate, selectors and
timers/microtasks. The agent lane models navigate -> inspect -> interact ->
extract. These lanes preserve the Phase 1 result envelope and remain independent
from Observatory.

The heavy-site lane is a deterministic stress lane: it parses a 12,000-element
document and runs selector, Map, transient-object and checksum work before the
session is torn down. It reports navigation/evaluation timing plus process-tree
RSS/VMS so a site-sized DOM regression is not hidden by small-fixture results.

The context-recycle lane keeps one CDP socket open while repeatedly replacing
the BrowserContext with the heavy fixture. It validates worker recycle and
reports memory both after disposal and after the next safe recycle boundary,
covering retained state between sequential sites.

The handshake-admission lane is an admission-pressure check rather than a
page-performance score. It holds sockets before WebSocket upgrade and records
RSS, VMS, thread count, and pending capacity; active-admission probes then
verify that only upgraded sessions consume `--cdp-max-connections`.
Each probe emits a JSON artifact when passed `--output`; the artifact is tied to
the resolved binary path and exact probe options so ON/OFF V8 runs cannot be
silently mixed.

The optional `real-sites` lane is deliberately outside deterministic scoring. It
exercises changing external pages and records content-shape signals so a fast
but incomplete document is visible. It must not be merged into local-fixture
aggregates. Deterministic runs may use `--regression-against` with an explicit
threshold and `--regression-mode fail` for CI.
