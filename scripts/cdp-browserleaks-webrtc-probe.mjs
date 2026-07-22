#!/usr/bin/env node
/**
 * BrowserLeaks WebRTC page + ICE gathering probe (raw CDP).
 * Budget: max 20s default. Hang → SIGKILL, exit 3.
 *
 *   node scripts/cdp-browserleaks-webrtc-probe.mjs
 *   node scripts/cdp-browserleaks-webrtc-probe.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/cdp-browserleaks-webrtc-probe.mjs --skip-page   # ICE-only, faster
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const OUT_DIR = join(REPO, "code-check/tmp/browserleaks-webrtc");

const STUN = "stun:stun.l.google.com:19302";
const PAGE_URL = "https://browserleaks.com/webrtc";

/** Start ICE gather + mediaDevices snapshot into window.__blWebrtc */
const START_ICE = `(() => {
  if (window.__blWebrtc) {
    try { window.__blWebrtc.pc && window.__blWebrtc.pc.close(); } catch {}
  }
  const state = {
    startedAt: Date.now(),
    candidates: [],
    nullCandidate: false,
    gatheringStates: [],
    errors: [],
    localSdp: null,
    devices: null,
    deviceProto: null,
    support: {
      RTCPeerConnection: typeof RTCPeerConnection !== 'undefined',
      RTCDataChannel: typeof RTCDataChannel !== 'undefined',
      RTCIceCandidate: typeof RTCIceCandidate !== 'undefined',
      mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
      MediaDeviceInfo: typeof MediaDeviceInfo !== 'undefined',
    },
    iceGatheringState: null,
    done: false,
  };
  window.__blWebrtc = state;

  (async () => {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const list = await navigator.mediaDevices.enumerateDevices();
        state.devices = list.map((d) => ({
          deviceId: d.deviceId,
          groupId: d.groupId,
          kind: d.kind,
          label: d.label,
          ctor: d && d.constructor ? d.constructor.name : null,
          isMediaDeviceInfo: typeof MediaDeviceInfo !== 'undefined' ? (d instanceof MediaDeviceInfo) : null,
        }));
        state.deviceProto = list[0]
          ? Object.prototype.toString.call(list[0])
          : null;
      }
    } catch (e) {
      state.errors.push('enumerateDevices: ' + String(e && e.message || e));
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(STUN)} }] });
      state.pc = pc;
      state.gatheringStates.push(pc.iceGatheringState);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          state.nullCandidate = true;
          state.done = true;
          state.iceGatheringState = pc.iceGatheringState;
          return;
        }
        const line = ev.candidate.candidate || String(ev.candidate);
        state.candidates.push(line);
        state.iceGatheringState = pc.iceGatheringState;
      };
      pc.onicegatheringstatechange = () => {
        state.gatheringStates.push(pc.iceGatheringState);
        state.iceGatheringState = pc.iceGatheringState;
        if (pc.iceGatheringState === 'complete') state.done = true;
      };
      pc.createDataChannel('bl');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.localSdp = (pc.localDescription && pc.localDescription.sdp) || offer.sdp || null;
    } catch (e) {
      state.errors.push('ice: ' + String(e && e.message || e));
      state.done = true;
    }
  })();
  return { started: true, support: state.support };
})()`;

const POLL_ICE = `(() => {
  const s = window.__blWebrtc;
  if (!s) return { missing: true };
  const cands = s.candidates.slice();
  const host = [];
  const srflx = [];
  const relay = [];
  const publicIps = [];
  const hostIps = [];
  for (const line of cands) {
    const m = String(line).match(/\\btyp\\s+(\\w+)/);
    const typ = m ? m[1] : '?';
    const ipm = String(line).match(/\\s(\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-fA-F:]+)\\s+\\d+\\s+typ\\s/);
    const ip = ipm ? ipm[1] : null;
    if (typ === 'host') { host.push(line); if (ip) hostIps.push(ip); }
    else if (typ === 'srflx') { srflx.push(line); if (ip) publicIps.push(ip); }
    else if (typ === 'relay') relay.push(line);
  }
  return {
    done: !!s.done,
    nullCandidate: !!s.nullCandidate,
    iceGatheringState: s.iceGatheringState || (s.pc && s.pc.iceGatheringState) || null,
    gatheringStates: s.gatheringStates,
    candidateCount: cands.length,
    hostCount: host.length,
    srflxCount: srflx.length,
    relayCount: relay.length,
    hostIps: [...new Set(hostIps)],
    publicIps: [...new Set(publicIps)],
    candidates: cands,
    localSdpLen: s.localSdp ? s.localSdp.length : 0,
    localSdpHasSrflx: !!(s.localSdp && /typ srflx/.test(s.localSdp)),
    devices: s.devices,
    deviceProto: s.deviceProto,
    support: s.support,
    errors: s.errors,
    elapsedMs: Date.now() - s.startedAt,
  };
})()`;

