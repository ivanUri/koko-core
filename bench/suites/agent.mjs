// Representative AI-agent loop: navigate, inspect, interact, then extract a
// stable result. This measures task completion rather than page-load alone.
export async function runAgentSuite(context, factories) {
  const suite = "agent";
  const url = context.fixtures.dynamic;
  if (!url) throw new Error("agent suite requires the deterministic dynamic fixture");
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
        session = await runtime.newSession();
        const started = performance.now();
        await session.navigate(`${url}?agent=${index}`, { waitUntil: "domcontentloaded", timeoutMs: context.options.timeoutMs });
        const result = await session.evaluate(`(() => {
          const articles = [...document.querySelectorAll("article[data-index]")];
          const target = articles[17];
          const button = document.createElement("button");
          button.id = "agent-action";
          button.textContent = "inspect";
          button.addEventListener("click", () => button.dataset.clicked = "true");
          document.body.appendChild(button);
          button.click();
          return { title: document.title, articleCount: articles.length, selected: target?.textContent || "", clicked: button.dataset.clicked === "true" };
        })()`);
        if (!result?.clicked || result.articleCount !== 300 || !result.selected) throw new Error("agent workflow validation failed");
        await context.record({
          suite, workload: "navigate-inspect-interact-extract", baseline: factory.id, iteration, warmup, startedAt,
          metrics: { durationMs: performance.now() - started, actions: 4, extractedChars: result.selected.length, articleCount: result.articleCount },
          details: { title: result.title, selected: result.selected },
        });
      } catch (error) {
        await context.record({ suite, workload: "navigate-inspect-interact-extract", baseline: factory.id, iteration, warmup, startedAt, error });
      } finally {
        await session?.close().catch(() => {});
        await runtime.close().catch(() => {});
      }
    }
  }
}
