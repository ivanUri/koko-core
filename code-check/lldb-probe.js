#!/usr/bin/env node

const url = "http://127.0.0.1:62171/json/version";
const deadline = Date.now() + 15000;

async function main() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        console.log(`[lldb-probe] status=${res.status} body=${text.slice(0, 200)}`);
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log("[lldb-probe] timeout waiting for /json/version");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
