# DOM-stable navigation wait

`wait_until=domstable` is a snapshot policy, not a new rendering phase.
Velora continues parsing, executing JavaScript, and updating DOM/layout
progressively as before.

## Invariant

A document is DOM-stable when:

1. its main-frame `load` lifecycle has completed; and
2. the frame's DOM/layout generation (`Frame.version`) has not changed for
   500 ms.

The tracker is owned by `Runner`, because stability is relative to an
individual wait operation. It resets on a generation change, frame replacement,
or a lifecycle state before `load`.

Network activity is intentionally excluded. Analytics, polling, WebSocket, RTC,
and recurring timers that do not mutate DOM must not keep a useful snapshot
open forever. `done` remains the stronger host-idle condition; `networkidle`
remains the network-quiescence condition.

## Limits

`Frame.version` is a conservative proxy for visual change. It includes DOM
changes that may not affect pixels and does not attempt pixel comparison or
animation-frame sampling. A slow response arriving after the 500 ms quiet
window may update the page after `domstable`; callers that require a specific
late result should additionally wait for a selector or script condition.

SDK CDP clients implement the same policy with a document-wide
`MutationObserver`, starting after `load`, and disconnect the observer on both
stability and deadline paths.
