#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const url = process.argv[2] || "https://boko.vn//";
const koko = path.resolve(
  process.env.KOKO_BINARY || path.join(projectRoot, "zig-out/bin/koko"),
);

function artifactNameFor(input) {
  const parsed = new URL(input);
  return `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-z0-9.-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function restoreStaticSnapshotVisibility(html) {
  // Anti-flicker snippets intentionally hide the whole document until author
  // JavaScript removes their style element. A JS-stripped snapshot cannot run
  // that cleanup, so preserve the page rather than the transient hidden state.
  // Only act on inline CSS that targets html/body and explicitly conceals it.
  const hasFullPageConcealment = /<style\b[^>]*>[\s\S]*?(?:^|[},\s])(?:html|body)(?=[\s:{.#>\[])[\s\S]*?(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\b)[\s\S]*?<\/style\s*>/i.test(
    html,
  );
  if (!hasFullPageConcealment) return { html, restored: false };

  const recovery =
    '<style data-koko-static-visibility>html,body{display:revert!important;visibility:visible!important;opacity:1!important}</style>';
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd === -1) return { html: `${recovery}${html}`, restored: true };
  return {
    html: `${html.slice(0, headEnd)}${recovery}${html.slice(headEnd)}`,
    restored: true,
  };
}

function run(output, logPath) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const file = fs.openSync(output, "w");
    const logFile = fs.openSync(logPath, "w");
    const child = spawn(koko, [
      "fetch",
      "--log-level", "info",
      "--dump", "html",
      "--with-base",
      "--strip-mode", "js",
      "--wait-until", "domstable",
      "--wait-ms", "20000",
      url,
    ], {
      cwd: projectRoot,
      stdio: ["ignore", file, "pipe"],
    });

    let stderr = "";
    let settled = false;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      fs.writeSync(logFile, chunk);
      process.stderr.write(chunk);
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fs.closeSync(file);
      fs.closeSync(logFile);
      if (error) reject(error);
      else resolve(result);
    };

    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(null, {
      code,
      signal,
      stderr,
      elapsedMs: Date.now() - started,
    }));
  });
}

async function main() {
  const artifactName = artifactNameFor(url);
  const output = path.join(projectRoot, "exports", "domstable", `${artifactName}.html`);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(projectRoot, "export-logs", "domstable", `${artifactName}-${runId}.log`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  console.log(`URL: ${url}`);
  console.log("waitUntil: domstable");
  console.log(`Output: ${output}`);
  console.log(`Log: ${logPath}`);

  const result = await run(output, logPath);
  if (result.code !== 0) {
    throw new Error(
      `Koko exited with code ${result.code ?? "null"} signal ${result.signal ?? "none"}\n${result.stderr}`,
    );
  }

  let html = fs.readFileSync(output, "utf8");
  const visibility = restoreStaticSnapshotVisibility(html);
  html = visibility.html;
  if (visibility.restored) {
    fs.writeFileSync(output, html, "utf8");
    console.log("Restored static visibility after stripping author JavaScript.");
  }
  const text = visibleText(html);
  if (!/^\s*(?:<!doctype\s+html[^>]*>)?[\s\S]*<html[\s>]/i.test(html)) {
    throw new Error("Snapshot does not contain an HTML document");
  }
  if (!/<\/html>\s*$/i.test(html)) {
    throw new Error("Snapshot is truncated: missing closing </html>");
  }
  // A valid SPA shell can be intentionally sparse (login/interstitial pages).
  // Reject empty/error artifacts without imposing site-specific content size.
  if (text.length < 20) {
    throw new Error(`Rendered visible content is too short (${text.length} characters)`);
  }

  console.log(`PASS: exit code 0 after ${(result.elapsedMs / 1000).toFixed(2)}s`);
  console.log(`PASS: ${Buffer.byteLength(html)} bytes, ${text.length} visible characters`);
  console.log(`Snapshot: ${output}`);
  console.log(`Log: ${logPath}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
