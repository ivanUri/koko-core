import { writeText } from "../lib/io.mjs";

export function renderMarkdown(report) {
  const lines = [
    "# Koko Web Platform Compatibility Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Reference: ${report.metadata?.expectedSource ?? "unknown"}`,
    `Actual inventory: ${report.metadata?.actualSource ?? "koko"}`,
    "",
    "## Metrics",
    "",
    "| Dimension | Count |",
    "| --- | ---: |",
    `| Expected API entries | ${report.metrics.api?.expected ?? 0} |`,
    `| Present entries | ${report.metrics.api?.presence ?? 0} |`,
    `| Verified behavior | ${report.metrics.api?.behaviorVerified ?? 0} |`,
    `| Tested entries | ${report.metrics.api?.coverageTested ?? 0} |`,
    `| Tests | ${report.metrics.tests?.total ?? 0} |`,
    "",
    "## API status",
    "",
    ...Object.entries(report.metrics.api?.byStatus ?? {}).sort().map(([status, count]) => `- ${status}: ${count}`),
    "",
    "## Category status",
    "",
    "| Category | Expected | Verified | Missing | Incorrect |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [category, metric] of Object.entries(report.metrics.categories ?? {}).sort()) lines.push(`| ${category} | ${metric.total} | ${metric.byStatus?.IMPLEMENTED_VERIFIED ?? 0} | ${metric.byStatus?.MISSING ?? 0} | ${metric.byStatus?.INCORRECT ?? 0} |`);
  lines.push("", "## Prioritized tasks", "", ...(report.tasks ?? []).map((task) => `- **${task.priority}** ${task.title} (${task.status}, ${task.apiIds.length} API entries)`));
  return `${lines.join("\n")}\n`;
}

export async function writeMarkdown(path, report) { await writeText(path, renderMarkdown(report)); }
