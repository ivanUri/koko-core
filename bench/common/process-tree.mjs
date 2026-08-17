import { spawnSync } from "node:child_process";

function readProcessTable() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,comm="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`ps failed: ${result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      cpuPercent: Number(match[4]),
      command: match[5],
    }];
  });
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
    rssBytes: processes.reduce((sum, row) => sum + row.rssKiB * 1024, 0),
    cpuPercent: processes.reduce((sum, row) => sum + row.cpuPercent, 0),
    processes,
  };
}

export async function sampleProcessTree(rootPid, { samples = 5, intervalMs = 100 } = {}) {
  const snapshots = [];
  for (let index = 0; index < samples; index += 1) {
    snapshots.push(processTreeSnapshot(rootPid));
    if (index + 1 < samples) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return {
    rssBytes: snapshots.at(-1).rssBytes,
    peakRssBytes: Math.max(...snapshots.map((sample) => sample.rssBytes)),
    averageRssBytes: snapshots.reduce((sum, sample) => sum + sample.rssBytes, 0) / snapshots.length,
    processCount: Math.max(...snapshots.map((sample) => sample.processCount)),
    averageCpuPercent: snapshots.reduce((sum, sample) => sum + sample.cpuPercent, 0) / snapshots.length,
  };
}

