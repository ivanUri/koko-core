import { connectCdp, waitForJson } from "../common/cdp.mjs";
import {
  getFreePort,
  removeTemporaryDirectory,
  spawnCaptured,
  temporaryDirectory,
  terminateProcess,
} from "../common/process.mjs";
import { createRawCdpSession } from "./cdp-session.mjs";

export class ChromiumCdpAdapter {
  static id = "chromium-cdp";
  static label = "Chromium direct CDP";

  constructor(options) {
    this.options = options;
    this.id = ChromiumCdpAdapter.id;
    this.label = ChromiumCdpAdapter.label;
    this.process = null;
    this.profileDirectory = null;
    this.client = null;
    this.version = null;
    this.launchMetrics = null;
  }

  get pid() {
    return this.process?.pid;
  }

  async launch() {
    const started = performance.now();
    const port = await getFreePort();
    this.profileDirectory = await temporaryDirectory("chromium-benchmark-");
    const { child, output } = spawnCaptured(this.options.chromeBin, [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--disable-features=Translate",
      "--hide-scrollbars",
      "about:blank",
    ], { cwd: this.options.projectRoot });
    this.process = child;
    this.output = output;
    child.once("exit", (code, signal) => {
      this.exit = { code, signal };
    });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      this.version = await waitForJson(`${endpoint}/json/version`, this.options.timeoutMs);
      this.client = await connectCdp(this.version.webSocketDebuggerUrl, this.options.timeoutMs);
      this.browserVersion = await this.client.send("Browser.getVersion");
    } catch (error) {
      throw new Error(`Chromium did not become ready: ${error.message}\n${output.stderr}`);
    }
    this.endpoint = endpoint;
    this.launchMetrics = { processReadyMs: performance.now() - started };
    return this;
  }

  async newSession() {
    return createRawCdpSession(this.client);
  }

  async close() {
    await this.client?.close();
    await terminateProcess(this.process);
    await removeTemporaryDirectory(this.profileDirectory);
    this.client = null;
    this.process = null;
  }
}

