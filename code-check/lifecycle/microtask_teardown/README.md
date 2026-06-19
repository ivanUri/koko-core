# microtask_teardown

## Lifecycle behavior
Starts a recursive promise chain and immediately navigates.

## Expected semantics
The next realm must become stable; the recursive chain cannot keep the runtime alive forever. This is a survivability and navigation-progress oracle, not a strict Promise cancellation visibility test.

## Stale behavior to prevent
A microtask loop from the old realm must not survive teardown or starve navigation completion.

## Runtime invariant
Microtask draining is bounded by realm liveness and stale ownership checks.
