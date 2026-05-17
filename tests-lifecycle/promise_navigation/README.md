# promise_navigation

## Lifecycle behavior
Queues a promise continuation and immediately navigates.

## Expected semantics
The next page becomes the observable result; old realm-local scheduling logs are intentionally not required after navigation. Stale promise effects must not appear in the next realm.

## Stale behavior to prevent
A promise continuation from the replaced realm must not mutate old document state.

## Runtime invariant
Microtasks must be associated with realm lifecycle and cannot enter a dead realm.
