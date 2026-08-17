export class CdpSession {
  constructor({ client, ownerClient = false, contextId, targetId, sessionId, timings }) {
    this.client = client;
    this.ownerClient = ownerClient;
    this.contextId = contextId;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.timings = timings;
    this.closed = false;
  }

  async navigate(url, { waitUntil = "domcontentloaded", timeoutMs = 30_000, settleMs = 0 } = {}) {
    const eventName = waitUntil === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    let documentResponse = null;
    let responseCount = 0;
    const unsubscribe = this.client.onEvent((message) => {
      if (message.sessionId !== this.sessionId || message.method !== "Network.responseReceived") return;
      responseCount += 1;
      if (message.params?.type === "Document") documentResponse = message.params.response;
    });
    const ready = this.client.waitForEvent(
      eventName,
      (message) => message.sessionId === this.sessionId,
      timeoutMs,
    );
    // Keep a failed Page.navigate from leaving a later event-timeout rejection
    // unobserved while still allowing `await ready` below to throw normally.
    ready.catch(() => {});
    const started = performance.now();
    try {
      await this.client.send("Page.navigate", { url }, this.sessionId, timeoutMs);
      const navigationAckMs = performance.now() - started;
      await ready;
      const readyDurationMs = performance.now() - started;
      const responseCountAtReady = responseCount;
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      return {
        durationMs: readyDurationMs,
        navigationAckMs,
        readyDurationMs,
        settleMs,
        responseCountAtReady,
        responseCountAfterSettle: responseCount,
        httpStatus: documentResponse?.status ?? null,
        responseCount,
        responseUrl: documentResponse?.url ?? null,
      };
    } finally {
      unsubscribe();
    }
  }

  async evaluate(expression, timeoutMs = 30_000) {
    const response = await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? "Runtime.evaluate failed");
    }
    return response.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      // The runtime may already be shutting down after a failed iteration.
    }
    try {
      await this.client.send("Target.disposeBrowserContext", { browserContextId: this.contextId });
    } catch {
      // Closing the owning socket below is the final cleanup path for Koko.
    }
    if (this.ownerClient) await this.client.close();
  }
}

export async function createRawCdpSession(client, { ownerClient = false } = {}) {
  const started = performance.now();
  const contextStarted = performance.now();
  const { browserContextId: contextId } = await client.send("Target.createBrowserContext");
  const contextReady = performance.now();
  const { targetId } = await client.send("Target.createTarget", {
    url: "about:blank",
    browserContextId: contextId,
  });
  const targetReady = performance.now();
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const attached = performance.now();
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Network.enable", {}, sessionId);
  await client.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
  const ready = performance.now();
  return new CdpSession({
    client,
    ownerClient,
    contextId,
    targetId,
    sessionId,
    timings: {
      durationMs: ready - started,
      contextMs: contextReady - contextStarted,
      targetMs: targetReady - contextReady,
      attachMs: attached - targetReady,
      domainsMs: ready - attached,
    },
  });
}
