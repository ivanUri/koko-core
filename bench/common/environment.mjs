import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function collectEnvironment({ projectRoot, kokoBin, chromeBin, optimize, options }) {
  const binaryStat = existsSync(kokoBin) ? await stat(kokoBin) : null;
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    toolchain: {
      node: process.version,
      zig: command("zig", ["version"], projectRoot),
    },
    koko: {
      gitCommit: command("git", ["rev-parse", "HEAD"], projectRoot),
      gitDirty: Boolean(command("git", ["status", "--porcelain"], projectRoot)),
      optimize,
      binary: kokoBin,
      binarySizeBytes: binaryStat?.size ?? null,
      binaryModifiedAt: binaryStat?.mtime.toISOString() ?? null,
      binarySha256: binaryStat ? await sha256(kokoBin) : null,
    },
    chromium: {
      binary: chromeBin,
      version: chromeBin ? command(chromeBin, ["--version"], projectRoot) : null,
    },
    benchmarkOptions: options,
  };
}

