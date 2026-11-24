import { sampleProcessTree } from "../common/process-tree.mjs";
import { createRawCdpSession } from "../adapters/cdp-session.mjs";

// Reuses one CDP socket while replacing the BrowserContext. Koko's worker
// recycle policy is evaluated at this boundary, so this catches retained DOM,
// arena and V8 heap state that a reused-session navigation cannot expose.
export async function runContextRecycleSuite(context, factories) {
  const suite = "context-recycle";
  const url = context.fixtures.heavy;
  if (!url) throw new Error("context-recycle suite requires the deterministic heavy fixture");
  process.stdout.write("\n" + suite + "\n");

  const total = context.options.warmup + context.options.iterations;
  for (const factory of context.ordered(factories, suite)) {
    const runtime = factory.create();
    let session = null;
    let client = null;
    const startedAt = new Date().toISOString();
    try {
      await runtime.launch();
      const baseline = await sampleProcessTree(runtime.pid, context.options.memorySampling);
      session = await runtime.newSession();
      client = session.client;
      for (let index = 0; index < total; index += 1) {
        const warmup = index < context.options.warmup;
        const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
        const started = performance.now();
        try {
          const navigation = await session.navigate(url + "?contextRecycle=" + index, {
            waitUntil: "domcontentloaded",
            timeoutMs: context.options.timeoutMs,
          });
          const checksum = await session.evaluate([
            "(() => {",
            "const nodes = document.querySelectorAll(\"article[data-index]\");",
            "let value = 0;",
            "for (const node of nodes) value = (value + Number(node.dataset.index)) % 1000000007;",
            "return { count: nodes.length, value };",
            "})()",
          ].join("\n"));
          if (!checksum || checksum.count < 12_000) {
            throw new Error("context-recycle fixture validation failed: " + JSON.stringify(checksum));
          }
          const loaded = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          await session.closeContextForReuse();
          session = null;
          const disposed = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          let recycled = disposed;
          if (index + 1 < total) {
            // BrowserContext creation is the safe worker-recycle boundary.
            // Sample after it so the report distinguishes detached-page
            // disposal from the subsequent V8/arena reclaim.
            session = await createRawCdpSession(client, { ownerClient: false });
            recycled = await sampleProcessTree(runtime.pid, context.options.memorySampling);
          }
          await context.record({
            suite,
            workload: "heavy-context-cycle",
            baseline: factory.id,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: performance.now() - started,
              navigationMs: navigation.durationMs,
              navigationAckMs: navigation.navigationAckMs,
              elementCount: checksum.count,
              checksum: checksum.value,
              rssBytes: loaded.rssBytes,
              peakRssBytes: loaded.peakRssBytes,
              postDisposeRssBytes: disposed.rssBytes,
              postRecycleRssBytes: recycled.rssBytes,
              rssDeltaBytes: disposed.rssBytes - baseline.rssBytes,
              virtualMemoryBytes: loaded.virtualMemoryBytes,
              peakVirtualMemoryBytes: loaded.peakVirtualMemoryBytes,
              postDisposeVirtualMemoryBytes: disposed.virtualMemoryBytes,
              postRecycleVirtualMemoryBytes: recycled.virtualMemoryBytes,
              virtualMemoryDeltaBytes: disposed.virtualMemoryBytes - baseline.virtualMemoryBytes,
              processCount: recycled.processCount,
              threadCount: recycled.threadCount,
              averageCpuPercent: recycled.averageCpuPercent,
            },
          });
        } catch (error) {
          await context.record({ suite, workload: "heavy-context-cycle", baseline: factory.id, iteration, warmup, startedAt, error });
          break;
        }
      }
    } catch (error) {
      await context.record({ suite, workload: "heavy-context-cycle", baseline: factory.id, iteration: 1, warmup: false, startedAt, error });
    } finally {
      await session?.close().catch(() => {});
      if (client && !session) await client.close().catch(() => {});
      await runtime.close().catch(() => {});
    }
  }
}
