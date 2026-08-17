import { resolve } from "node:path";
import { connectCdp, waitForJson } from "../common/cdp.mjs";
import {
  getFreePort,
  removeTemporaryDirectory,
  spawnCaptured,
  temporaryDirectory,
  terminateProcess,
} from "../common/process.mjs";
import { createRawCdpSession } from "./cdp-session.mjs";

export class KokoCdpAdapter {
  static id = "koko-cdp";
  static label = "Koko direct CDP";

  constructor(options) {
    this.options = options;
    this.id = KokoCdpAdapter.id;
    this.label = KokoCdpAdapter.label;
    this.process = null;
    this.profileDirectory = null;
    this.version = null;
    this.launchMetrics = null;
  }

  get pid() {
    return this.process?.pid;
  }

  async launch() {
    const started = performance.now();
    const port = await getFreePort();
    this.profileDirectory = await temporaryDirectory("koko-benchmark-");
    const binary = resolve(this.options.kokoBin);
    const { child, output } = spawnCaptured(binary, [
      "serve",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--cdp-max-connections", "64",
      "--user-data-dir", this.profileDirectory,
      "--http-cache-dir", `${this.profileDirectory}/cache`,
      "--log-level", "warn",
    ], { cwd: this.options.projectRoot });
    this.process = child;
    this.output = output;
    child.once("exit", (code, signal) => {
      this.exit = { code, signal };
    });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      this.version = await waitForJson(`${endpoint}/json/version`, this.options.timeoutMs);
    } catch (error) {
      throw new Error(`Koko did not become ready: ${error.message}\n${output.stderr}`);
    }
    this.endpoint = endpoint;
    this.webSocketDebuggerUrl = this.version.webSocketDebuggerUrl;
    this.launchMetrics = { processReadyMs: performance.now() - started };
    return this;
  }

  async newSession() {
    const connectedAt = performance.now();
    const client = await connectCdp(this.webSocketDebuggerUrl, this.options.timeoutMs);
    const connectedMs = performance.now() - connectedAt;
    try {
      const session = await createRawCdpSession(client, { ownerClient: true });
      session.timings.connectMs = connectedMs;
      session.timings.durationMs += connectedMs;
      return session;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async close() {
    await terminateProcess(this.process);
    await removeTemporaryDirectory(this.profileDirectory);
    this.process = null;
  }
}

