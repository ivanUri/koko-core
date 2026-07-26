#!/usr/bin/env node
"use strict";

const CDP_URL = "ws://127.0.0.1:9223/";
const TARGET_URL = "https://chatgpt.com/";
const MESSAGE = "Xin chào, hãy trả lời ngắn gọn: Velora chat test thành công.";

const ws = new WebSocket(CDP_URL);
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(sessionId, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

ws.addEventListener("open", async () => {
  try {
    const { targetId } = await send("Target.createTarget", { url: TARGET_URL });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      ready = await evaluate(sessionId, `Boolean(
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[contenteditable="true"]')
      )`);
      if (ready) break;
      await delay(1000);
    }
    if (!ready) throw new Error("Chat input did not become available");

    const sent = await evaluate(sessionId, `(() => {
      const input = document.querySelector('#prompt-textarea') ||
        document.querySelector('[contenteditable="true"]');
      input.focus();
      input.textContent = ${JSON.stringify(MESSAGE)};
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: ${JSON.stringify(MESSAGE)}
      }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
      return { value: input.textContent, title: document.title };
    })()`);
    console.log(JSON.stringify({ sent: true, message: MESSAGE, page: sent }, null, 2));

    await delay(12000);
    const state = await evaluate(sessionId, `(() => ({
      title: document.title,
      input: (document.querySelector('#prompt-textarea') ||
        document.querySelector('[contenteditable="true"]'))?.textContent || '',
      text: document.body?.innerText.slice(-3000) || ''
    }))()`);
    console.log(JSON.stringify({ state }, null, 2));
    ws.close();
  } catch (error) {
    console.error(error.stack || error.message);
    ws.close();
    process.exitCode = 1;
  }
});
