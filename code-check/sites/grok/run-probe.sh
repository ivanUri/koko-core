#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=57100
pkill -9 lldb 2>/dev/null || true
lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

lldb -b \
  -o "run serve --host 127.0.0.1 --port $PORT --browser-profile chrome-macos-sonoma --log-level warn" \
  -o "process detach" \
  -o quit \
  ./zig-out/bin/velora >/dev/null 2>&1 &

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "velora ready on $PORT"
    break
  fi
  sleep 0.5
done

node -e '
import { Browser } from "./sdk/dist/index.js";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const browser = await Browser.connect("http://127.0.0.1:57100");
try {
  const page = await browser.newPage();
  const cdp = page.session;
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", (p) => {
    const url = p.response?.url || "";
    if (!/grok\.com/.test(url)) return;
    const sc = p.response?.headers?.["set-cookie"] || p.response?.headers?.["Set-Cookie"] || "";
    events.push({ status: p.response?.status, url: url.slice(0,120), cf: String(sc).includes("cf_clearance") });
  });
  cdp.on("Network.requestWillBeSent", (p) => {
    if (/grok\.com/.test(p.request?.url||"") && p.type==="Document") events.push({ doc: true, cookies: (p.request?.headers?.Cookie||"").length });
  });
  await page.goto("https://grok.com/", { waitUntil: "domcontentloaded", timeout: 120000 });
  for (let i = 0; i < 45; i++) {
    const s = await page.evaluate(`({ title: document.title, cf: document.cookie.includes("cf_clearance"), body: (document.body?.innerText||"").slice(0,200) })`);
    console.log(`[${i}] ${s.title} cf=${s.cf}`);
    if (s.cf || (s.title !== "Just a moment..." && !s.body.includes("Verifying") && !s.body.includes("Waiting"))) break;
    await delay(2000);
  }
  const f = await page.evaluate(`({ title: document.title, cf: document.cookie.includes("cf_clearance"), url: location.href, body: (document.body?.innerText||"").slice(0,150) })`);
  console.log("FINAL", JSON.stringify(f));
  for (const e of events) console.log(" ", JSON.stringify(e));
} finally { await browser.close().catch(()=>{}); }
'