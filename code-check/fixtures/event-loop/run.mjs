#!/usr/bin/env node
/**
 * Offline EventLoop fixtures (architecture Phase 1).
 *   node code-check/fixtures/event-loop/run.mjs
 * Exit 0 only if all fixtures pass.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "../../..");
const BIN = join(REPO, "zig-out/bin/velora");
const FIXTURE_DIR = __dirname;

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.startsWith("el-") && f.endsWith(".html"))
  .sort();

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

async function serveAndRun() {
  const port = await freePort();
  const server = createServer((req, res) => {
    const name = (req.url || "/").replace(/^\//, "").split("?")[0] || "index.html";
    const path = join(FIXTURE_DIR, name);
    try {
      const body = readFileSync(path);
      const ct = name.endsWith(".html")
        ? "text/html; charset=utf-8"
        : name.endsWith(".txt")
          ? "text/plain; charset=utf-8"
          : "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("missing");
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  const results = [];
  for (const file of fixtures) {
    const url = `http://127.0.0.1:${port}/${file}`;
    const r = await runFixture(url, file);
    results.push(r);
    console.log(r.ok ? "PASS" : "FAIL", file, r.title || r.err || "");
  }
  server.close();
  const failed = results.filter((x) => !x.ok);
  process.exit(failed.length ? 1 : 0);
}

function runFixture(url, file) {
  return new Promise((resolve) => {
    const args = [
      "fetch",
      "--wait_ms",
      "5000",
      "--wait_script",
      "window.__elDone===true",
      // `done` keeps pumping host tasks (MessageChannel/timers); `load` can
      // resolve wait_script ticks too early when is_done flips mid-loop.
      "--wait_until",
      "done",
      "--dump",
      "html",
      url,
    ];
    const proc = spawn(BIN, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve({ file, ok: false, err: "timeout" });
    }, 15000);
    proc.on("close", () => {
      clearTimeout(t);
      const m = stdout.match(/<title>([^<]*)<\/title>/);
      let title = m ? m[1] : "";
      // HTML dump may escape quotes
      title = title.replace(/&quot;/g, '"');
      try {
        const j = JSON.parse(title);
        resolve({ file, ok: !!j.ok, title: j });
      } catch {
        resolve({ file, ok: false, err: "bad title: " + title.slice(0, 120), stderr: stderr.slice(-500) });
      }
    });
  });
}

serveAndRun().catch((e) => {
  console.error(e);
  process.exit(1);
});
