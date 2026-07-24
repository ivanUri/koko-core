#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function usage() {
  console.error(
    "Usage: node scripts/export-site.js <url> [output.html] [--profile <name>] [--keep-scripts]",
  );
  console.error(
    "Example: node scripts/export-site.js https://chat.zalo.me zalo.html --profile chrome-local-huys-macbook-pro",
  );
  console.error(
    "By default, <script> elements are removed so the exported snapshot stays static.",
  );
}

const cliArgs = process.argv.slice(2);
const positional = [];
let profile =
  process.env.VELORA_BROWSER_PROFILE || "chrome-local-huys-macbook-pro";
let keepScripts = false;

for (let index = 0; index < cliArgs.length; index += 1) {
  const argument = cliArgs[index];
  if (argument === "--keep-scripts") {
    keepScripts = true;
    continue;
  }
  if (argument === "--profile") {
    profile = cliArgs[index + 1];
    if (!profile) {
      console.error("--profile requires a profile name");
      process.exit(1);
    }
    index += 1;
    continue;
  }
  if (argument.startsWith("--")) {
    console.error(`Unknown option: ${argument}`);
    usage();
    process.exit(1);
  }
  positional.push(argument);
}

function stripScriptElements(html) {
  let removed = 0;
  const stripped = html.replace(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    () => {
      removed += 1;
      return "";
    },
  );
  return { html: stripped, removed };
}

const input = positional[0];
if (!input) {
  usage();
  process.exit(1);
}

let site;
try {
  site = new URL(input);
  if (site.protocol !== "http:" && site.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported");
  }
} catch (error) {
  console.error(`Invalid URL: ${error.message}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const velora = path.join(projectRoot, "zig-out", "bin", "velora");
if (!fs.existsSync(velora)) {
  console.error(`Velora binary not found: ${velora}`);
  console.error("Build it first with: zig build");
  process.exit(1);
}

const defaultName = `${site.hostname.replace(/[^a-z0-9.-]+/gi, "_")}.html`;
const output = path.resolve(process.cwd(), positional[1] || defaultName);
const temporary = `${output}.partial-${process.pid}`;

fs.mkdirSync(path.dirname(output), { recursive: true });
const outputFd = fs.openSync(temporary, "w");

const args = [
  "fetch",
  "--dump",
  "html",
  "--with-base",
  "--browser-profile",
  profile,
  "--wait-until",
  "done",
  "--wait-ms",
  "30000",
  "--terminate-ms",
  "90000",
  site.href,
];

console.log(`Exporting ${site.href}`);
console.log(`Fingerprint profile: ${profile}`);
console.log(`Scripts: ${keepScripts ? "preserved" : "removed (static snapshot)"}`);
console.log(`Output: ${output}`);

const child = spawn(velora, args, {
  cwd: projectRoot,
  stdio: ["ignore", outputFd, "inherit"],
});

child.on("error", (error) => {
  fs.closeSync(outputFd);
  fs.rmSync(temporary, { force: true });
  console.error(`Could not start Velora: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  fs.closeSync(outputFd);

  let html = "";
  try {
    html = fs.readFileSync(temporary, "utf8");
  } catch {
    // Report the process failure below.
  }

  const completeHtml =
    /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(html) &&
    /<\/html>\s*$/i.test(html);

  if (!completeHtml) {
    fs.rmSync(temporary, { force: true });
    console.error(
      `Export failed${signal ? ` (${signal})` : ` (exit ${code})`}: no complete HTML was produced.`,
    );
    process.exitCode = code || 1;
    return;
  }

  if (!keepScripts) {
    const result = stripScriptElements(html);
    html = result.html;
    fs.writeFileSync(temporary, html, "utf8");
    console.log(`Removed ${result.removed} <script> element(s).`);
  }

  fs.renameSync(temporary, output);
  console.log(`Done: ${output} (${Buffer.byteLength(html)} bytes)`);

  // Velora may currently report a teardown failure after stdout already
  // contains a complete snapshot. Preserve that valid artifact, but do not
  // hide the lifecycle error from the caller.
  if (code !== 0 || signal) {
    console.warn(
      `Warning: HTML was exported, but Velora exited with ${signal || code} during teardown.`,
    );
  }
});
