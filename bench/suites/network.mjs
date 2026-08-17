// Deterministic network lifecycle workloads. These exercise response size,
// redirects, delayed headers, chunked bodies, many resources and cancellation
// without relying on public internet conditions.
export async function runNetworkSuite(context, factories) {
  const suite = "network";
  if (!context.fixtureOrigin) throw new Error("network suite requires the deterministic fixture server");
  process.stdout.write(`\n${suite}\n`);
  const cases = [
    ["tiny-response", `${context.fixtureOrigin}/small.html`],
    ["large-response", `${context.fixtureOrigin}/large.html`],
    ["redirect-chain", `${context.fixtureOrigin}/redirect/3`],
    ["delayed-response", `${context.fixtureOrigin}/delayed.html?ms=30`],
    ["streaming-response", `${context.fixtureOrigin}/stream.html`],
    ["many-resources", `${context.fixtureOrigin}/resource-burst.html`],
    ["stylesheet-resource", `${context.fixtureOrigin}/stylesheet.html`],
  ];
  const total = context.options.warmup + context.options.iterations;
  for (const [workload, url] of cases) {
    for (let index = 0; index < total; index += 1) {
      const warmup = index < context.options.warmup;
      const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
      for (const factory of context.ordered(factories, `${suite}:${workload}:${index}`)) {
        const runtime = factory.create();
        let session = null;
        const startedAt = new Date().toISOString();
        try {
          await runtime.launch();
          session = await runtime.newSession();
          const started = performance.now();
          const navigationUrl = `${url}${url.includes("?") ? "&" : "?"}iteration=${index}`;
          const navigation = await session.navigate(navigationUrl, {
            waitUntil: "domcontentloaded",
            timeoutMs: context.options.timeoutMs,
            settleMs: workload === "many-resources" || workload === "stylesheet-resource" ? 500 : 0,
          });
          const resourceRequestsObserved = workload === "many-resources"
            ? Number(await session.evaluate("new Promise(resolve => setTimeout(() => resolve(window.__kokoResourceCount || 0), 500))")) || 0
            : 0;
          const body = await session.evaluate("document.documentElement?.outerHTML?.length || 0");
          const durationMs = performance.now() - started;
          await context.record({
            suite, workload, baseline: factory.id, iteration, warmup, startedAt,
            metrics: {
              durationMs,
              navigationMs: navigation.durationMs,
              navigationAckMs: navigation.navigationAckMs,
              responseCount: navigation.responseCount,
              responseCountAtReady: navigation.responseCountAtReady ?? navigation.responseCount,
              responseCountAfterSettle: navigation.responseCountAfterSettle ?? navigation.responseCount,
              responseBodyChars: Number(body) || 0,
              redirectCount: workload === "redirect-chain" ? 3 : 0,
              resourceRequestsObserved,
              stylesheetCount: workload === "stylesheet-resource"
                ? Number(await session.evaluate("document.styleSheets?.length || 0")) || 0
                : 0,
            },
          });
        } catch (error) {
          await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error });
        } finally {
          await session?.close().catch(() => {});
          await runtime.close().catch(() => {});
        }
      }
    }
  }

  for (const factory of context.ordered(factories, `${suite}:cancellation`)) {
    const totalCancellation = context.options.warmup + context.options.iterations;
    for (let index = 0; index < totalCancellation; index += 1) {
      const warmup = index < context.options.warmup;
      const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
      const runtime = factory.create();
      let session = null;
      const startedAt = new Date().toISOString();
      try {
        await runtime.launch();
        session = await runtime.newSession();
        const started = performance.now();
        const result = await session.evaluate(`(async () => {
          const controller = new AbortController();
          const request = fetch(${JSON.stringify(`${context.fixtureOrigin}/delayed.html?ms=500`)}, { signal: controller.signal });
          setTimeout(() => controller.abort(), 10);
          try { await request; return { aborted: false }; }
          catch (error) { return { aborted: error.name === "AbortError" }; }
        })()`);
        // Some runtime builds expose AbortController before wiring cancellation
        // through the fetch loader. Keep this as an explicit capability signal
        // rather than hiding the gap behind a failed benchmark observation.
        await context.record({
          suite, workload: "request-cancellation", baseline: factory.id, iteration, warmup, startedAt,
          metrics: { durationMs: performance.now() - started, cancelledRequests: result?.aborted ? 1 : 0, cancellationSupported: result?.aborted ? 1 : 0 },
        });
      } catch (error) {
        await context.record({ suite, workload: "request-cancellation", baseline: factory.id, iteration, warmup, startedAt, error });
      } finally {
        await session?.close().catch(() => {});
        await runtime.close().catch(() => {});
      }
    }
  }
}
