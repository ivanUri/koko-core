# custom_element_reconnect

## Lifecycle behavior
Appends, removes, and reattaches a custom element in one realm.

## Expected semantics
Callbacks should occur as connected, disconnected, connected.

## Stale behavior to prevent
The runtime must not emit duplicate connected callbacks without an intervening disconnect.

## Runtime invariant
Custom element reaction ordering remains stable across reconnect operations.
