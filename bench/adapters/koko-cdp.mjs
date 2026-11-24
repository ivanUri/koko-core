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
    const args = [
      "serve",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--cdp-max-connections", String(this.options.cdpMaxConnections ?? 64),
      "--cdp-max-pending-connections", String(this.options.cdpMaxPendingConnections ?? 128),
      "--cdp-thread-stack-mb", String(this.options.cdpThreadStackMb ?? 4),
      "--user-data-dir", this.profileDirectory,
      "--http-cache-dir", `${this.profileDirectory}/cache`,
      "--log-level", "warn",
    ];
    if (this.options.workerMaxPages != null) {
      args.push("--worker-max-pages", String(this.options.workerMaxPages));
    }
    if (this.options.workerMaxRss != null) {
      args.push("--worker-max-rss", String(this.options.workerMaxRss));
    }
    if (this.options.httpMaxConcurrent != null) args.push("--http-max-concurrent", String(this.options.httpMaxConcurrent));
    if (this.options.httpMaxHostOpen != null) args.push("--http-max-host-open", String(this.options.httpMaxHostOpen));
    if (this.options.resourcePolicy && this.options.resourcePolicy !== "full") {
      args.push("--resource-policy", this.options.resourcePolicy);
    }
    const { child, output } = spawnCaptured(binary, args, { cwd: this.options.projectRoot });
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
    const startup = this.version.kokoStartup ?? {};
    this.launchMetrics = {
      processReadyMs: performance.now() - started,
      appStartupMs: Number.isFinite(Number(startup.totalUs)) ? Number(startup.totalUs) / 1_000 : null,
      appPlatformMs: Number.isFinite(Number(startup.platformUs)) ? Number(startup.platformUs) / 1_000 : null,
      appSnapshotMs: Number.isFinite(Number(startup.snapshotUs)) ? Number(startup.snapshotUs) / 1_000 : null,
      appStorageMs: Number.isFinite(Number(startup.storageUs)) ? Number(startup.storageUs) / 1_000 : null,
      appNetworkMs: Number.isFinite(Number(startup.networkUs)) ? Number(startup.networkUs) / 1_000 : null,
      appDirMs: Number.isFinite(Number(startup.appDirUs)) ? Number(startup.appDirUs) / 1_000 : null,
      appTelemetryMs: Number.isFinite(Number(startup.telemetryUs)) ? Number(startup.telemetryUs) / 1_000 : null,
      appArenaPoolMs: Number.isFinite(Number(startup.arenaPoolUs)) ? Number(startup.arenaPoolUs) / 1_000 : null,
    };
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
