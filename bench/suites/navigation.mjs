export async function runNavigationSuite(context, factories) {
  const suite = "navigation";
  process.stdout.write(`\n${suite}\n`);
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
    const total = context.options.warmup + context.options.iterations;
    for (const [workload, url] of Object.entries(context.fixtures)) {
      for (let index = 0; index < total; index += 1) {
        const warmup = index < context.options.warmup;
        const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
        for (const factory of context.ordered(factories, `${suite}:${workload}:${index}`)) {
          const startedAt = new Date().toISOString();
          const launchError = launchErrors.get(factory.id);
          if (launchError) {
            await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error: launchError });
            continue;
          }
          let session = null;
          try {
            session = await runtimes.get(factory.id).newSession();
            const navigation = await session.navigate(`${url}?iteration=${index}`, {
              waitUntil: "domcontentloaded",
              timeoutMs: context.options.timeoutMs,
            });
            const checksum = await session.evaluate("document.querySelector('#fixture')?.getAttribute('data-checksum')");
            if (!checksum || checksum === "pending") throw new Error(`Fixture validation failed: ${checksum}`);
            await context.record({
              suite,
              workload,
              baseline: factory.id,
              iteration,
              warmup,
              startedAt,
              metrics: {
                durationMs: navigation.durationMs,
                navigationAckMs: navigation.navigationAckMs,
              },
            });
          } catch (error) {
            await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error });
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

