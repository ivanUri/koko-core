#!/usr/bin/env node
/**
 * SPA render probe — does the page get past loading shell to real content?
 *
 *   node code-check/spa-render/run.mjs
 *   node code-check/spa-render/run.mjs --site fp-playground,react-docs
 *   node code-check/spa-render/run.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
 *
 * Fresh Velora serve per site. Budget default 20s (project hang rule).
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  remainingMs,
  parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const BIN = resolve(REPO, "zig-out/bin/velora");
const SITES = JSON.parse(readFileSync(join(__dirname, "sites.json"), "utf8")).sites;
const OUT_DIR = join(__dirname, "results");

const SNAP = `(() => {
  const body = (document.body && document.body.innerText) || "";
  const text = body.replace(/\\s+/g, " ").trim();
  const htmlLen = document.documentElement
    ? document.documentElement.outerHTML.length
    : 0;
  const root =
    document.querySelector("#__next, #root, #app, [data-reactroot], svelte-app, app-root") ||
    document.querySelector("main");
  const rootText = root ? (root.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200) : "";
  const loadingLike =
    text.length < 80 &&
    /loading|please wait|javascript is required|enable javascript/i.test(text);
  const hasBailout = !!(
    document.querySelector('template[data-dgst*="BAILOUT"]') ||
    (document.documentElement &&
      document.documentElement.innerHTML.includes("BAILOUT_TO_CLIENT_SIDE_RENDERING"))
  );
  const hasVisitor = /visitor\\s*id|Visitor ID|your visitor/i.test(body);
  return {
    href: location.href,
    title: document.title || "",
    ready: document.readyState,
    htmlLen,
    textLen: text.length,
    textHead: text.slice(0, 180),
    hasRoot: !!document.querySelector("#__next, #root, #app, [data-reactroot], svelte-app, app-root"),
    hasMain: !!document.querySelector("main"),
    rootTag: root ? root.tagName + (root.id ? "#" + root.id : "") : null,
    rootText,
    hasNext: typeof window.next !== "undefined",
    nextKeys: window.next ? Object.keys(window.next).slice(0, 12) : null,
    hasBailout,
    hasVisitor,
    loadingLike,
    childCount: document.body ? document.body.childElementCount : 0,
  };
})()`;

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 20),
    siteFilter: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    else if (a === "--site")
      out.siteFilter = new Set(
        argv[++i].split(",").map((s) => s.trim()).filter(Boolean)
      );
  }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.exceptions = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.exceptions.push(
          (d?.text || d?.exception?.description || "").slice(0, 240)
        );
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, timeoutMs);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitJson(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`timeout ${url}`);
}

async function startOfflineServer(fileAbs) {
  const port = await freePort();
  const body = readFileSync(fileAbs);
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => server.close(),
  };
}

async function evalSnap(cdp, sessionId) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: SNAP, returnByValue: true, awaitPromise: false },
    sessionId,
    8000
  );
  if (r.exceptionDetails) {
    return {
      evalError:
        r.exceptionDetails.text ||
        r.exceptionDetails.exception?.description,
    };
  }
  return r.result?.value ?? null;
}

function judge(site, snap, exceptions) {
  const issues = [];
  if (!snap || snap.evalError) {
    issues.push(snap?.evalError || "no snap");
    return { ok: false, issues };
  }
  if (snap.loadingLike) issues.push("stuck loading shell");
  if ((snap.textLen ?? 0) < (site.minText ?? 100)) {
    issues.push(`text too small (${snap.textLen} < ${site.minText})`);
  }
  if (site.expectTextIncludes) {
    for (const s of site.expectTextIncludes) {
      if (!(snap.textHead || "").includes(s) && !(snap.rootText || "").includes(s)) {
        issues.push(`missing text "${s}"`);
      }
    }
  }
  if (site.expectAny?.length) {
    const hit = site.expectAny.some((k) => snap[k] === true);
    if (!hit) issues.push(`none of ${site.expectAny.join("|")} true`);
  }
  // Fatal if many exceptions and still thin content
  if (exceptions.length >= 5 && (snap.textLen ?? 0) < (site.minText ?? 100) * 2) {
    issues.push(`${exceptions.length} exceptions + thin content`);
  }
  return { ok: issues.length === 0, issues };
}

async function probeSite(site, opts) {
  const maxSec = site.maxSec ?? opts.maxSec;
  let offline = null;
  let proc = null;
  let cdp = null;
  const cleanup = () => {
    try {
      cdp?.close();
    } catch {}
    killProcess(proc);
    try {
      offline?.close();
    } catch {}
  };
  const budget = createProbeBudget(maxSec, cleanup);

  try {
    let url = site.url;
    if (site.kind === "offline") {
      const abs = resolve(REPO, site.file);
      if (!existsSync(abs)) throw new Error(`missing fixture ${site.file}`);
      offline = await startOfflineServer(abs);
      url = offline.url;
    }

    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warn",
      "--log-format",
      "pretty",
      "--http-timeout",
      "30000",
    ];
    if (opts.profile) args.push("--browser-profile", opts.profile);

    proc = spawn(BIN, args, {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const ver = await waitJson(`${endpoint}/json/version`, 8000);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
      setTimeout(() => rej(new Error("ws open timeout")), 5000);
    });
    cdp = new Cdp(ws);

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);

    const t0 = Date.now();
    await cdp.send(
      "Page.navigate",
      { url },
      sessionId,
      Math.min(budget.remaining(), maxSec * 1000)
    );

    let best = null;
    let polls = 0;
    while (budget.remaining() > 400) {
      polls++;
      await delay(Math.min(500, budget.remaining()));
      const snap = await evalSnap(cdp, sessionId);
      if (snap && !snap.evalError) {
        best = snap;
        const j = judge(site, snap, cdp.exceptions);
        // Early exit when clearly rendered
        if (
          j.ok &&
          (snap.ready === "complete" || snap.ready === "interactive") &&
          snap.textLen >= (site.minText ?? 100)
        ) {
          break;
        }
      }
      // For offline fixtures, short wait is enough
      if (site.kind === "offline" && polls >= 6) break;
    }

    const ms = Date.now() - t0;
    const verdict = judge(site, best, cdp.exceptions);
    cleanup();
    budget.clear();
    return {
      id: site.id,
      name: site.name,
      url,
      ok: verdict.ok,
      ms,
      polls,
      issues: verdict.issues,
      exceptions: cdp.exceptions.slice(0, 5),
      snap: best
        ? {
            title: best.title?.slice(0, 80),
            ready: best.ready,
            textLen: best.textLen,
            htmlLen: best.htmlLen,
            hasRoot: best.hasRoot,
            hasMain: best.hasMain,
            hasNext: best.hasNext,
            hasVisitor: best.hasVisitor,
            hasBailout: best.hasBailout,
            loadingLike: best.loadingLike,
            textHead: best.textHead,
            rootTag: best.rootTag,
          }
        : null,
      stderrTail: stderr.slice(-400) || undefined,
    };
  } catch (err) {
    cleanup();
    budget.clear();
    return {
      id: site.id,
      name: site.name,
      ok: false,
      error: err.message,
      issues: [err.message],
    };
  }
}

async function main() {
  if (!existsSync(BIN)) {
    console.error("missing zig-out/bin/velora — run zig build first");
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(2));
  let sites = SITES;
  if (opts.siteFilter?.size) {
    sites = SITES.filter((s) => opts.siteFilter.has(s.id));
  }
  if (!sites.length) {
    console.error("no sites");
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  console.log(
    `SPA render probe — profile=${opts.profile} defaultMaxSec=${opts.maxSec} sites=${sites.length}\n`
  );

  for (const site of sites) {
    process.stdout.write(`--- ${site.name} (${site.id}) ---\n`);
    const r = await probeSite(site, opts);
    results.push(r);
    if (r.ok) {
      console.log(
        `  PASS  ${r.ms}ms  text=${r.snap?.textLen}  root=${r.snap?.hasRoot}  next=${r.snap?.hasNext}  visitor=${r.snap?.hasVisitor}`
      );
      console.log(`        title="${r.snap?.title}" head="${r.snap?.textHead?.slice(0, 90)}"`);
    } else {
      console.log(`  FAIL  ${(r.issues || [r.error]).join("; ")}`);
      if (r.snap) {
        console.log(
          `        text=${r.snap.textLen} ready=${r.snap.ready} loadingLike=${r.snap.loadingLike} head="${r.snap.textHead?.slice(0, 90)}"`
        );
      }
      if (r.exceptions?.length) {
        console.log(`        exceptions: ${r.exceptions[0]}`);
      }
    }
    console.log("");
  }

  const passed = results.filter((r) => r.ok).length;
  const report = {
    meta: {
      timestamp: new Date().toISOString(),
      profile: opts.profile,
      maxSec: opts.maxSec,
    },
    overall: {
      total: results.length,
      passed,
      failed: results.length - passed,
      allPassed: passed === results.length,
    },
    results,
  };
  const outPath = join(OUT_DIR, "latest.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== SPA render summary ===\n");
  console.log(
    "Site".padEnd(18) + "Result".padEnd(8) + "ms".padEnd(8) + "text".padEnd(8) + "Notes"
  );
  console.log("-".repeat(72));
  for (const r of results) {
    console.log(
      String(r.id).padEnd(18) +
        (r.ok ? "PASS" : "FAIL").padEnd(8) +
        String(r.ms ?? "-").padEnd(8) +
        String(r.snap?.textLen ?? "-").padEnd(8) +
        (r.ok ? "" : (r.issues || []).join(", ").slice(0, 40))
    );
  }
  console.log(
    `\nOverall: ${passed}/${results.length} rendered\nReport: ${outPath}`
  );
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
