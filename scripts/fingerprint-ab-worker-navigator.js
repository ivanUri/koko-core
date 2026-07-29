// Diagnostic A/B only: remove Window-only Navigator mixins from worker realms.
// The Blob payload itself remains otherwise unchanged.
(() => {
  const NativeBlob = globalThis.Blob;
  const prelude = `
    (() => {
      const prototype = Object.getPrototypeOf(navigator);
      for (const key of ["webdriver", "pdfViewerEnabled", "cookieEnabled", "maxTouchPoints"]) {
        try { delete prototype[key]; } catch {}
      }
    })();
  `;

  function DiagnosticBlob(parts = [], options = {}) {
    const type = String(options?.type || "").toLowerCase();
    const source = type.includes("javascript")
      ? [prelude, ...parts]
      : parts;
    return new NativeBlob(source, options);
  }
  DiagnosticBlob.prototype = NativeBlob.prototype;
  Object.setPrototypeOf(DiagnosticBlob, NativeBlob);
  Object.defineProperty(globalThis, "Blob", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: DiagnosticBlob,
  });
})()
