(function () {
  const NativeURL = URL;
  const hrefDesc = Object.getOwnPropertyDescriptor(NativeURL.prototype, "href");
  const nativeSetHref = hrefDesc.set;
  function setHref(v) {
    if (typeof v === "string" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
      throw new TypeError();
    }
    return nativeSetHref.call(this, v);
  }
  Object.defineProperty(setHref, "name", { value: "set href", configurable: true });
  hrefDesc.set = setHref;
  Object.defineProperty(NativeURL.prototype, "href", hrefDesc);

  const nativeSC = structuredClone;
  globalThis.structuredClone = function (v) {
    if (v instanceof NativeURL || v instanceof URLSearchParams) {
      throw new DOMException("", "DataCloneError");
    }
    return nativeSC.call(this, v);
  };

  function URLWrapper() {
    if (new.target) {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 0) {
        if (args[0] == null) {
          args[0] = "";
        } else if (typeof args[0] !== "string") {
          args[0] = String(args[0]);
        }
      }
      if (args.length > 1 && args[1] != null && typeof args[1] !== "string") {
        args[1] = String(args[1]);
      }
      return Reflect.construct(NativeURL, args, new.target);
    }
    return NativeURL.apply(this, arguments);
  }
  Object.defineProperty(URLWrapper, "prototype", {
    value: NativeURL.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(URLWrapper, "name", { value: "URL", configurable: true });
  Object.defineProperty(URLWrapper, "length", { value: NativeURL.length, configurable: true });

  for (const key of ["parse", "canParse", "createObjectURL", "revokeObjectURL"]) {
    const desc = Object.getOwnPropertyDescriptor(NativeURL, key);
    if (desc) {
      Object.defineProperty(URLWrapper, key, desc);
    }
  }

  Object.defineProperty(URLWrapper.prototype, "constructor", {
    value: URLWrapper,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  globalThis.URL = URLWrapper;
  Object.defineProperty(globalThis, "webkitURL", {
    value: URLWrapper,
    writable: true,
    enumerable: false,
    configurable: true,
  });
})();