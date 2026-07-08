(function () {
  const Native = URLSearchParams;
  function isSequenceSequenceStrings(value) {
    if (!Array.isArray(value)) return false;
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) return true;
      if (typeof pair[0] !== "string" || typeof pair[1] !== "string") return true;
    }
    return false;
  }
  function validateInit(init) {
    if (init === null || init === undefined) return;
    if (typeof init === "function") return;
    if (typeof DOMException !== "undefined" && init === DOMException.prototype) {
      throw new TypeError();
    }
    if (Array.isArray(init) && isSequenceSequenceStrings(init)) {
      throw new TypeError();
    }
  }
  function USP() {
    if (new.target) {
      if (arguments.length) validateInit(arguments[0]);
      return Reflect.construct(Native, arguments, new.target);
    }
    return Native.apply(this, arguments);
  }
  Object.defineProperty(USP, "prototype", {
    value: Native.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(USP, "name", { value: "URLSearchParams", configurable: true });
  Object.defineProperty(USP, "length", { value: Native.length, configurable: true });
  Object.defineProperty(USP.prototype, "constructor", {
    value: USP,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(USP.prototype, Symbol.iterator, {
    value: Native.prototype.entries,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  globalThis.URLSearchParams = USP;
})();