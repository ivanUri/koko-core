import { spawnSync } from "node:child_process";

function readProcessTable() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,cputime=,comm="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`ps failed: ${result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!match) return [];
    const cpuTimeSeconds = parseCpuTime(match[5]);
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      cpuPercent: Number(match[4]),
      cpuTimeSeconds,
      command: match[6],
    }];
  });
}

// `ps cputime` is either MM:SS.xx or HH:MM:SS.xx, depending on how long the
// process has been alive. Keep this parser local so the sampler remains
// portable across macOS and Linux without adding a native dependency.
function parseCpuTime(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function readThreadCount(pid) {
  const args = process.platform === "darwin"
    ? ["-M", "-p", String(pid)]
    : ["-o", "nlwp=", "-p", String(pid)];
  const result = spawnSync("ps", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  if (process.platform === "darwin") {
    return result.stdout.split("\n").filter((line) => line.trim().length > 0 && !line.startsWith("USER")).length;
  }
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

export function processTreeSnapshot(rootPid) {
  const table = readProcessTable();
  const byParent = new Map();
  for (const row of table) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const root = table.find((row) => row.pid === rootPid);
  if (!root) throw new Error(`Process ${rootPid} no longer exists`);
  const processes = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    processes.push(current);
    queue.push(...(byParent.get(current.pid) ?? []));
  }
  return {
    rootPid,
    processCount: processes.length,
    threadCount: readThreadCount(rootPid),
    rssBytes: processes.reduce((sum, row) => sum + row.rssKiB * 1024, 0),
    cpuPercent: processes.reduce((sum, row) => sum + row.cpuPercent, 0),
    cpuTimeSeconds: processes.every((row) => row.cpuTimeSeconds != null)
      ? processes.reduce((sum, row) => sum + row.cpuTimeSeconds, 0)
      : null,
    processes,
  };
}

export async function sampleProcessTree(rootPid, { samples = 5, intervalMs = 100 } = {}) {
  const snapshots = [];
  const startedAt = performance.now();
  let previous = processTreeSnapshot(rootPid);
  const firstCpuTimeSeconds = previous.cpuTimeSeconds;
  snapshots.push(previous);
  for (let index = 1; index < samples; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = processTreeSnapshot(rootPid);
    snapshots.push(current);
    previous = current;
  }
  const legacyCpuPercent = snapshots.reduce((sum, sample) => sum + sample.cpuPercent, 0) / snapshots.length;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const totalCpuTimeSeconds = firstCpuTimeSeconds != null && previous.cpuTimeSeconds != null
    ? Math.max(0, previous.cpuTimeSeconds - firstCpuTimeSeconds)
    : null;
  // macOS `ps` reports cputime with centisecond precision. For a low-CPU
  // process a short window may legitimately round to zero; in that case use
  // ps's current `%cpu` as a fallback instead of reporting a false zero.
  const hasMeasuredCpuTime = totalCpuTimeSeconds != null && totalCpuTimeSeconds > 0;
  const intervalCpuPercent = hasMeasuredCpuTime && elapsedSeconds > 0
    ? (totalCpuTimeSeconds / elapsedSeconds) * 100
    : null;
  return {
    rssBytes: snapshots.at(-1).rssBytes,
    peakRssBytes: Math.max(...snapshots.map((sample) => sample.rssBytes)),
    averageRssBytes: snapshots.reduce((sum, sample) => sum + sample.rssBytes, 0) / snapshots.length,
    processCount: Math.max(...snapshots.map((sample) => sample.processCount)),
    threadCount: Math.max(...snapshots.map((sample) => sample.threadCount ?? 0)) || null,
    // Prefer interval CPU. `pcpu` is retained as a fallback for platforms
    // whose ps implementation does not expose cumulative cputime.
    averageCpuPercent: intervalCpuPercent ?? legacyCpuPercent,
    legacyAverageCpuPercent: legacyCpuPercent,
    cpuMeasurement: intervalCpuPercent != null ? "interval-cputime" : "process-pcpu",
    cpuTimeSeconds: totalCpuTimeSeconds,
  };
}
