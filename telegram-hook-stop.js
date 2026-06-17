#!/usr/bin/env node
/**
 * Grok Stop hook handler — sends Telegram when an agent turn ends.
 * Reads hook JSON from stdin; falls back to session chat_history.jsonl.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { sendTelegramMessage, formatMessage } = require("./telegram-notify.js");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function truncate(text, max = 200) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function extractUserText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function pickField(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function getSessionHistoryPath() {
  const sessionId = process.env.GROK_SESSION_ID;
  const workspaceRoot = process.env.GROK_WORKSPACE_ROOT;
  if (!sessionId || !workspaceRoot) return null;
  const encoded = encodeURIComponent(workspaceRoot);
  return path.join(os.homedir(), ".grok", "sessions", encoded, sessionId, "chat_history.jsonl");
}

function getLastTurnFromHistory() {
  const historyPath = getSessionHistoryPath();
  if (!historyPath || !fs.existsSync(historyPath)) {
    return { user: null, assistant: null };
  }

  const lines = fs.readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
  let lastUser = null;
  let lastAssistant = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!lastAssistant && entry.type === "assistant") {
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (text) lastAssistant = text;
    }

    if (!lastUser && entry.type === "user") {
      const text = extractUserText(entry.content).trim();
      if (text && !text.includes("Your conversation was summarized")) {
        lastUser = text;
      }
    }

    if (lastUser && lastAssistant) break;
  }

  return { user: lastUser, assistant: lastAssistant };
}

function buildMessage(payload) {
  const history = getLastTurnFromHistory();
  const user =
    pickField(payload, ["userPrompt", "userMessage", "prompt", "lastUserMessage"]) ||
    history.user;
  const assistant =
    pickField(payload, [
      "assistantMessage",
      "agentResponse",
      "response",
      "text",
      "lastAssistantMessage",
    ]) || history.assistant;
  const stopReason =
    pickField(payload, ["stopReason", "stop_reason", "reason"]) || "end_turn";

  const parts = [];
  if (user) parts.push(`User: ${truncate(user, 120)}`);
  if (assistant) parts.push(`Grok: ${truncate(assistant, 220)}`);
  if (!parts.length) parts.push(`Grok turn ended (${stopReason})`);

  return parts.join("\n");
}

async function main() {
  const payload = await readStdin();
  const message = buildMessage(payload);
  const stopReason = pickField(payload, ["stopReason", "stop_reason"]) || "";
  const status = /cancel|fail|error/i.test(stopReason) ? "fail" : "ok";
  const text = formatMessage(status, message);
  const result = await sendTelegramMessage(text);

  if (result.skipped) {
    console.error(`[telegram-hook-stop] skipped: ${result.reason}`);
    process.exit(0);
  }

  if (!result.ok) {
    console.error(`[telegram-hook-stop] failed: ${result.reason}`);
    process.exit(1);
  }

  console.log("[telegram-hook-stop] sent");
}

main().catch((err) => {
  console.error(`[telegram-hook-stop] error: ${err.message}`);
  process.exit(1);
});