#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Chỉ cần sửa cấu hình trong khối này.
const CONFIG = {
  url: "https://grok.com/",
  output: "exports/single/grok.html",
  log: "export-logs/grok.log",
  profile: "huynew",
  keepScripts: false,
  waitUntil: "load",
  waitMs: 20_000,
  terminateMs: 30_000,
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
    "--wait-until",
    CONFIG.waitUntil,
    "--wait-ms",
    String(CONFIG.waitMs),
    "--terminate-ms",
    String(CONFIG.terminateMs),
    url.href,
  ];

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
      fs.rmSync(temporary, { force: true });
      console.error(
        `Export failed${signal ? ` (${signal})` : ` (exit ${code})`}: incomplete HTML.`,
      );
      process.exitCode = 1;
      return;
    }

    const result = CONFIG.keepScripts
      ? { html: rawHtml, removed: 0 }
      : stripScriptElements(rawHtml);
    fs.writeFileSync(temporary, result.html, "utf8");
    fs.renameSync(temporary, output);

    if (!CONFIG.keepScripts) {
      console.log(`Removed ${result.removed} <script> element(s).`);
    }
    console.log(`Done: ${output} (${Buffer.byteLength(result.html)} bytes)`);

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
