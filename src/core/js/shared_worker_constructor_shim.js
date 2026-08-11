(function () {
  const Native = SharedWorker;
  const constructEnter = globalThis.__kokoWorkerConstructEnter;
  const constructExit = globalThis.__kokoWorkerConstructExit;
  function workerBase() {
    try {
      return globalThis.location && globalThis.location.href;
    } catch (e) {
      return undefined;
    }
  }
  function SharedWorkerShim(url, options) {
    if (new.target) {
      if (arguments.length < 1) {
        throw new TypeError();
      }
      constructEnter();
      try {
        const urlString = String(url);
        const base = workerBase();
        if (!URL.canParse(urlString, base)) {
          throw new DOMException("", "SyntaxError");
        }
        let name = "";
        let opts = null;
        if (typeof options === "string") {
          name = options;
        } else if (options !== undefined && options !== null) {
          if (typeof options !== "object") {
            // WebIDL: optional (DOMString or WorkerOptions) — primitives coerce to name.
            name = String(options);
          } else {
          name = options.name ?? "";
          opts = { ...options };
          if (opts.extendedLifetime !== undefined && opts.extended_lifetime === undefined) {
            opts.extended_lifetime = opts.extendedLifetime;
          }
          if (opts.type !== undefined) {
            if (opts.type !== "classic" && opts.type !== "module") {
              throw new TypeError();
            }
          }
          }
        }
        return Reflect.construct(Native, [urlString, name, opts], new.target);
      } finally {
        constructExit();
      }
    }
    return Native.apply(this, arguments);
  }
  Object.defineProperty(SharedWorkerShim, "prototype", {
    value: Native.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(SharedWorkerShim, "name", { value: "SharedWorker", configurable: true });
  Object.defineProperty(SharedWorkerShim, "length", { value: Native.length, configurable: true });
  Object.defineProperty(SharedWorkerShim.prototype, "constructor", {
    value: SharedWorkerShim,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  globalThis.SharedWorker = SharedWorkerShim;
})();
