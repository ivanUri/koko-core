import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function binaryIdentity(binary) {
  const target = resolve(binary);
  try {
    const metadata = await stat(target);
    const hash = createHash("sha256");
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(target);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolvePromise);
    });
    return { path: target, sizeBytes: metadata.size, sha256: hash.digest("hex") };
  } catch {
    return { path: target, sizeBytes: null, sha256: null };
  }
}

export async function createProbeReport({ probe, binary, options, startedAt, durationMs, ...measurements }) {
  return {
    schemaVersion: 1,
    probe,
    capturedAt: new Date().toISOString(),
    startedAt,
    durationMs,
    binary: await binaryIdentity(binary),
    options,
    ...measurements,
  };
}

export async function writeProbeReport(output, report) {
  if (!output) return;
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
}
