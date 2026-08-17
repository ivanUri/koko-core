// DOM and JavaScript pressure workloads. Each operation returns a compact
// checksum so the benchmark validates correctness instead of timing failures.
export async function runDomJsSuite(context, factories) {
  const suite = "dom-js";
  const urls = [context.fixtures.dynamic, context.fixtures.medium];
  if (urls.some((url) => !url)) throw new Error("dom-js suite requires dynamic and medium fixtures");
  const workloads = [
    ["dom-create-mutate", urls[0], `(() => {
      const root = document.createElement("section");
      root.id = "bench-dom-root";
      for (let i = 0; i < 1000; i++) { const node = document.createElement("div"); node.dataset.i = String(i); node.textContent = "value-" + i; root.appendChild(node); }
      document.body.appendChild(root);
      const count = root.querySelectorAll("[data-i]").length;
      root.firstElementChild.textContent = "mutated";
      root.remove();
      return count;
    })()`],
    ["selector-lookup", urls[1], `(() => {
      let count = 0;
      for (let i = 0; i < 500; i++) count += document.querySelectorAll("article[data-index]").length;
      return count;
    })()`],
    ["timers-microtasks", urls[0], `(async () => {
      let value = 0;
      for (let i = 0; i < 250; i++) await Promise.resolve().then(() => { value += i; });
      await new Promise(resolve => setTimeout(resolve, 5));
      return value;
    })()`],
  ];
  const total = context.options.warmup + context.options.iterations;
  for (const [workload, url, expression] of workloads) {
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
          await session.navigate(`${url}?domJs=${index}`, { waitUntil: "domcontentloaded", timeoutMs: context.options.timeoutMs });
          const started = performance.now();
          const result = await session.evaluate(expression);
          const durationMs = performance.now() - started;
          if (!Number.isFinite(Number(result)) || Number(result) <= 0) throw new Error(`invalid DOM/JS checksum: ${result}`);
          await context.record({
            suite, workload, baseline: factory.id, iteration, warmup, startedAt,
            metrics: { durationMs, operations: workload === "selector-lookup" ? 500 : workload === "timers-microtasks" ? 250 : 1000, operationsPerSecond: (workload === "selector-lookup" ? 500 : workload === "timers-microtasks" ? 250 : 1000) / (durationMs / 1000), checksum: Number(result) },
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
}
