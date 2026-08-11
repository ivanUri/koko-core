# Browser resources must not inherit a short total timeout

Koko previously configured every reused curl easy handle with a 5000 ms
total timeout. That is not browser network behavior: image, stylesheet,
script, and Fetch requests do not fail merely because five seconds elapsed.
Under normal page concurrency, valid image CDN requests therefore completed
with `OperationTimedout`; their `error` event fired instead of `load`, leaving
framework-managed image visibility state unchanged.

`Config.httpTimeout()` now defaults to zero, which disables curl's total
request timeout. An explicit `--http-timeout` remains a host policy, and
per-request web API settings such as `XMLHttpRequest.timeout` continue to
override the connection option. Page automation remains bounded independently
by wait and termination deadlines.
