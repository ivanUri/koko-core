# Koko Core Engineering Rule

Before changing this project, read the relevant implementation, surrounding
callers, lifecycle ownership, existing tests, and related architecture/bug
notes. Do not patch from symptoms alone.

Every browser-behavior fix must be implemented at the lowest correct,
site-independent abstraction and must preserve browser semantics:

- Never branch on a website hostname, URL, product name, CSS class, DOM ID,
  framework fingerprint, or markup shape belonging to one site.
- Never add a compatibility hack whose only justification is that it makes a
  specific website pass.
- Identify the violated browser invariant or web-platform behavior first
  (DOM, HTML, CSS/layout, navigation, event loop, networking, resource
  lifecycle, JavaScript realm, or serialization).
- Fix the component that owns that invariant. Do not compensate in the CLI,
  exporter, automation layer, or a later lifecycle stage when the defect
  originates in core browser behavior.
- Prefer explicit ownership, state transitions, generations, and invalidation
  over timing sleeps, retries, magic constants, or post-processing generated
  HTML.
- Keep lifecycle changes safe across success, error, cancellation, navigation,
  timeout, shutdown, and stale-realm paths. Every acquired arena, response,
  handle, listener, and task must have exactly one owner and one terminal
  release path.
- Treat caches as derived state. Define their key, generation, and invalidation
  contract before modifying them.
- Match standards and real browser behavior where practical. If Koko uses an
  intentional approximation, document the invariant and its limits rather
  than naming a site that exposed it.

For every fix:

1. Reproduce the failure and record evidence from core state, not only the
   final page appearance.
2. State the general invariant that is broken.
3. Inspect all callers and terminal paths that share the affected state.
4. Implement the smallest architectural fix that applies to arbitrary pages.
5. Add a minimal deterministic regression test without third-party network
   dependencies. Cover failure/cancellation paths when ownership changes.
6. Run focused tests, then the relevant broader build/test target.
7. Use a real site only as an integration check after deterministic tests pass;
   never encode that site into production logic or make it the sole test.
8. Report remaining failures separately instead of hiding them with fallback
   CSS, DOM rewriting, sleeps, or unrelated cleanup.

If a proposed fix cannot be explained without mentioning the site that
triggered it, stop and redesign it around the underlying browser invariant.
