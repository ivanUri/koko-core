#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const velora = path.join(projectRoot, "zig-out", "bin", "velora");
const email = process.argv[2];

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: node scripts/test-google-account-next.js <email>");
  process.exit(2);
}
if (!fs.existsSync(velora)) {
  console.error(`Velora binary not found: ${velora}`);
  process.exit(2);
}

const output = path.join(
  projectRoot,
  "exports/single/accounts.google.com-email-next.html",
);
const partial = `${output}.partial`;
const logPath = path.join(
  projectRoot,
  "export-logs/accounts.google.com-email-next.log",
);
const cookieJar = path.join(projectRoot, "exports/firefox-cookies.json");
const userDataDir = "/tmp/velora-firefox-run";

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const quotedEmail = JSON.stringify(email);
const waitScript = `(() => {
  const destinationReached =
    /\\/signin\\/(rejected|challenge|pwd)/.test(location.pathname);
  if (
    destinationReached &&
    document.readyState === 'complete' &&
    document.body &&
    document.body.childNodes.length > 0
  ) return true;
  const password = document.querySelector(
    'input[name="Passwd"], input[type="password"]:not([name="hiddenPassword"])'
  );
  if (password) return true;
  const input = document.querySelector('input[name="identifier"]');
  if (!input || globalThis.__veloraGoogleIdentifierSubmitted) return false;
  input.focus();
  input.value = ${quotedEmail};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const next = document.querySelector('#identifierNext, button[type="submit"]');
  if (!next) return false;
  globalThis.__veloraGoogleIdentifierSubmitted = true;
  next.click();
  return false;
})()`;
const waitScriptFile = path.join(
  "/tmp",
  `velora-google-account-next-${process.pid}.js`,
);
fs.writeFileSync(waitScriptFile, waitScript);

const args = [
  "fetch",
  "--dump",
  "html",
  "--with-base",
  "--with-frames",
  "--browser-profile",
  "chrome-current",
  "--user-data-dir",
  userDataDir,
  "--cookie-jar",
  cookieJar,
  "--wait-until",
  "done",
  "--wait-ms",
  "10000",
  "--terminate-ms",
  "30000",
  "--wait-script-file",
  waitScriptFile,
  "https://accounts.google.com/",
];

const outputFd = fs.openSync(partial, "w");
const logFd = fs.openSync(logPath, "w");
const useLldb = process.env.VELORA_LLDB === "1";
const command = useLldb ? "lldb" : velora;
const commandArgs = useLldb
  ? ["--batch", "-o", "run", "-o", "bt", "--", velora, ...args]
  : args;
const child = spawn(command, commandArgs, {
  cwd: projectRoot,
  stdio: ["ignore", outputFd, "pipe"],
});

child.stderr.on("data", (chunk) => {
  fs.writeSync(logFd, chunk);
  process.stderr.write(chunk);
});

child.once("error", (error) => {
  console.error(error);
});

child.once("close", (code, signal) => {
  fs.closeSync(outputFd);
  fs.closeSync(logFd);
  fs.rmSync(waitScriptFile, { force: true });

  const bytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (code === 0 && !signal && bytes > 0) {
    fs.renameSync(partial, output);
    console.log(`Done: ${output} (${bytes} bytes)`);
    return;
  }

  console.error(
    `Failed: code=${code ?? "null"} signal=${signal ?? "none"} partial=${partial}`,
  );
  process.exitCode = 1;
});
