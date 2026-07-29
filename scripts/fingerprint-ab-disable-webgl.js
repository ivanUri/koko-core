// Diagnostic A/B only: model a browser where WebGL is unavailable. This does
// not alter Fingerprint requests or responses. If the server-side tampering
// classification changes, the remaining incoherence is inside Velora's WebGL
// surface; if it does not, investigation must continue outside WebGL.
(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getContext(type, ...args) {
      const normalized = String(type).toLowerCase();
      if (normalized === "webgl" || normalized === "experimental-webgl" || normalized === "webgl2") {
        return null;
      }
      return Reflect.apply(original, this, [type, ...args]);
    },
  });
})()
