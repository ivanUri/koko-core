import { sampleProcessTree } from "../common/process-tree.mjs";

// A deterministic large-document lane for the failure mode that matters to
// browser runtimes: parsing a site-sized DOM, then running a realistic query
// and short-lived heap workload without retaining the result after teardown.
export async function runHeavySiteSuite(context, factories) {
  const suite = "heavy-site";
  const url = context.fixtures.heavy;
  if (!url) throw new Error("heavy-site suite requires the deterministic heavy fixture");
  process.stdout.write(`\n${suite}\n`);

  const total = context.options.warmup + context.options.iterations;
  for (let index = 0; index < total; index += 1) {
    const warmup = index < context.options.warmup;
    const iteration = warmup ? index + 1 : index - context.options.warmup + 1;
    for (const factory of context.ordered(factories, `${suite}:${index}`)) {
      const runtime = factory.create();
      let session = null;
      const startedAt = new Date().toISOString();
      try {
        await runtime.launch();
        const baseline = await sampleProcessTree(runtime.pid, context.options.memorySampling);
        session = await runtime.newSession();
        const started = performance.now();
        const navigation = await session.navigate(`${url}?iteration=${index}`, {
          waitUntil: "domcontentloaded",
          timeoutMs: context.options.timeoutMs,
        });
        const evaluationStarted = performance.now();
        const result = await session.evaluate(`(() => {
          const nodes = [...document.querySelectorAll("article[data-index]")];
          const buckets = new Map();
          let checksum = 0;
          for (const node of nodes) {
            const index = Number(node.dataset.index);
            const bucket = node.dataset.bucket;
            buckets.set(bucket, (buckets.get(bucket) || 0) + index);
            checksum = (checksum + index * 17) % 1000000007;
          }
          const transient = nodes.map((node) => ({
            index: Number(node.dataset.index),
            textLength: node.textContent.length,
            bucket: node.dataset.bucket,
          })).filter((entry) => entry.index % 3 === 0);
          const transientChecksum = transient.reduce((sum, entry) => sum + entry.index + entry.textLength, 0);
          return {
            checksum: checksum + transientChecksum + buckets.size,
            elementCount: nodes.length,
            bucketCount: buckets.size,
            htmlChars: document.documentElement.outerHTML.length,
            transientCount: transient.length,
          };
        })()`);
        const loaded = await sampleProcessTree(runtime.pid, context.options.memorySampling);
        if (!result || result.elementCount < 12_000 || result.bucketCount !== 32) {
          throw new Error(`heavy fixture validation failed: ${JSON.stringify(result)}`);
        }
        const incrementalRssBytes = loaded.rssBytes - baseline.rssBytes;
        const incrementalVirtualMemoryBytes = loaded.virtualMemoryBytes - baseline.virtualMemoryBytes;
        await context.record({
          suite,
          workload: "dom-js-12k",
          baseline: factory.id,
          iteration,
          warmup,
          startedAt,
          metrics: {
            durationMs: performance.now() - started,
            navigationMs: navigation.durationMs,
            navigationAckMs: navigation.navigationAckMs,
            evaluationMs: performance.now() - evaluationStarted,
            responseCount: navigation.responseCount,
            htmlChars: result.htmlChars,
            elementCount: result.elementCount,
            bucketCount: result.bucketCount,
            transientCount: result.transientCount,
            checksum: result.checksum,
            baselineRssBytes: baseline.rssBytes,
            rssBytes: loaded.rssBytes,
            peakRssBytes: loaded.peakRssBytes,
            incrementalRssBytes,
            rssPerSessionBytes: incrementalRssBytes,
            baselineVirtualMemoryBytes: baseline.virtualMemoryBytes,
            virtualMemoryBytes: loaded.virtualMemoryBytes,
            peakVirtualMemoryBytes: loaded.peakVirtualMemoryBytes,
            incrementalVirtualMemoryBytes,
            virtualMemoryPerSessionBytes: incrementalVirtualMemoryBytes,
            processCount: loaded.processCount,
            threadCount: loaded.threadCount,
            averageCpuPercent: loaded.averageCpuPercent,
          },
        });
      } catch (error) {
        await context.record({ suite, workload: "dom-js-12k", baseline: factory.id, iteration, warmup, startedAt, error });
      } finally {
        await session?.close().catch(() => {});
        await runtime.close().catch(() => {});
      }
    }
  }
}
