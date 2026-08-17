import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTemporaryDirectory(path) {
  if (!path || !path.startsWith(tmpdir())) return;
  await rm(path, { recursive: true, force: true });
}

export function spawnCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const output = { stdout: "", stderr: "" };
  const retain = (key, chunk) => {
    output[key] = `${output[key]}${chunk}`.slice(-16_384);
  };
  child.stdout.on("data", (chunk) => retain("stdout", chunk));
  child.stderr.on("data", (chunk) => retain("stderr", chunk));
  return { child, output };
}

export async function terminateProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

