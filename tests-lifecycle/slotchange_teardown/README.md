# slotchange_teardown

## Lifecycle behavior
Queues a shadow DOM `slotchange` event and navigates before delivery.

## Expected semantics
The next realm stabilizes without any old slotchange callback.

## Stale behavior to prevent
Queued slotchange delivery must not fire after the host realm is torn down.

## Runtime invariant
Slotchange delivery captures task ownership and validates realm liveness before callback entry.
