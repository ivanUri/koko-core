#!/usr/bin/env node
"use strict";

// Standalone authenticated HTTP-proxy checker. It intentionally has no Koko
// imports and no third-party dependencies, so proxy health can be established
// independently from browser-core behavior.

const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const path = require("node:path");

const input = path.resolve(process.argv[2] || "exports/proxies_al_alive.txt");
const concurrency = positiveInt(process.argv[3], 12);
const timeoutMs = positiveInt(process.argv[4], 10_000);
const output = process.argv[5] ? path.resolve(process.argv[5]) : null;
const target = { host: "api.ipify.org", port: 443, path: "/?format=json" };

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProxy(line, lineNumber) {
  const value = line.trim();
  if (!value || value.startsWith("#")) return null;

  if (value.includes("://")) {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      throw new Error(`line ${lineNumber}: only HTTP proxies are supported`);
    }
    return {
      source: value,
      host: url.hostname,
      port: Number(url.port || 80),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error(`line ${lineNumber}: expected host:port:username:password`);
  }
  const [host, portText, username, password] = parts;
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !password) {
    throw new Error(`line ${lineNumber}: invalid proxy fields`);
  }
  return { source: value, host, port, username, password };
}

function checkProxy(proxy) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    let secure;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure?.destroy();
      socket?.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };

    const timer = setTimeout(() => finish({ alive: false, error: "timeout" }), timeoutMs);
    socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.once("error", (error) => finish({ alive: false, error: error.code || error.message }));
    socket.once("connect", () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          "Proxy-Connection: Keep-Alive\r\n\r\n",
      );
    });

    let connectResponse = Buffer.alloc(0);
    socket.on("data", function onConnectData(chunk) {
      connectResponse = Buffer.concat([connectResponse, chunk]);
      const end = connectResponse.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onConnectData);

      const head = connectResponse.subarray(0, end).toString("latin1");
      const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1]);
      if (status !== 200) {
        finish({ alive: false, error: `CONNECT ${status || "invalid response"}` });
        return;
      }

      const trailing = connectResponse.subarray(end + 4);
      if (trailing.length) socket.unshift(trailing);
      secure = tls.connect({ socket, servername: target.host, rejectUnauthorized: true });
      secure.once("error", (error) => finish({ alive: false, error: error.code || error.message }));
      secure.once("secureConnect", () => {
        secure.write(
          `GET ${target.path} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            "Accept: application/json\r\n" +
            "Connection: close\r\n\r\n",
        );
      });

      let response = Buffer.alloc(0);
      secure.on("data", (data) => {
        response = Buffer.concat([response, data]);
        if (response.length > 64 * 1024) finish({ alive: false, error: "response too large" });
      });
      secure.once("end", () => {
        const split = response.indexOf("\r\n\r\n");
        const header = split >= 0 ? response.subarray(0, split).toString("latin1") : "";
        const body = split >= 0 ? response.subarray(split + 4).toString("utf8").trim() : "";
        const statusCode = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1]);
        if (statusCode !== 200) return finish({ alive: false, error: `target HTTP ${statusCode || "invalid"}` });
        try {
          const ip = JSON.parse(body).ip;
          if (typeof ip !== "string" || !ip) throw new Error("missing ip");
          finish({ alive: true, ip });
        } catch {
          finish({ alive: false, error: "invalid target body" });
        }
      });
    });
  });
}

async function main() {
  const proxies = fs
    .readFileSync(input, "utf8")
    .split(/\r?\n/)
    .map((line, index) => parseProxy(line, index + 1))
    .filter(Boolean);
  if (!proxies.length) throw new Error("proxy file is empty");

  let cursor = 0;
  let alive = 0;
  const results = new Array(proxies.length);
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= proxies.length) return;
      const proxy = proxies[index];
      const result = await checkProxy(proxy);
      results[index] = result;
      if (result.alive) alive += 1;
      const endpoint = `${proxy.host}:${proxy.port}`;
      console.log(
        result.alive
          ? `ALIVE ${endpoint} ip=${result.ip} latency=${result.latencyMs}ms`
          : `DEAD  ${endpoint} error=${result.error} latency=${result.latencyMs}ms`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length) }, worker));
  if (output) {
    const aliveLines = proxies
      .filter((_, index) => results[index]?.alive)
      .map((proxy) => proxy.source)
      .join("\n");
    fs.writeFileSync(output, aliveLines ? `${aliveLines}\n` : "", { mode: 0o600 });
    console.log(`Alive list: ${output}`);
  }
  console.log(`\nSummary: ${alive}/${proxies.length} alive`);
  process.exitCode = alive === proxies.length ? 0 : alive > 0 ? 2 : 1;
}

main().catch((error) => {
  console.error(`Proxy check failed: ${error.message}`);
  process.exitCode = 1;
});
