# iframe_detach_async

## Lifecycle behavior
An iframe schedules async work, then the parent removes the iframe.

## Expected semantics
The parent observes load/removal and then stabilizes without child stale messages.

## Stale behavior to prevent
Detached iframe timers or callbacks must not message the parent after teardown.

## Runtime invariant
Child frame teardown invalidates all async work owned by that frame realm.
