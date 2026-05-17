# Lifecycle Semantic Test Fixtures

Small deterministic fixtures for Velora lifecycle regression testing. These are semantic fixtures, not rendering or UI tests.

Each scenario exposes `window.TEST_LOGS` and `window.TEST_RESULT`, and pairs fixture files with an `expected.json` oracle. Automation can load `index.html`, wait for `TEST_RESULT.done === true`, then compare stable log tokens against `must_contain` and `must_not_contain`.

The directory is intentionally flat and extensible so future runners can add trace snapshots, Chrome reference output, stress scenarios, and fuzz-generated fixtures without changing the base fixtures.
