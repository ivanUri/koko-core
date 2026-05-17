# custom_element_navigation

## Lifecycle behavior
A custom element schedules asynchronous work from `connectedCallback`, then navigation tears down the realm.

## Expected semantics
The initial connection can run; delayed custom-element work must not.

## Stale behavior to prevent
Async callbacks associated with the element must not survive realm death.

## Runtime invariant
Custom element callbacks validate JS entry against the owning realm.
