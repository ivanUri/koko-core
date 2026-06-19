# content_window_visibility

Asserts that `iframe.contentWindow` is null before attach, never exposes a partially initialized realm immediately after append, remains stable across a microtask, and is nulled after detach.