const PAGE_SNAP = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const rows = {};
  const grab = (label) => {
    // Prefer table-like "LabelValue" glued, or Label\\nValue
    const re1 = new RegExp(label.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\s*([\\\\d.:a-fA-F]+|Yes|No|Supported|Not Supported|Allowed|Denied|Prompt|n\\\\/a|—|-)', 'i');
    const m1 = text.match(re1);
    if (m1) return m1[1].trim();
    return null;
  };
  const labels = [
    'IPv4 Address', 'IPv6 Address', 'Local IP Address', 'Public IP Address',
    'RTCPeerConnection', 'RTCDataChannel', 'Media Devices',
    'Audio Capture Permissions', 'Video Capture Permissions',
  ];
  for (const l of labels) rows[l] = grab(l);

  // DOM ids used by browserleaks (best-effort)
  const byId = (id) => {
    const el = document.getElementById(id);
    return el ? (el.textContent || '').trim().slice(0, 200) : null;
  };
  const idHints = {};
  for (const id of ['webrtc-local-ip', 'webrtc-public-ip', 'local-ip', 'public-ip', 'stun', 'ipv4', 'ipv6']) {
    idHints[id] = byId(id);
  }

  return {
    href: location.href,
    title: document.title,
    ready: document.readyState,
    bodyLen: text.length,
    bodyHead: text.replace(/\\s+/g, ' ').trim().slice(0, 900),
    rows,
    idHints,
    supportLive: {
      RTCPeerConnection: typeof RTCPeerConnection !== 'undefined',
      mediaDevices: !!(navigator.mediaDevices),
    },
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 20),
    skipPage: false,
    logLevel: "info",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--skip-page") out.skipPage = true;
    else if (a === "--log-level") out.logLevel = argv[++i];
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] || 20);
  }
  return out;
}

async function getFreePort() {
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

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId = null, timeoutMs = 12000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
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

async function evalExpr(client, sessionId, expression, timeoutMs) {
  const r = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
    timeoutMs,
  );
  return r.result?.value;
}

