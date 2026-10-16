import { KokoCdpAdapter } from "../adapters/koko-cdp.mjs";

const policies = ["full", "no-images", "no-css", "text-only"];

async function navigateMixed(session, url, timeoutMs) {
  let responseCount = 0;
  let stylesheetStarted = 0;
  let imageStarted = 0;
  let scriptStarted = 0;
  let armed = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const timer = setTimeout(() => rejectReady(new Error("timed out waiting for DOMContentLoaded")), timeoutMs);
  const unsubscribe = session.client.onEvent((message) => {
    if (message.sessionId !== session.sessionId) return;
    if (message.method === "Network.requestWillBeSent") {
      const requestUrl = message.params?.request?.url ?? "";
      if (requestUrl.includes("/mixed.css")) stylesheetStarted += 1;
      else if (requestUrl.includes("/mixed.png")) imageStarted += 1;
      else if (requestUrl.includes("/mixed.js")) scriptStarted += 1;
    }
    if (message.method === "Network.responseReceived") {
      const responseUrl = message.params?.response?.url ?? "";
      if (responseUrl.includes("/mixed")) responseCount += 1;
    }
    // Page.navigate's result is sent before frameNavigated. Arm only for this
    // document so about:blank's DOMContentLoaded cannot resolve the wait.
    if (message.method === "Page.frameNavigated" && String(message.params?.frame?.url ?? "").includes("/mixed.html")) {
      armed = true;
    }
    if (message.method === "Page.domContentEventFired" && armed) resolveReady();
  });
  const started = performance.now();
  try {
    await session.client.send("Page.navigate", { url }, session.sessionId, timeoutMs);
    await ready;
    return {
      durationMs: performance.now() - started,
      responseCountAtReady: responseCount,
      stylesheetStarted,
      imageStarted,
      scriptStarted,
    };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export async function runResourcePolicySuite(context, factories) {
  const suite = "resource-policy";
  process.stdout.write(`\n${suite}\n`);
  if (!factories.some((factory) => factory.id === "koko-cdp")) {
    process.stdout.write("  skipped: koko-cdp baseline is not selected\n");
    return;
  }
  if (!context.fixtureOrigin) throw new Error("resource-policy suite requires the local fixture server");

  const total = context.options.warmup + context.options.iterations;
  for (const policy of policies) {
    const runtime = new KokoCdpAdapter({
      ...context.adapterOptions,
      resourcePolicy: policy,
    });
    try {
      await runtime.launch();
      for (let index = 0; index < total; index += 1) {
        const warmup = index < context.options.warmup;
        const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
        const startedAt = new Date().toISOString();
        let session = null;
        try {
          session = await runtime.newSession();
          const navigation = await navigateMixed(
            session,
            `${context.fixtureOrigin}/mixed.html`,
            context.options.timeoutMs,
          );
          const content = await session.evaluate(`({
            elements: document.getElementsByTagName("*").length,
            text: (document.body && document.body.innerText || "").length,
            scriptRan: document.documentElement.dataset.mixedScript || "",
          })`);
          await context.record({
            suite,
            workload: "mixed",
            baseline: policy,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: navigation.durationMs,
              responseCountAtReady: navigation.responseCountAtReady,
              stylesheetStarted: navigation.stylesheetStarted,
              imageStarted: navigation.imageStarted,
              scriptStarted: navigation.scriptStarted,
              elementCount: content?.elements ?? 0,
              textChars: content?.text ?? 0,
              scriptRan: content?.scriptRan === "ran" ? 1 : 0,
            },
          });
          process.stdout.write(`  ${suite}/mixed ${policy} #${iteration}${warmup ? " warmup" : ""}: ok\n`);
        } catch (error) {
          process.stdout.write(`  ${suite}/mixed ${policy} #${iteration}${warmup ? " warmup" : ""}: fail\n`);
          await context.record({ suite, workload: "mixed", baseline: policy, iteration, warmup, startedAt, error });
        } finally {
          await session?.close().catch(() => {});
        }
      }
    } finally {
      await runtime.close().catch(() => {});
    }
  }
}
