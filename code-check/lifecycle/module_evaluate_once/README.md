# module_evaluate_once

## Lifecycle behavior
Imports the same ES module twice in one realm.

## Expected semantics
The module body evaluates exactly once and both imports complete.

## Stale behavior to prevent
Duplicate evaluation in the same realm must not occur.

## Runtime invariant
The module map caches evaluation per realm and prevents duplicate execution.
