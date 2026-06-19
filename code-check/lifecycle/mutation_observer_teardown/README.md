# mutation_observer_teardown

## Lifecycle behavior
Queues a MutationObserver delivery and tears down the realm via navigation.

## Expected semantics
No observer callback from the old realm should be observable. The oracle validates next-realm stability and ownership cleanup rather than preserving old realm-local logs.

## Stale behavior to prevent
Pending mutation records must not deliver after document teardown.

## Runtime invariant
MutationObserver delivery is single-flight and must validate current realm ownership.
