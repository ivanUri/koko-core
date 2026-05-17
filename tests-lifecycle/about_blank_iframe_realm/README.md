# about:blank iframe realm readiness

Regression fixture for partially initialized realm exposure. It creates an `about:blank` iframe, immediately reads `contentWindow`, and verifies cross-realm intrinsics, prototype chains, `navigator`, `document`, `documentElement`, and `Function.prototype.toString` before any observer can see an unstable WindowProxy.
