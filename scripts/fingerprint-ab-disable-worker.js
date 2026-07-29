// Diagnostic A/B only: model a browser where dedicated workers are
// unavailable, forcing libraries to use their documented main-realm fallback.
// Network requests and responses are not modified.
(() => {
  function UnavailableWorker() {
    throw new DOMException("Worker construction is disabled for this diagnostic", "SecurityError");
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: UnavailableWorker,
  });
})()