function scoreIce(ice) {
  const checks = [];
  const ok = (name, cond, detail) => {
    checks.push({ name, ok: !!cond, detail: detail ?? null });
    return !!cond;
  };
  ok("host_candidates", (ice.hostCount || 0) >= 1, `host=${ice.hostCount}`);
  ok("srflx_candidates", (ice.srflxCount || 0) >= 1, `srflx=${ice.srflxCount} ips=${(ice.publicIps || []).join(",")}`);
  ok("null_candidate_end", ice.nullCandidate === true, `nullCandidate=${ice.nullCandidate}`);
  ok("gathering_complete", ice.iceGatheringState === "complete" || ice.nullCandidate, ice.iceGatheringState);
  ok("media_devices", Array.isArray(ice.devices) && ice.devices.length >= 2, `n=${ice.devices?.length}`);
  ok(
    "media_device_info_proto",
    Array.isArray(ice.devices) && ice.devices.some((d) => d.ctor === "MediaDeviceInfo" || d.isMediaDeviceInfo),
    ice.devices?.[0]?.ctor,
  );
  ok("no_ice_errors", !ice.errors?.length, ice.errors);
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing binary:", VELORA_BIN);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let proc = null;
  const cleanup = () => killProcess(proc);
  const budget = createProbeBudget(args.maxSec, cleanup);

  const logChunks = [];
  proc = spawn(
    VELORA_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      args.profile,
      "--log-level",
      args.logLevel,
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  const onLog = (buf) => {
    const t = String(buf);
    logChunks.push(t);
    if (/STUN|srflx|webrtc|ICE/i.test(t)) process.stderr.write(t);
  };
  proc.stdout.on("data", onLog);
  proc.stderr.on("data", onLog);

  try {
    await waitCdp(endpoint, budget.deadline);
  } catch (e) {
    budget.failHang("cdp_ready", String(e));
  }

  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const client = new CdpClient(ws);

  const report = {
    ts: new Date().toISOString(),
    profile: args.profile,
    stun: STUN,
    ice: null,
    page: null,
    checks: [],
    stunLogHits: [],
  };

  try {
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

    // --- ICE target ---
    console.log("[nav] about:blank (ICE harness)");
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    const start = await evalExpr(client, sessionId, START_ICE, Math.min(8000, budget.remaining()));
    console.log("[ice] started", JSON.stringify(start));

    let ice = null;
    const iceDeadline = Date.now() + Math.min(8000, budget.remaining() - 4000);
    while (Date.now() < iceDeadline && budget.remaining() > 2500) {
      await delay(250);
      ice = await evalExpr(client, sessionId, POLL_ICE, Math.min(5000, budget.remaining()));
      if (ice?.done && ((ice.srflxCount || 0) > 0 || ice.nullCandidate)) break;
      if (ice?.done && (ice.srflxCount || 0) === 0 && ice.nullCandidate) {
        // gather complete without srflx — give STUN a bit more only if still gathering earlier
        break;
      }
    }
    // Extra pump if host only
    if (ice && (ice.srflxCount || 0) === 0 && budget.remaining() > 3000) {
      for (let i = 0; i < 8; i++) {
        await delay(300);
        ice = await evalExpr(client, sessionId, POLL_ICE, Math.min(4000, budget.remaining()));
        if ((ice?.srflxCount || 0) > 0 || ice?.nullCandidate) break;
      }
    }

    report.ice = ice;
    report.checks = scoreIce(ice || {});
    writeFileSync(join(OUT_DIR, "ice.json"), JSON.stringify(ice, null, 2));
    console.log(
      "[ice] result",
      JSON.stringify({
        done: ice?.done,
        host: ice?.hostCount,
        srflx: ice?.srflxCount,
        nullCandidate: ice?.nullCandidate,
        gathering: ice?.iceGatheringState,
        publicIps: ice?.publicIps,
        devices: ice?.devices?.length,
        errors: ice?.errors,
      }),
    );

    await client.send("Target.closeTarget", { targetId }).catch(() => {});

    // --- BrowserLeaks page ---
    if (!args.skipPage && budget.remaining() > 5000) {
      console.log("[nav]", PAGE_URL);
      const { targetId: tid } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId: sid } = await client.send("Target.attachToTarget", {
        targetId: tid,
        flatten: true,
      });
      await client.send("Page.enable", {}, sid);
      await client.send("Runtime.enable", {}, sid);
      try {
        await client.send(
          "Page.navigate",
          { url: PAGE_URL },
          sid,
          Math.min(12000, budget.remaining()),
        );
      } catch (e) {
        console.log("[nav] error", e.message);
      }
      // Allow page script + STUN gather
      let page = null;
      for (let i = 0; i < 12 && budget.remaining() > 1500; i++) {
        await delay(500);
        try {
          page = await evalExpr(client, sid, PAGE_SNAP, Math.min(5000, budget.remaining()));
          if (page?.bodyLen > 500) break;
        } catch {}
      }
      // Wait a bit more for Local/Public IP DOM fill
      for (let i = 0; i < 10 && budget.remaining() > 1500; i++) {
        await delay(400);
        try {
          page = await evalExpr(client, sid, PAGE_SNAP, Math.min(4000, budget.remaining()));
          const local = page?.rows?.["Local IP Address"];
          const pub = page?.rows?.["Public IP Address"];
          if (local || pub) break;
        } catch {}
      }
      report.page = page;
      writeFileSync(join(OUT_DIR, "page.json"), JSON.stringify(page, null, 2));
      console.log(
        "[page]",
        JSON.stringify({
          title: page?.title,
          bodyLen: page?.bodyLen,
          rows: page?.rows,
        }),
      );
      await client.send("Target.closeTarget", { targetId: tid }).catch(() => {});
    }
  } finally {
    client.close();
    budget.clear();
    cleanup();
  }

  const logText = logChunks.join("");
  report.stunLogHits = logText
    .split("\n")
    .filter((l) => /STUN|srflx|webrtc/i.test(l))
    .slice(0, 40);

  writeFileSync(join(OUT_DIR, "REPORT.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, "velora-webrtc.log"), logText.slice(-80_000));

  const fails = report.checks.filter((c) => !c.ok);
  console.log("\n=== CHECKS ===");
  for (const c of report.checks) {
    console.log(`${c.ok ? "[OK]" : "[FAIL]"} ${c.name}`, c.detail ?? "");
  }
  console.log(`artifacts: ${OUT_DIR}`);
  console.log(`stun log lines: ${report.stunLogHits.length}`);

  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
