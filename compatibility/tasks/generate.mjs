import { readJson, writeJson } from "../lib/io.mjs";

const priorityFor = (status) => ({ INCORRECT: "P0", MISSING: "P1", PARTIAL: "P1", STUB: "P1", IMPLEMENTED_UNVERIFIED: "P2", UNKNOWN: "P3" }[status] ?? "P3");

export function generateTasks(report) {
  const groups = new Map();
  for (const api of report.apis ?? []) {
    if (!["MISSING", "PARTIAL", "STUB", "INCORRECT", "IMPLEMENTED_UNVERIFIED", "UNKNOWN"].includes(api.status)) continue;
    const key = `${api.category ?? "OTHER"}/${api.interface ?? api.name.split(".")[0]}`;
    const task = groups.get(key) ?? { key, category: api.category ?? "OTHER", interface: api.interface ?? api.name.split(".")[0], apiIds: [], statuses: new Set(), sources: [], priority: "P3" };
    task.apiIds.push(api.id); task.statuses.add(api.status); if (api.source) task.sources.push(api.source);
    if (["P0", "P1", "P2", "P3"].indexOf(priorityFor(api.status)) < ["P0", "P1", "P2", "P3"].indexOf(task.priority)) task.priority = priorityFor(api.status);
    groups.set(key, task);
  }
  return [...groups.values()].sort((a, b) => a.priority.localeCompare(b.priority) || a.key.localeCompare(b.key)).map((task, index) => ({
    id: `compat-${String(index + 1).padStart(4, "0")}`,
    title: `Improve ${task.interface} compatibility`,
    priority: task.priority,
    status: [...task.statuses].sort().join(","),
    category: task.category,
    interface: task.interface,
    apiIds: task.apiIds.sort(),
    dependencies: [],
    acceptanceCriteria: ["Run the relevant WebIDL and deterministic behavior tests", "Preserve the WebIDL exception and receiver semantics", "Add a regression fixture without third-party network"],
    sources: task.sources,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await readJson(process.argv[2]);
  report.tasks = generateTasks(report);
  await writeJson(process.argv[3], report.tasks);
}
