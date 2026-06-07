const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const port = await getFreePort();
  const velora = spawn('./zig-out/bin/velora', [
    'serve',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--log-level', 'info',
    '--log-format', 'pretty',
    '--http-timeout', '30000',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let veloraLog = '';
  velora.stdout.on('data', (chunk) => {
    veloraLog += chunk.toString();
    process.stdout.write(chunk);
  });
  velora.stderr.on('data', (chunk) => {
    veloraLog += chunk.toString();
    process.stderr.write(chunk);
  });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/json/version`, 10000);

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0] || await browser.newPage();

    const consoleLines = [];
    page.on('console', (msg) => {
      const text = `[console.${msg.type()}] ${msg.text()}`;
      consoleLines.push(text);
      console.log(text);
    });
    page.on('pageerror', (err) => {
      const text = `[pageerror] ${err.message}`;
      consoleLines.push(text);
      console.log(text);
    });

    const htmlPath = path.join(process.cwd(), 'code-check', 'tmp', 'offline-audio-repro.html');
    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForFunction(() => window.__audioDone === true, { timeout: 10000 });

    const pageResults = await page.evaluate(() => window.__audioResults || []);
    await browser.close();

    console.log('\n=== velora log captured ===');
    console.log(veloraLog);
    console.log('\n=== console lines captured ===');
    console.log(consoleLines.join('\n'));
    console.log('\n=== page results captured ===');
    console.log(pageResults.join('\n'));
  } finally {
    velora.kill('SIGTERM');
    await once(velora, 'exit').catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
