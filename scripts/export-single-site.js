#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const url = "https://www.tiktok.com/@team_hanoi";
// Chỉ cần sửa cấu hình trong khối này.
const CONFIG = {
  url,
  output: `exports/single/${new URL(url).hostname}.html`,
  log: `export-logs/${new URL(url).hostname}.log`,

  // Keep single-page exports isolated from profiles created by other runners.
  // Point these two values at another profile explicitly when persistence is
  // required; the exporter itself does not select an identity for a site.
  userDataDir: path.join(os.homedir(), "Library", "Application Support", "velora"),
  profile: "huynew",
  keepScripts: false,
  includeFrames: true,
  waitUntil: "done",
  waitMs: 40_000,
  terminateMs: 40_000,
  // Wait for finite presentation animations to settle before serializing.
  // Infinite decorative animations are intentionally ignored.
  waitScript: null,
};

const projectRoot = path.resolve(__dirname, "..");
const velora = path.join(projectRoot, "zig-out", "bin", "velora");
const output = path.resolve(projectRoot, CONFIG.output);
const temporary = `${output}.partial-${process.pid}`;
const logPath = path.resolve(projectRoot, CONFIG.log);

function isCompleteHtml(html) {
  return (
    /^\s*(?:<!doctype\s+html[^>]*>)?(?:\s|<!--[\s\S]*?-->)*<html[\s>]/i.test(
      html,
    ) && /<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(html)
  );
}

function stripScriptElements(html) {
  let removed = 0;
  const result = html.replace(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    () => {
      removed += 1;
      return "";
    },
  );
  return { html: result, removed };
}

function normalizeTransientAnimationStyles(html) {
  // React animation libraries often serialize an initial hidden state when
  // the DOM is captured immediately after load. Remove only that transient
  // pair; preserve intentional display/visibility rules and all other CSS.
  return html.replace(
    /style="([^"]*?)opacity:\s*0(?:;)?\s*transform:\s*none;?([^"]*?)"/gi,
    'style="$1$2"',
  );
}

function classifyExportState(html) {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  // These are generic browser-visible verification states. They mean the
  // document is valid, but the site has not reached an authenticated/pass
  // state yet; do not report the artifact as a successful page export.
  const pendingMarkers = [
    "performing security verification",
    "checking your browser",
    "verify you are human",
    "security verification",
  ];
  return pendingMarkers.some((marker) => text.includes(marker))
    ? "pending"
    : "ready";
}

function validateConfig() {
  const url = new URL(CONFIG.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CONFIG.url must use http:// or https://");
  }
  if (!fs.existsSync(velora)) {
    throw new Error(`Velora binary not found: ${velora}`);
  }
  return url;
}

function main() {
  const url = validateConfig();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const outputFd = fs.openSync(temporary, "w");
  const logFd = fs.openSync(logPath, "w");
  const args = [
    "fetch",
    "--dump",
    "html",
    "--with-base",
    "--browser-profile",
    CONFIG.profile,
    "--user-data-dir",
    path.resolve(projectRoot, CONFIG.userDataDir),
    "--wait-until",
    CONFIG.waitUntil,
    "--wait-ms",
    String(CONFIG.waitMs),
    "--terminate-ms",
    String(CONFIG.terminateMs),
    url.href,
  ];
  if (CONFIG.includeFrames) {
    args.splice(args.length - 1, 0, "--with-frames");
  }
  if (CONFIG.waitScript) {
    args.splice(args.length - 1, 0, "--wait-script", CONFIG.waitScript);
  }

  console.log(`Exporting: ${url.href}`);
  console.log(`Output: ${output}`);
  console.log(`Log: ${logPath}`);

  const child = spawn(velora, args, {
    cwd: projectRoot,
    stdio: ["ignore", outputFd, "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    fs.writeSync(logFd, chunk);
    process.stderr.write(chunk);
  });

  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  child.once("close", (code, signal) => {
    fs.closeSync(outputFd);
    fs.closeSync(logFd);

    if (spawnError) {
      fs.rmSync(temporary, { force: true });
      console.error(`Could not start Velora: ${spawnError.message}`);
      process.exitCode = 1;
      return;
    }

    const rawHtml = fs.readFileSync(temporary, "utf8");
    if (!isCompleteHtml(rawHtml)) {
      // Keep the partial artifact for diagnosis/recovery. A browser crash can
      // happen during teardown after the serializer has already emitted most
      // of the document; deleting it would hide useful output.
      const partialOutput = `${output}.partial`;
      fs.copyFileSync(temporary, partialOutput);
      console.error(
        `Export failed${signal ? ` (${signal})` : ` (exit ${code})`}: incomplete HTML. ` +
        `Partial output kept at ${partialOutput}.`,
      );
      fs.rmSync(temporary, { force: true });
      process.exitCode = 1;
      return;
    }

    const normalizedHtml = normalizeTransientAnimationStyles(rawHtml);
    const result = CONFIG.keepScripts
      ? { html: normalizedHtml, removed: 0 }
      : stripScriptElements(normalizedHtml);
    fs.writeFileSync(temporary, result.html, "utf8");
    fs.renameSync(temporary, output);

    if (!CONFIG.keepScripts) {
      console.log(`Removed ${result.removed} <script> element(s).`);
    }
    console.log(`Done: ${output} (${Buffer.byteLength(result.html)} bytes)`);

    const exportState = classifyExportState(result.html);
    if (exportState === "pending") {
      console.warn(
        "Warning: HTML is valid, but the page is still in a security-verification pending state.",
      );
      process.exitCode = 2;
      return;
    }

    if (code !== 0 || signal) {
      console.warn(
        `Warning: HTML is valid, but Velora exited with ${signal || code} during teardown.`,
      );
      process.exitCode = 1;
    }
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
