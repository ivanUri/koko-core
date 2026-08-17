export async function runSessionLifecycleSuite(context, factories) {
  const suite = "session-lifecycle";
  const workload = "create-and-dispose";
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
    for (let index = 0; index < total; index += 1) {
      const warmup = index < context.options.warmup;
      const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
      for (const factory of context.ordered(factories, `${suite}:${index}`)) {
        const startedAt = new Date().toISOString();
        const launchError = launchErrors.get(factory.id);
        if (launchError) {
          await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error: launchError });
          continue;
        }
        let session = null;
        const started = performance.now();
        try {
          session = await runtimes.get(factory.id).newSession();
          const created = performance.now();
          await session.close();
          const disposed = performance.now();
          await context.record({
            suite,
            workload,
            baseline: factory.id,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: disposed - started,
              createMs: created - started,
              disposeMs: disposed - created,
              contextMs: session.timings.contextMs,
              targetMs: session.timings.targetMs,
              attachMs: session.timings.attachMs,
              connectMs: session.timings.connectMs ?? 0,
            },
          });
        } catch (error) {
          await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error });
        } finally {
          await session?.close().catch(() => {});
        }
      }
    }
  } finally {
    for (const runtime of runtimes.values()) await runtime.close().catch(() => {});
  }
}

