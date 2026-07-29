(() => {
  "use strict";

  // Diagnostic-only API access tracer. It is intentionally site-independent
  // and bounded: every realm owns its own ring-like event list. Wrapping a web
  // API is observable, so traces are evidence about call flow, not an
  // undetectable browser fingerprint.
  const MAX_EVENTS = 20000;
  const MAX_EVENTS_PER_KEY = 512;
  const events = [];
  const eventCounts = new Map();
  const droppedByKey = new Map();
  const childTraces = new Map();
  const realmId = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const nativeNow = performance.now.bind(performance);
  const startedAt = nativeNow();

  function summarize(value) {
    if (value === null) return { type: "null" };
    const type = typeof value;
    if (type === "undefined" || type === "boolean" || type === "number") {
      return { type, value };
    }
    if (type === "string") {
      return { type, length: value.length, sample: value.slice(0, 80) };
    }
    if (ArrayBuffer.isView(value)) {
      return { type: value.constructor?.name || "TypedArray", length: value.length };
    }
    if (Array.isArray(value)) return { type: "Array", length: value.length };
    return { type: value?.constructor?.name || type };
  }

  function record(api, phase, detail) {
    const key = `${api}\t${phase}`;
    const count = eventCounts.get(key) || 0;
    eventCounts.set(key, count + 1);
    if (events.length >= MAX_EVENTS || count >= MAX_EVENTS_PER_KEY) {
      droppedByKey.set(key, (droppedByKey.get(key) || 0) + 1);
      return;
    }
    events.push({
      api,
      phase,
      t: Math.round((nativeNow() - startedAt) * 1000) / 1000,
      ...detail,
    });
  }

  function preserveSurface(wrapper, original) {
    try { Object.defineProperty(wrapper, "name", { value: original.name, configurable: true }); } catch {}
    try { Object.defineProperty(wrapper, "length", { value: original.length, configurable: true }); } catch {}
    return wrapper;
  }

  function wrapMethod(owner, key, label) {
    if (!owner) return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.value !== "function") return;
    const original = descriptor.value;
    const wrapped = preserveSurface(function (...args) {
      const call = { args: args.map(summarize) };
      record(label, "call", call);
      const before = nativeNow();
      try {
        const result = Reflect.apply(original, this, args);
        record(label, "return", {
          duration: Math.round((nativeNow() - before) * 1000) / 1000,
          result: summarize(result),
        });
        return result;
      } catch (error) {
        record(label, "throw", {
          duration: Math.round((nativeNow() - before) * 1000) / 1000,
          error: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 160) },
        });
        throw error;
      }
    }, original);
    try { Object.defineProperty(owner, key, { ...descriptor, value: wrapped }); } catch {}
  }

  function wrapGetter(owner, key, label) {
    if (!owner) return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.get !== "function") return;
    const original = descriptor.get;
    const getter = preserveSurface(function () {
      record(label, "get", {});
      try {
        const result = Reflect.apply(original, this, []);
        record(label, "get-return", { result: summarize(result) });
        return result;
      } catch (error) {
        record(label, "get-throw", { error: { name: error?.name || "Error" } });
        throw error;
      }
    }, original);
    try { Object.defineProperty(owner, key, { ...descriptor, get: getter }); } catch {}
  }

  function wrapConstructor(name) {
    const Original = globalThis[name];
    if (typeof Original !== "function") return;
    const Wrapped = preserveSurface(function (...args) {
      record(name, "construct", { args: args.map(summarize) });
      try {
        const result = Reflect.construct(Original, args, new.target || Wrapped);
        record(name, "construct-return", { result: summarize(result) });
        return result;
      } catch (error) {
        record(name, "construct-throw", { error: { name: error?.name || "Error" } });
        throw error;
      }
    }, Original);
    try { Object.setPrototypeOf(Wrapped, Original); } catch {}
    try { Wrapped.prototype = Original.prototype; } catch {}
    try { globalThis[name] = Wrapped; } catch {}
  }

  const methods = [
    [globalThis.CanvasRenderingContext2D?.prototype, "getImageData", "Canvas2D.getImageData"],
    [globalThis.CanvasRenderingContext2D?.prototype, "measureText", "Canvas2D.measureText"],
    [globalThis.HTMLCanvasElement?.prototype, "toDataURL", "HTMLCanvasElement.toDataURL"],
    [globalThis.HTMLCanvasElement?.prototype, "getContext", "HTMLCanvasElement.getContext"],
    [globalThis.OffscreenCanvas?.prototype, "getContext", "OffscreenCanvas.getContext"],
    [globalThis.WebGLRenderingContext?.prototype, "getParameter", "WebGL.getParameter"],
    [globalThis.WebGLRenderingContext?.prototype, "getSupportedExtensions", "WebGL.getSupportedExtensions"],
    [globalThis.WebGLRenderingContext?.prototype, "getExtension", "WebGL.getExtension"],
    [globalThis.WebGLRenderingContext?.prototype, "getError", "WebGL.getError"],
    [globalThis.WebGL2RenderingContext?.prototype, "getParameter", "WebGL2.getParameter"],
    [globalThis.WebGL2RenderingContext?.prototype, "getInternalformatParameter", "WebGL2.getInternalformatParameter"],
    [globalThis.WebGL2RenderingContext?.prototype, "getError", "WebGL2.getError"],
    [globalThis.FontFace?.prototype, "load", "FontFace.load"],
    [globalThis.FontFaceSet?.prototype, "check", "FontFaceSet.check"],
    [globalThis.FontFaceSet?.prototype, "load", "FontFaceSet.load"],
    [globalThis.Worker?.prototype, "postMessage", "Worker.postMessage"],
    [globalThis.Worker?.prototype, "terminate", "Worker.terminate"],
    [globalThis.URL, "createObjectURL", "URL.createObjectURL"],
    [globalThis.URL, "revokeObjectURL", "URL.revokeObjectURL"],
    [globalThis.OfflineAudioContext?.prototype, "startRendering", "OfflineAudioContext.startRendering"],
    [globalThis.AnalyserNode?.prototype, "getFloatFrequencyData", "AnalyserNode.getFloatFrequencyData"],
    [globalThis.Performance?.prototype, "now", "Performance.now"],
  ];
  for (const entry of methods) wrapMethod(...entry);

  const getters = [
    [globalThis.Navigator?.prototype, "userAgent", "Navigator.userAgent"],
    [globalThis.Navigator?.prototype, "webdriver", "Navigator.webdriver"],
    [globalThis.Navigator?.prototype, "languages", "Navigator.languages"],
    [globalThis.Navigator?.prototype, "hardwareConcurrency", "Navigator.hardwareConcurrency"],
    [globalThis.Navigator?.prototype, "deviceMemory", "Navigator.deviceMemory"],
    [globalThis.Navigator?.prototype, "plugins", "Navigator.plugins"],
    [globalThis.Screen?.prototype, "width", "Screen.width"],
    [globalThis.Screen?.prototype, "height", "Screen.height"],
    [globalThis.Document?.prototype, "visibilityState", "Document.visibilityState"],
  ];
  for (const entry of getters) wrapGetter(...entry);

  for (const name of ["Worker", "SharedWorker", "FontFace", "AudioContext", "OfflineAudioContext"]) {
    wrapConstructor(name);
  }

  Object.defineProperty(globalThis, "__veloraApiTrace", {
    // A conforming navigation receives a fresh global. Keep this diagnostic
    // property replaceable so the tracer can still report browsers that
    // incorrectly reuse an about:blank global across navigation.
    configurable: true,
    enumerable: false,
    value: {
      snapshot() {
        return {
          version: 1,
          url: location.href,
          origin: location.origin,
          elapsed: nativeNow() - startedAt,
          dropped: events.length >= MAX_EVENTS || droppedByKey.size > 0,
          eventCounts: Object.fromEntries(eventCounts),
          droppedByKey: Object.fromEntries(droppedByKey),
          events: events.slice(),
          children: [...childTraces.values()],
        };
      },
    },
  });

  if (globalThis.window === globalThis) {
    addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.__veloraApiTraceChild !== 1 || !message.trace) return;
      childTraces.set(message.realmId, message.trace);
    });
    if (window.top !== window) {
      const publish = () => {
        try {
          window.top.postMessage({
            __veloraApiTraceChild: 1,
            realmId,
            trace: globalThis.__veloraApiTrace.snapshot(),
          }, "*");
        } catch {}
      };
      addEventListener("load", publish, { once: true });
      setInterval(publish, 2000);
    }
  }
})();
