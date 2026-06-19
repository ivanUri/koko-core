# timer_navigation

## Lifecycle behavior
Schedules a timer, then replaces the realm before the timer can fire.

## Expected semantics
Only the next realm should complete and report stable logs. Old realm-local scheduling logs are abandoned by navigation and are not part of the cross-navigation oracle.

## Stale behavior to prevent
The old timer must not mutate the old DOM or run after navigation.

## Runtime invariant
Macrotasks capture realm ownership and stale owners are dropped after navigation.
