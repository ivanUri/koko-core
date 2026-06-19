# fetch_navigation

## Lifecycle behavior
Starts a local fetch and navigates before completion can be observed.

## Expected semantics
The next realm finishes; old realm-local setup logs are not observable after navigation. The oracle validates next-page stability and absence of stale fetch continuation effects.

## Stale behavior to prevent
Fetch completion must not resolve into or mutate a replaced realm.

## Runtime invariant
Promise resolution for network completion validates task ownership before JS entry.
