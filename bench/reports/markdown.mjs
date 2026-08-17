function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function metric(group, name, statistic = "median") {
  return group?.metrics?.[name]?.[statistic] ?? null;
}

function mib(bytes) {
  return Number.isFinite(bytes) ? bytes / (1024 * 1024) : null;
}

export function renderMarkdownReport({ runId, environment, summary }) {
  const includesRealSites = environment.benchmarkOptions?.suites?.includes("real-sites") ?? false;
  const reference = new Map(
    summary.groups
      .filter((group) => group.baseline === "chromium-cdp")
      .map((group) => [`${group.suite}\u0000${group.workload}`, group]),
  );
  const rows = summary.groups.map((group) => {
    const duration = metric(group, "durationMs");
    const baselineDuration = metric(reference.get(`${group.suite}\u0000${group.workload}`) ?? {}, "durationMs");
    const ratio = Number.isFinite(duration) && Number.isFinite(baselineDuration) && baselineDuration !== 0
      ? duration / baselineDuration
      : null;
    return `| ${group.suite} | ${group.workload} | ${group.baseline} | ${group.successes}/${group.attempts} | ${formatNumber(duration)} | ${formatNumber(metric(group, "durationMs", "p95"))} | ${formatNumber(mib(metric(group, "rssBytes")))} | ${formatNumber(mib(metric(group, "rssPerSessionBytes")))} | ${formatNumber(ratio)} |`;
  });
  const realSiteRows = includesRealSites
    ? summary.groups.filter((group) => group.suite === "real-sites").map((group) => (
        `| ${group.workload} | ${group.baseline} | ${formatNumber(metric(group, "durationMs"))} | ${formatNumber(metric(group, "navigationAckMs"))} | ${formatNumber(metric(group, "postAckToDomContentLoadedMs"))} | ${formatNumber(metric(group, "httpStatus"), 0)} | ${formatNumber(metric(group, "htmlChars"), 0)} | ${formatNumber(metric(group, "textChars"), 0)} | ${formatNumber(metric(group, "elementCount"), 0)} | ${formatNumber(metric(group, "responseCount"), 0)} |`
      ))
    : [];
  const realSiteSection = realSiteRows.length === 0 ? "" : `
## Live-site content signals

| Site | Baseline | DCL ms | Ack ms | Ack → DCL ms | HTTP | HTML chars | Text chars | Elements | Responses at ready |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${realSiteRows.join("\n")}
`;

  return `# Koko Browser Runtime Benchmark

Run: \`${runId}\`  
Captured: ${environment.capturedAt}  
Koko commit: \`${environment.koko.gitCommit ?? "unknown"}\`${environment.koko.gitDirty ? " (dirty worktree)" : ""}  
Optimize mode: \`${environment.koko.optimize}\`  
Chromium: ${environment.chromium.version ?? "not selected"}

## Results

| Suite | Workload | Baseline | Success | p50 ms | p95 ms | RSS MiB | incremental MiB/session | vs Chromium duration |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}
${realSiteSection}

## Measurement contract

- ${includesRealSites ? "The real-sites lane uses live external pages and is non-deterministic; compare content metrics and success rates alongside latency." : "Inputs are deterministic loopback-only HTML fixtures."} Cache is disabled for measured sessions.
- Navigation ends at \`DOMContentLoaded\` and validates document state after timing.
- Startup measures process launch through the first validated document.
- Koko session lifecycle includes opening one CDP connection because one Koko connection owns one browser context. Chromium direct CDP creates an isolated browser context on one browser process.
- Chromium memory is the RSS sum of its full descendant process tree. Koko is measured with the same process-tree algorithm.
- Warmups remain in raw JSONL but are excluded from summaries. Failures and timeouts remain in the success rate.
- The comparison covers runtime/API workloads, not pixel rendering parity, extension support, GPU composition, or full web-platform compatibility.
${includesRealSites ? "- Live-site results are integration evidence, not a reproducible microbenchmark. CDN routing, consent pages, bot defenses, and page deployments can change results.\n" : ""}

Raw observations and the captured environment are stored beside this report. Do not compare reports from different machines as if they were controlled A/B samples.
`;
}
