import {
  getFreePort,
  removeTemporaryDirectory,
  spawnCaptured,
  temporaryDirectory,
  terminateProcess,
} from "../common/process.mjs";
import { connectCdp, waitForJson } from "../common/cdp.mjs";
import { createRawCdpSession } from "./cdp-session.mjs";

// Lightpanda does not expose a dedicated "disable images" serve switch, but
// its URL blocker is applied before a transfer is admitted. Keep this list
// intentionally conservative: it blocks common image payloads without
// accidentally blocking the HTML document or scripts with query-only URLs.
const IMAGE_URL_PATTERNS = [
  "*://*/*.avif*",
  "*://*/*.bmp*",
  "*://*/*.gif*",
  "*://*/*.ico*",
  "*://*/*.jpg*",
  "*://*/*.jpeg*",
  "*://*/*.png*",
  "*://*/*.svg*",
  "*://*/*.tif*",
  "*://*/*.tiff*",
  "*://*/*.webp*",
];

/** Optional protocol-matched Lightpanda baseline for deterministic fixtures. */
export class LightpandaCdpAdapter {
  static id = "lightpanda-cdp";
  static label = "Lightpanda direct CDP";

  constructor(options) {
    this.options = options;
    this.id = LightpandaCdpAdapter.id;
    this.label = LightpandaCdpAdapter.label;
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
    this.profileDirectory = await temporaryDirectory("lightpanda-benchmark-");
    const args = [
      "serve", "--host", "127.0.0.1", "--port", String(port),
      "--cdp-max-connections", String(this.options.cdpMaxConnections ?? 64),
      "--log-level", "error",
    ];
    if (this.options.lightpandaHttpMaxConcurrent != null) {
      args.push("--http-max-concurrent", String(this.options.lightpandaHttpMaxConcurrent));
    }
    if (this.options.lightpandaHttpMaxHostOpen != null) {
      args.push("--http-max-host-open", String(this.options.lightpandaHttpMaxHostOpen));
    }
    const policy = this.options.resourcePolicy ?? "full";
    if (this.options.lightpandaEnableExternalStylesheets && policy !== "no-css" && policy !== "text-only") {
      args.push("--enable-external-stylesheets");
    }
    if (policy === "no-images" || policy === "text-only") {
      args.push("--block-urls", IMAGE_URL_PATTERNS.join(","));
    }
    const { child, output } = spawnCaptured(this.options.lightpandaBin, args, {
      cwd: this.options.projectRoot,
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    });
    this.process = child;
    this.output = output;
    child.once("exit", (code, signal) => { this.exit = { code, signal }; });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      this.version = await waitForJson(`${endpoint}/json/version`, this.options.timeoutMs);
    } catch (error) {
      throw new Error(`Lightpanda did not become ready: ${error.message}\n${output.stderr}`);
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
