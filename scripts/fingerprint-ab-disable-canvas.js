// Diagnostic A/B only: model a browser where canvas rendering is unavailable.
// Requests and server responses are left untouched.
(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getContext() {
      return null;
    },
  });
})()
