(function () {
  if (typeof WebSocket === "undefined") return;
  const Native = WebSocket;

  function isValidProtocolChar(c) {
    if (c <= 31 || c >= 127) return false;
    switch (c) {
      case 40: case 41: case 60: case 62: case 64: case 44: case 59: case 58:
      case 92: case 34: case 47: case 91: case 93: case 63: case 61: case 123:
      case 125: case 32: case 9:
        return false;
      default:
        return true;
    }
  }

  function validateProtocol(protocol) {
    if (protocol === "") throw new DOMException("", "SyntaxError");
    for (let i = 0; i < protocol.length; i++) {
      if (!isValidProtocolChar(protocol.charCodeAt(i))) {
        throw new DOMException("", "SyntaxError");
      }
    }
  }

  function validateProtocols(protocols) {
    if (protocols === undefined) return;
    const list = Array.isArray(protocols) ? protocols : [String(protocols)];
    const seen = new Set();
    for (const entry of list) {
      const protocol = String(entry);
      validateProtocol(protocol);
      const key = protocol.toLowerCase();
      if (seen.has(key)) throw new DOMException("", "SyntaxError");
      seen.add(key);
    }
  }

  function validateUrl(url) {
    const input = url == null ? "" : String(url);
    if (input.includes("#")) throw new DOMException("", "SyntaxError");
    let parsed;
    try {
      parsed = new URL(input, document.baseURI);
    } catch (e) {
      throw new DOMException("", "SyntaxError");
    }
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    else if (parsed.protocol === "https:") parsed.protocol = "wss:";
    else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new DOMException("", "SyntaxError");
    }
  }

  function WebSocketWrapper(url, protocols) {
    if (new.target) {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 0) {
        if (args[0] == null) args[0] = "";
        else if (typeof args[0] !== "string") args[0] = String(args[0]);
      }
      validateUrl(args[0]);
      validateProtocols(protocols);
      return Reflect.construct(Native, args, new.target);
    }
    throw new TypeError("Illegal constructor");
  }

  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(WebSocketWrapper, name, {
      value: Native[name],
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  Object.defineProperty(WebSocketWrapper, "prototype", {
    value: Native.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(WebSocketWrapper, "name", { value: "WebSocket", configurable: true });
  Object.defineProperty(WebSocketWrapper, "length", { value: Native.length, configurable: true });
  Object.defineProperty(WebSocketWrapper.prototype, "constructor", {
    value: WebSocketWrapper,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const nativeClose = Native.prototype.close;
  const nativeSend = Native.prototype.send;

  function toCloseCode(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return 0;
    return num >>> 0 & 0xffff;
  }

  function validateCloseCode(code) {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("", "InvalidAccessError");
    }
  }

  function reasonUtf8ByteLength(reason) {
    return new TextEncoder().encode(String(reason)).length;
  }

  function closeWrapper(code, reason) {
    const argc = arguments.length;
    if (argc >= 1 && arguments[0] !== undefined && arguments[0] !== null) {
      validateCloseCode(toCloseCode(arguments[0]));
    }
    if (argc >= 2 && arguments[1] !== undefined && arguments[1] !== null) {
      if (reasonUtf8ByteLength(arguments[1]) > 123) {
        throw new DOMException("", "SyntaxError");
      }
    }
    return nativeClose.apply(this, arguments);
  }

  function sendWrapper(data) {
    if (this.readyState !== Native.OPEN) {
      throw new DOMException("", "InvalidStateError");
    }
    return nativeSend.apply(this, arguments);
  }

  Object.defineProperty(Native.prototype, "close", {
    value: closeWrapper,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(Native.prototype, "send", {
    value: sendWrapper,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  globalThis.WebSocket = WebSocketWrapper;
})();