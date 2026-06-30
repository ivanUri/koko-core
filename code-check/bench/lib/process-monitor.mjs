import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Poll process tree RSS/CPU for scalability comparison.
 * GPU: headless crawls rarely use GPU; we detect a GPU helper process if present.
 */

function parsePsTable(output) {
    const rows = [];
    for (const line of output.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
        if (!m) continue;
        rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            rssKiB: Number(m[3]),
            vszKiB: Number(m[4]),
            cpuPct: Number(m[5]),
            comm: m[6].trim(),
        });
    }
    return rows;
}

function listProcesses() {
    const os = platform();
    try {
        if (os === "darwin") {
            const out = execSync("ps -ax -o pid=,ppid=,rss=,vsz=,pcpu=,comm=", {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            return parsePsTable(out);
        }
        if (os === "linux") {
            const out = execSync("ps -ax -o pid=,ppid=,rss=,vsz=,pcpu=,comm=", {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            return parsePsTable(out);
        }
    } catch (_) {}
    return [];
}

function collectDescendants(all, rootPid) {
    const byParent = new Map();
    for (const p of all) {
        let kids = byParent.get(p.ppid);
        if (!kids) {
            kids = [];
            byParent.set(p.ppid, kids);
        }
        kids.push(p.pid);
    }
    const out = new Set();
    const stack = [rootPid];
    while (stack.length) {
        const pid = stack.pop();
        if (out.has(pid)) continue;
        out.add(pid);
        for (const child of byParent.get(pid) || []) stack.push(child);
    }
    return out;
}

function isGpuHelper(comm) {
    return /gpu|GPU/i.test(comm);
}

function sampleTree(rootPids, nameHint) {
    const all = listProcesses();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const included = new Set();

    for (const root of rootPids) {
        for (const pid of collectDescendants(all, root)) included.add(pid);
    }

    if (nameHint) {
        const hint = nameHint.toLowerCase();
        for (const p of all) {
            if (p.comm.toLowerCase().includes(hint)) included.add(p.pid);
        }
    }

    let rssKiB = 0;
    let vszKiB = 0;
    let cpuPct = 0;
    let processCount = 0;
    let gpuProcessCount = 0;
    let gpuRssKiB = 0;
    const pids = [];

    for (const pid of included) {
        const p = byPid.get(pid);
        if (!p) continue;
        processCount += 1;
        rssKiB += p.rssKiB;
        vszKiB += p.vszKiB;
        cpuPct += p.cpuPct;
        pids.push(pid);
        if (isGpuHelper(p.comm)) {
            gpuProcessCount += 1;
            gpuRssKiB += p.rssKiB;
        }
    }

    return {
        atMs: Date.now(),
        rssBytes: rssKiB * 1024,
        vszBytes: vszKiB * 1024,
        cpuPercent: cpuPct,
        processCount,
        gpuProcessCount,
        gpuRssBytes: gpuRssKiB * 1024,
        pids,
    };
}

function integratedCpuSeconds(samples) {
    if (samples.length === 0) return 0;
    if (samples.length === 1) {
        const intervalMs = 100;
        return (samples[0].cpuPercent / 100) * (intervalMs / 1000);
    }
    let total = 0;
    for (let i = 1; i < samples.length; i += 1) {
        const dt = (samples[i].atMs - samples[i - 1].atMs) / 1000;
        const avgCpu = (samples[i].cpuPercent + samples[i - 1].cpuPercent) / 2;
        total += (avgCpu / 100) * dt;
    }
    return total;
}

export function computeSessionsPerGb(peakRssBytes, parallelism) {
    if (!peakRssBytes || !parallelism) return null;
    const perSession = peakRssBytes / parallelism;
    if (perSession <= 0) return null;
    return Math.floor((1024 ** 3) / perSession);
}

function summarizeSamples(samples) {
    if (samples.length === 0) {
        return {
            sampleCount: 0,
            intervalMs: null,
            peakRssBytes: null,
            avgRssBytes: null,
            endRssBytes: null,
            peakVszBytes: null,
            peakCpuPercent: null,
            avgCpuPercent: null,
            peakProcessCount: null,
            peakGpuProcessCount: null,
            peakGpuRssBytes: null,
            rssPerPage: null,
            cpuCoreEquivalents: null,
        };
    }

    const peakRss = Math.max(...samples.map((s) => s.rssBytes));
    const avgRss = samples.reduce((a, s) => a + s.rssBytes, 0) / samples.length;
    const peakVsz = Math.max(...samples.map((s) => s.vszBytes));
    const peakCpu = Math.max(...samples.map((s) => s.cpuPercent));
    const avgCpu = samples.reduce((a, s) => a + s.cpuPercent, 0) / samples.length;
    const peakProc = Math.max(...samples.map((s) => s.processCount));
    const peakGpuProc = Math.max(...samples.map((s) => s.gpuProcessCount));
    const peakGpuRss = Math.max(...samples.map((s) => s.gpuRssBytes));

    return {
        sampleCount: samples.length,
        peakRssBytes: peakRss,
        avgRssBytes: Math.round(avgRss),
        endRssBytes: samples.at(-1).rssBytes,
        peakVszBytes: peakVsz,
        peakCpuPercent: peakCpu,
        avgCpuPercent: avgCpu,
        peakProcessCount: peakProc,
        peakGpuProcessCount: peakGpuProc,
        peakGpuRssBytes: peakGpuRss,
        cpuCoreEquivalents: avgCpu / 100,
    };
}

export class ProcessMonitor {
    constructor({ label, rootPids = [], nameHint = null, intervalMs = 100 } = {}) {
        this.label = label;
        this.rootPids = new Set(rootPids.filter(Boolean));
        this.nameHint = nameHint;
        this.intervalMs = intervalMs;
        this.samples = [];
        this.timer = null;
        this.startedAt = null;
    }

    addRootPid(pid) {
        if (pid) this.rootPids.add(pid);
    }

    start() {
        if (this.timer) return;
        this.startedAt = Date.now();
        const tick = () => {
            const sample = sampleTree([...this.rootPids], this.nameHint);
            sample.elapsedMs = this.startedAt ? sample.atMs - this.startedAt : 0;
            this.samples.push(sample);
        };
        tick();
        this.timer = setInterval(tick, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop(pages = null, parallelism = null) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.samples.length === 0 && this.rootPids.size > 0) {
            const sample = sampleTree([...this.rootPids], this.nameHint);
            sample.elapsedMs = 0;
            this.samples.push(sample);
        }

        const summary = summarizeSamples(this.samples);
        summary.intervalMs = this.intervalMs;
        summary.label = this.label;
        summary.platform = platform();
        summary.gpuUtilizationPercent = null;
        summary.gpuNote = "Headless crawl: GPU compute utilization is typically ~0; we report GPU helper process RSS if spawned.";
        const cpuSeconds = integratedCpuSeconds(this.samples);
        summary.integratedCpuSeconds = +cpuSeconds.toFixed(3);
        if (pages && pages > 0) {
            summary.cpuSecondsPerPage = +(cpuSeconds / pages).toFixed(4);
        }
        if (pages && summary.peakRssBytes) {
            summary.rssPerPageBytes = Math.round(summary.peakRssBytes / pages);
        }
        if (parallelism && summary.peakRssBytes) {
            summary.memoryPerSessionBytes = Math.round(summary.peakRssBytes / parallelism);
            summary.sessionsPerGb = computeSessionsPerGb(summary.peakRssBytes, parallelism);
        }

        const downsampled = [];
        const step = Math.max(1, Math.floor(this.samples.length / 120));
        for (let i = 0; i < this.samples.length; i += step) {
            const s = this.samples[i];
            downsampled.push({
                tMs: s.elapsedMs,
                rssMiB: +(s.rssBytes / 1024 / 1024).toFixed(2),
                cpuPct: +s.cpuPercent.toFixed(1),
                procs: s.processCount,
            });
        }

        return { summary, series: downsampled };
    }
}

export function miB(bytes) {
    if (bytes == null) return "n/a";
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function fmtCpu(pct) {
    if (pct == null) return "n/a";
    return `${pct.toFixed(1)}%`;
}