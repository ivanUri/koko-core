import { sampleProcessTree } from "../common/process-tree.mjs";

// Reuses one browser session for many navigations to catch retained arenas,
// stale scheduler tasks and lifecycle leaks that idle snapshots cannot see.
export async function runLongRunSuite(context, factories) {
  const suite = "long-run";
  const url = context.fixtures.dynamic;
  if (!url) throw new Error("long-run suite requires the deterministic dynamic fixture");
  process.stdout.write(`\n${suite}\n`);

  for (const factory of context.ordered(factories, suite)) {
    const runtime = factory.create();
    let session = null;
    const startedAt = new Date().toISOString();
    try {
      await runtime.launch();
      const before = await sampleProcessTree(runtime.pid, context.options.memorySampling);
      session = await runtime.newSession();
      const total = context.options.longRunWarmup + context.options.longRunIterations;
      for (let index = 0; index < total; index += 1) {
        const warmup = index < context.options.longRunWarmup;
        const iteration = warmup ? index + 1 : index - context.options.longRunWarmup + 1;
        const iterationStarted = performance.now();
        try {
          const navigation = await session.navigate(
            `${url}?longRun=${index}`,
            { waitUntil: "domcontentloaded", timeoutMs: context.options.timeoutMs },
          );
          const checksum = await session.evaluate("document.querySelector('#fixture')?.getAttribute('data-checksum')");
          if (!checksum || checksum === "pending") throw new Error(`Fixture validation failed: ${checksum}`);
          await context.record({
            suite,
            workload: "reused-session-navigation",
            baseline: factory.id,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: performance.now() - iterationStarted,
              navigationMs: navigation.durationMs,
              navigationAckMs: navigation.navigationAckMs,
              sessionCount: 1,
            },
          });
        } catch (error) {
          await context.record({ suite, workload: "reused-session-navigation", baseline: factory.id, iteration, warmup, startedAt, error });
        }
      }
      const after = await sampleProcessTree(runtime.pid, context.options.memorySampling);
      await context.record({
        suite,
        workload: "reused-session-stability",
        baseline: factory.id,
        iteration: 1,
        warmup: false,
        startedAt,
        metrics: {
          durationMs: 0,
          navigationCount: total,
          baselineRssBytes: before.rssBytes,
          rssBytes: after.rssBytes,
          peakRssBytes: after.peakRssBytes,
          rssDeltaBytes: after.rssBytes - before.rssBytes,
          averageCpuPercent: after.averageCpuPercent,
          processCount: after.processCount,
          threadCount: after.threadCount,
        },
      });
    } catch (error) {
      await context.record({ suite, workload: "reused-session-stability", baseline: factory.id, iteration: 1, warmup: false, startedAt, error });
    } finally {
      await session?.close().catch(() => {});
      await runtime.close().catch(() => {});
    }
  }
}
