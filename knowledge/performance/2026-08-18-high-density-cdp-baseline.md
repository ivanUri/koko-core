# High-density CDP baseline and HTTP pool tuning

> **Audience:** Koko engineers working on multi-session scale.  
> **Date:** 2026-08-18

## Summary

The deterministic concurrency lane exposed two separate limits:

1. The original HTTP defaults (`10` total handles, `4` per host) created a
   queueing cliff at 32 simultaneous pages.
2. The CDP server uses one worker thread per connection. At 64 and 128
   sessions this becomes the next architectural limit, even though RSS per
   session remains nearly linear.

## Change

The safe configuration defaults are now `32` total HTTP handles and `16`
per-host handles. Explicit `--http-max-concurrent` and
`--http-max-host-open` values still win. The benchmark runner also accepts
`--cdp-max-connections` for high-density experiments.

## Measurements

Deterministic loopback medium fixture, ReleaseFast, Koko direct CDP:

| Sessions | Old HTTP defaults p50 | New defaults p50 | RSS/session | Threads | CPU |
|---:|---:|---:|---:|---:|---:|
| 32 | 291.8 ms | 108.9 ms | 6.84 MiB | not captured in old run | — |
| 64 | — | 153.2 ms | 6.51 MiB | 140 | 285% |
| 128 | — | 398.6 ms | 6.38 MiB | 268 | 427% |

Idle session density at 128 sessions remains 100% successful, about 624 MiB
RSS, and 4.68 MiB incremental RSS/session. Reusing one session for 100
navigations remains 100/100 successful with p95 navigation of 14.4 ms.

## Decision

Do not change V8/session lifecycle yet. The next architectural experiment is a
bounded CDP worker pool with context affinity, measured against the current
thread-per-connection baseline. Any implementation must preserve one-at-a-time
V8 access per Browser, CDP ordering, and existing generation-based teardown.
