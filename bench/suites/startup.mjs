import { sampleProcessTree } from "../common/process-tree.mjs";

export async function runStartupSuite(context, factories) {
  const suite = "startup";
  process.stdout.write(`\n${suite}\n`);
  const total = context.options.warmup + context.options.iterations;
  for (let index = 0; index < total; index += 1) {
    const warmup = index < context.options.warmup;
    const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
    for (const factory of context.ordered(factories, `${suite}:${index}`)) {
      const runtime = factory.create();
      let session = null;
      const startedAt = new Date().toISOString();
      const started = performance.now();
      try {
        await runtime.launch();
        session = await runtime.newSession();
        const navigation = await session.navigate(context.fixtures.small, {
          waitUntil: "domcontentloaded",
          timeoutMs: context.options.timeoutMs,
        });
        const checksum = await session.evaluate("document.querySelector('#fixture')?.getAttribute('data-checksum')");
        if (checksum !== "small-v1") throw new Error(`Fixture validation failed: ${checksum}`);
        const firstDocumentMs = performance.now() - started;
        const memory = await sampleProcessTree(runtime.pid, { samples: 3, intervalMs: 50 });
        await context.record({
          suite,
          workload: "first-document",
          baseline: factory.id,
          iteration,
          warmup,
          startedAt,
          metrics: {
            durationMs: firstDocumentMs,
            processReadyMs: runtime.launchMetrics.processReadyMs,
            firstSessionMs: session.timings.durationMs,
            firstNavigationMs: navigation.durationMs,
            readyRssBytes: memory.rssBytes,
            readyProcessCount: memory.processCount,
          },
        });
      } catch (error) {
        await context.record({ suite, workload: "first-document", baseline: factory.id, iteration, warmup, startedAt, error });
      } finally {
        await session?.close().catch(() => {});
        await runtime.close().catch(() => {});
      }
    }
  }
}
