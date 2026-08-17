# Phase 1 benchmark contract

Phase 1 answers four narrow questions:

1. How long until a newly launched runtime returns a validated first local document?
2. How long does a reused runtime take to navigate deterministic small, medium, and dynamic documents to `DOMContentLoaded`?
3. How much time does the public client lifecycle require to create and dispose an isolated session?
4. What is whole-process-tree idle RSS at increasing session density?

The canonical comparator is Chromium over raw flattened CDP. Playwright Chromium is an optional secondary comparator. This is not a claim that Koko implements Chromium's renderer, GPU, extension, or full web-platform surface.

Each raw result conforms to `result-schema.json`. Warmup observations are marked, not deleted. Summary latency distributions contain successful measured observations only, while attempts, failures, and success rate always include measured failures. Environment data makes optimization mode and binary identity auditable.

Phase 2 can add JavaScript kernels, DOM operations, extraction throughput, concurrency/throughput curves, cold-versus-warm cache lanes, and compatibility scoring without changing the Phase 1 result envelope.

The optional `real-sites` lane is deliberately outside Phase 1 scoring. It exercises changing external pages and records content-shape signals so a fast but incomplete document is visible. It must not be merged into deterministic local-fixture aggregates.
