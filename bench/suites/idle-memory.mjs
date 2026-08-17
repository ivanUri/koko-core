import { sampleProcessTree } from "../common/process-tree.mjs";

export async function runIdleMemorySuite(context, factories) {
  const suite = "idle-memory";
  process.stdout.write(`\n${suite}\n`);
  for (const density of context.options.densities) {
    const workload = `${density}-sessions`;
    const total = context.options.memoryWarmup + context.options.memoryIterations;
    for (let index = 0; index < total; index += 1) {
      const warmup = index < context.options.memoryWarmup;
      const iteration = warmup ? index + 1 : index - context.options.memoryWarmup + 1;
      for (const factory of context.ordered(factories, `${suite}:${density}:${index}`)) {
        const runtime = factory.create();
        const sessions = [];
        const startedAt = new Date().toISOString();
        try {
          await runtime.launch();
          const baseline = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          const createStarted = performance.now();
          for (let sessionIndex = 0; sessionIndex < density; sessionIndex += 1) {
            sessions.push(await runtime.newSession());
          }
          const createDurationMs = performance.now() - createStarted;
          const activeCount = Math.min(context.options.activeSessions, sessions.length);
          const activeStarted = performance.now();
          if (activeCount > 0) {
            const activeUrl = context.fixtures.medium;
            if (!activeUrl) throw new Error("idle active-session workload requires the medium fixture");
            await Promise.all(sessions.slice(0, activeCount).map((session, sessionIndex) => session.navigate(
              `${activeUrl}?idleActive=${index}&session=${sessionIndex}`,
              { waitUntil: "domcontentloaded", timeoutMs: context.options.timeoutMs },
            )));
          }
          const activeDurationMs = activeCount > 0 ? performance.now() - activeStarted : 0;
          if (context.options.idleSettleMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, context.options.idleSettleMs));
          }
          const loaded = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          const incrementalRssBytes = loaded.rssBytes - baseline.rssBytes;
          await context.record({
            suite,
            workload,
            baseline: factory.id,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: createDurationMs,
              sessionCount: density,
              activeSessionCount: activeCount,
              activeNavigationMs: activeDurationMs,
              baselineRssBytes: baseline.rssBytes,
              rssBytes: loaded.rssBytes,
              peakRssBytes: loaded.peakRssBytes,
              incrementalRssBytes,
              rssPerSessionBytes: incrementalRssBytes / density,
              processCount: loaded.processCount,
              threadCount: loaded.threadCount,
              averageCpuPercent: loaded.averageCpuPercent,
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
