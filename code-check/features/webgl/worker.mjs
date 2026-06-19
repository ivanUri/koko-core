#!/usr/bin/env node
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const { resolve } = require('node:path');

const repoRoot = resolve(__dirname, '../..');
const veloraBin = resolve(repoRoot, 'zig-out/bin/velora');

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}
function startServer(port) {
  const html = `<!doctype html><meta charset="utf-8"><title>worker webgl</title><script>
    window.workerResultPromise = new Promise((resolve) => {
      const workerSource = ` + JSON.stringify(`
        self.onmessage = () => {
          try {
            const canvas = new OffscreenCanvas(16, 16);
            const gl = canvas.getContext('webgl');
            const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
            self.postMessage({
              ok: !!gl,
              contextCtor: gl ? gl.constructor.name : null,
              globalCtor: typeof WebGLRenderingContext,
              instanceofWebGL: typeof WebGLRenderingContext === 'function' && gl instanceof WebGLRenderingContext,
              vendor: gl ? gl.getParameter(gl.VENDOR) : null,
              renderer: gl ? gl.getParameter(gl.RENDERER) : null,
              unmaskedVendor: gl && ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
              unmaskedRenderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
            });
          } catch (err) {
            self.postMessage({ ok: false, error: String(err && err.stack || err) });
          }
        };
      `) + `;
      const blob = new Blob([workerSource], { type: 'text/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => resolve({ ok: false, error: event.message });
      worker.postMessage(null);
    });
  </script>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolveServer) => server.listen(port, '127.0.0.1', () => resolveServer(server)));
}

async function waitFor(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch (_) {}
    await delay(50);
  }
  throw new Error(`timed out waiting for ${url}`);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject, timer, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result || {});
    });
  }
  send(method, params = {}, timeoutMs = 15000, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

(async () => {
  const httpPort = await freePort();
  const cdpPort = await freePort();
  const server = await startServer(httpPort);
  const velora = spawn(veloraBin, ['serve', '--host', '127.0.0.1', '--port', String(cdpPort), '--log-level', 'info'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  velora.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, 10000);
    const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', rejectOpen, { once: true });
      setTimeout(() => rejectOpen(new Error('ws open timed out')), 10000);
    });
    const cdp = new CdpClient(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, 15000, sessionId);
    await cdp.send('Runtime.enable', {}, 15000, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` }, 15000, sessionId);
    await delay(1000);
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'window.workerResultPromise',
      awaitPromise: true,
      returnByValue: true,
      timeout: 10000,
    }, 12000, sessionId);
    console.log(JSON.stringify(result.result && result.result.value, null, 2));
    ws.close();
    const value = result.result && result.result.value;
    if (!value || !value.ok || value.globalCtor !== 'function' || !value.instanceofWebGL) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.stack || err.message);
    console.error(stderr);
    process.exitCode = 1;
  } finally {
    velora.kill();
    server.close();
  }
})();
