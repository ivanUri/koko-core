import { sampleProcessTree } from "../common/process-tree.mjs";

// Measures simultaneous navigation across isolated CDP contexts. Koko maps
// one CDP connection to one Browser/Session, while Chromium maps each
// connection to an isolated BrowserContext.
export async function runConcurrencySuite(context, factories) {
  const suite = "concurrency";
  const url = context.fixtures.medium;
  if (!url) throw new Error("concurrency suite requires the deterministic medium fixture");
  process.stdout.write(`\n${suite}\n`);

  for (const density of context.options.densities) {
    const workload = `${density}-concurrent-pages`;
    const total = context.options.concurrencyWarmup + context.options.concurrencyIterations;
    for (let index = 0; index < total; index += 1) {
      const warmup = index < context.options.concurrencyWarmup;
      const iteration = warmup ? index + 1 : index - context.options.concurrencyWarmup + 1;
      for (const factory of context.ordered(factories, `${suite}:${density}:${index}`)) {
        const runtime = factory.create();
        const sessions = [];
        const startedAt = new Date().toISOString();
        try {
          await runtime.launch();
          const baseline = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          const createStarted = performance.now();
          sessions.push(...await Promise.all(Array.from({ length: density }, () => runtime.newSession())));
          const sessionCreateMs = performance.now() - createStarted;

          const navigationStarted = performance.now();
          const navigations = await Promise.all(sessions.map((session, sessionIndex) => session.navigate(
            `${url}?iteration=${index}&session=${sessionIndex}`,
            { waitUntil: "domcontentloaded", timeoutMs: context.options.timeoutMs },
          )));
          const navigationWallMs = performance.now() - navigationStarted;
          const checksums = await Promise.all(sessions.map((session) => session.evaluate(
            "document.querySelector('#fixture')?.getAttribute('data-checksum')",
          )));
          if (checksums.some((checksum) => !checksum || checksum === "pending")) {
            throw new Error("Concurrent fixture validation failed");
          }

          const loaded = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          const incrementalRssBytes = loaded.rssBytes - baseline.rssBytes;
          const totalNavigationMs = navigations.reduce((sum, navigation) => sum + navigation.durationMs, 0);
          const wallSeconds = navigationWallMs / 1000;
          const cpuSeconds = (loaded.averageCpuPercent / 100) * wallSeconds;
          await context.record({
            suite,
            workload,
            baseline: factory.id,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: navigationWallMs,
              navigationWallMs,
              totalNavigationMs,
              sessionCreateMs,
              throughputPagesPerSecond: density / (navigationWallMs / 1000),
              sessionCount: density,
              baselineRssBytes: baseline.rssBytes,
              rssBytes: loaded.rssBytes,
              peakRssBytes: loaded.peakRssBytes,
              incrementalRssBytes,
              rssPerSessionBytes: incrementalRssBytes / density,
              processCount: loaded.processCount,
              threadCount: loaded.threadCount,
              averageCpuPercent: loaded.averageCpuPercent,
              workPerGigabyte: incrementalRssBytes > 0 ? density / (incrementalRssBytes / 1_000_000_000) : 0,
              workPerCpuSecond: cpuSeconds > 0 ? density / cpuSeconds : 0,
            },
          });
        } catch (error) {
          await context.record({ suite, workload, baseline: factory.id, iteration, warmup, startedAt, error });
        } finally {
          for (const session of sessions.reverse()) await session.close().catch(() => {});
          await runtime.close().catch(() => {});
        }
      }
    }
  }
}
