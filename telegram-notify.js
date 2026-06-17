#!/usr/bin/env node
/**
 * Telegram notifier for Grok task completion.
 *
 * Setup:
 * 1. Create a bot via @BotFather, copy the token.
 * 2. Get your chat id (message @userinfobot or send /start to your bot and call getUpdates).
 * 3. Fill CONFIG below OR set env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
 *
 * Usage:
 *   node telegram-notify.js "Velora: fixed grecaptcha render"
 *   node telegram-notify.js --status ok "Added telegram notify rule"
 *   node telegram-notify.js --status fail "Build still failing"
 */

let localConfig = {};
try {
  localConfig = require("./telegram.config.local.js");
} catch {
  // Optional local override; see telegram.config.local.js
}

const CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || localConfig.botToken || "",
  chatId: process.env.TELEGRAM_CHAT_ID || localConfig.chatId || "",
  enabled: process.env.TELEGRAM_NOTIFY !== "0",
  projectName: process.env.TELEGRAM_PROJECT_NAME || "velora",
};

function parseArgs(argv) {
  const args = [...argv];
  let status = "done";
  const messageParts = [];

  while (args.length > 0) {
    const arg = args[0];
    if (arg === "--status" && args[1]) {
      status = args[1];
      args.splice(0, 2);
      continue;
    }
    messageParts.push(arg);
    args.shift();
  }

  return { status, message: messageParts.join(" ").trim() };
}

function formatMessage(status, message) {
  const icon = status === "ok" || status === "done" ? "✅" : status === "fail" ? "❌" : "ℹ️";
  const body = message || "Grok finished a task";
  const project = CONFIG.projectName ? `[${CONFIG.projectName}] ` : "";
  return `${icon} ${project}${body}`;
}

async function sendTelegramMessage(text) {
  if (!CONFIG.enabled) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const token = CONFIG.botToken.trim();
  const chatId = CONFIG.chatId.trim();
  if (!token || !chatId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing botToken or chatId (edit CONFIG or set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)",
    };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const reason = data.description || `HTTP ${response.status}`;
    return { ok: false, reason };
  }

  return { ok: true };
}

async function main() {
  const { status, message } = parseArgs(process.argv.slice(2));
  const text = formatMessage(status, message);
  const result = await sendTelegramMessage(text);

  if (result.skipped) {
    console.error(`[telegram-notify] skipped: ${result.reason}`);
    process.exit(0);
  }

  if (!result.ok) {
    console.error(`[telegram-notify] failed: ${result.reason}`);
    process.exit(1);
  }

  console.log("[telegram-notify] sent");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[telegram-notify] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { CONFIG, sendTelegramMessage, formatMessage };