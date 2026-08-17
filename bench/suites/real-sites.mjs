function pageStateExpression() {
  return `(() => {
    const root = document.documentElement;
    return {
      finalUrl: location.href,
      title: document.title,
      htmlChars: root?.outerHTML?.length ?? 0,
      textChars: document.body?.textContent?.length ?? 0,
      elementCount: document.getElementsByTagName('*').length,
    };
  })()`;
}

export async function runRealSitesSuite(context, factories) {
  const suite = "real-sites";
  process.stdout.write(`\n${suite} (external network; results are not deterministic)\n`);
  const runtimes = new Map();
  const launchErrors = new Map();
  for (const factory of factories) {
    const runtime = factory.create();
    try {
      await runtime.launch();
      runtimes.set(factory.id, runtime);
    } catch (error) {
      launchErrors.set(factory.id, error);
      await runtime.close().catch(() => {});
    }
  }

  try {
    const total = context.options.realSiteWarmup + context.options.realSiteIterations;
    for (const site of context.realSites) {
      for (let index = 0; index < total; index += 1) {
        const warmup = index < context.options.realSiteWarmup;
        const iteration = warmup ? index + 1 : index - context.options.realSiteWarmup + 1;
        for (const factory of context.ordered(factories, `${suite}:${site.id}:${index}`)) {
          const startedAt = new Date().toISOString();
          const launchError = launchErrors.get(factory.id);
          if (launchError) {
            await context.record({
              suite,
              workload: site.id,
              baseline: factory.id,
              iteration,
              warmup,
              startedAt,
              details: { requestedUrl: site.url, category: site.category },
              error: launchError,
            });
            continue;
          }
          let session = null;
          let details = { requestedUrl: site.url, category: site.category };
          try {
            session = await runtimes.get(factory.id).newSession();
            const navigation = await session.navigate(site.url, {
              waitUntil: "domcontentloaded",
              timeoutMs: context.options.realSiteTimeoutMs,
            });
            const pageState = await session.evaluate(pageStateExpression(), context.options.realSiteTimeoutMs);
            details = {
              ...details,
              finalUrl: pageState?.finalUrl ?? navigation.responseUrl,
              title: pageState?.title ?? "",
            };
            if (!pageState || pageState.htmlChars < 100 || pageState.elementCount < 2) {
              throw new Error(`Document validation failed: ${JSON.stringify(pageState)}`);
            }
            if (Number.isFinite(navigation.httpStatus) && navigation.httpStatus >= 400) {
              throw new Error(`Main document returned HTTP ${navigation.httpStatus}`);
            }
            await context.record({
              suite,
              workload: site.id,
              baseline: factory.id,
              iteration,
              warmup,
              startedAt,
              details,
              metrics: {
                durationMs: navigation.durationMs,
                navigationAckMs: navigation.navigationAckMs,
                postAckToDomContentLoadedMs: navigation.durationMs - navigation.navigationAckMs,
                httpStatus: navigation.httpStatus ?? 0,
                responseCount: navigation.responseCount ?? 0,
                htmlChars: pageState.htmlChars,
                textChars: pageState.textChars,
                elementCount: pageState.elementCount,
              },
            });
          } catch (error) {
            await context.record({
              suite,
              workload: site.id,
              baseline: factory.id,
              iteration,
              warmup,
              startedAt,
              details,
              error,
            });
          } finally {
            await session?.close().catch(() => {});
          }
        }
      }
    }
  } finally {
    for (const runtime of runtimes.values()) await runtime.close().catch(() => {});
  }
}
