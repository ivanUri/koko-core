const DEFAULT_TIMEOUT_MS = 30_000;

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function fetchJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function waitForJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${errorMessage(lastError)}`);
}

export function connectCdp(webSocketDebuggerUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("The benchmark requires Node.js 22+ (global WebSocket support)");
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const eventListeners = new Set();
    let nextId = 1;
    let closed = false;

    const openingTimer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting to ${webSocketDebuggerUrl}`));
    }, timeoutMs);

    function rejectPending(error) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    }

    const client = {
      get closed() {
        return closed;
      },

      send(method, params = {}, sessionId = undefined, commandTimeoutMs = timeoutMs) {
        if (closed || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error(`CDP socket is not open for ${method}`));
        }
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`Timed out waiting for CDP command ${method}`));
          }, commandTimeoutMs);
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer, method });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },

      waitForEvent(method, predicate = () => true, eventTimeoutMs = timeoutMs) {
        return new Promise((resolveEvent, rejectEvent) => {
          const timer = setTimeout(() => {
            eventListeners.delete(listener);
            rejectEvent(new Error(`Timed out waiting for CDP event ${method}`));
          }, eventTimeoutMs);
          const listener = (message) => {
            if (message.method !== method || !predicate(message)) return;
            clearTimeout(timer);
            eventListeners.delete(listener);
            resolveEvent(message);
          };
          eventListeners.add(listener);
        });
      },

      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },

      async close() {
        if (closed) return;
        await new Promise((resolveClose) => {
          const timer = setTimeout(resolveClose, 250);
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            resolveClose();
          }, { once: true });
          socket.close();
        });
      },
    };

    socket.addEventListener("open", () => {
      clearTimeout(openingTimer);
      resolve(client);
    }, { once: true });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(`${entry.method}: ${message.error.message} (${message.error.code})`));
        } else {
          entry.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method) {
        for (const listener of eventListeners) listener(message);
      }
    });

    socket.addEventListener("error", () => {
      const error = new Error(`CDP WebSocket error at ${webSocketDebuggerUrl}`);
      if (socket.readyState !== WebSocket.OPEN) {
        clearTimeout(openingTimer);
        reject(error);
      }
      rejectPending(error);
    });

    socket.addEventListener("close", () => {
      closed = true;
      rejectPending(new Error(`CDP WebSocket closed at ${webSocketDebuggerUrl}`));
    });
  });
}

