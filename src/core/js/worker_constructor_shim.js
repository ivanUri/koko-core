(function () {
  const Native = Worker;
  const constructEnter = globalThis.__veloraWorkerConstructEnter;
  const constructExit = globalThis.__veloraWorkerConstructExit;
  function workerBase() {
    try {
      return globalThis.location && globalThis.location.href;
    } catch (e) {
      return undefined;
    }
  }
  function WorkerShim(url, options) {
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
        if (options !== undefined && options !== null) {
          if (typeof options !== "object") {
            throw new TypeError();
          }
          if (options.type !== undefined) {
            if (options.type !== "classic" && options.type !== "module") {
              throw new TypeError();
            }
          }
        }
        const args = options === undefined ? [urlString] : [urlString, options];
        return Reflect.construct(Native, args, new.target);
      } finally {
        constructExit();
      }
    }
    return Native.apply(this, arguments);
  }
  Object.defineProperty(WorkerShim, "prototype", {
    value: Native.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(WorkerShim, "name", { value: "Worker", configurable: true });
  Object.defineProperty(WorkerShim, "length", { value: Native.length, configurable: true });
  Object.defineProperty(WorkerShim.prototype, "constructor", {
    value: WorkerShim,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  globalThis.Worker = WorkerShim;
})();
