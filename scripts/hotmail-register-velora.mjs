#!/usr/bin/env node
/**
 * Register one Outlook/Hotmail account through Velora's native CDP endpoint.
 *
 * This intentionally does not automate CAPTCHA solving. If Microsoft presents
 * a challenge, the exact Velora process, page, proxy and browser profile remain
 * alive and an operator prompt is opened for interaction in that same session.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const PROFILE_ROOT = resolve(HERE, "profiles");
const SUCCESS_FILE = resolve(HERE, "success_accounts.txt");
const SIGNUP_URL = "https://signup.live.com/?lic=1";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const opts = {
    endpoint: null,
    port: null,
    profile: "chrome-local-huys-macbook-pro",
    sourceProfile: null,
    proxy: null,
    mobile: false,
    timeoutMs: 60_000,
    dryRun: false,
    probeEmailStep: false,
    trace: false,
    firstName: null,
    lastName: null,
    password: null,
    email: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--endpoint") opts.endpoint = value().replace(/\/$/, "");
    else if (arg === "--port") opts.port = Number(value());
    else if (arg === "--profile") opts.profile = value();
    else if (arg === "--source-profile") opts.sourceProfile = value();
    else if (arg === "--proxy") opts.proxy = value();
    else if (arg === "--mobile") opts.mobile = true;
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(value());
    else if (arg === "--first-name") opts.firstName = value();
    else if (arg === "--last-name") opts.lastName = value();
    else if (arg === "--password") opts.password = value();
    else if (arg === "--email") opts.email = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--probe-email-step") opts.probeEmailStep = true;
    else if (arg === "--trace") opts.trace = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 5_000) {
    throw new Error("--timeout-ms must be at least 5000");
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    throw new Error("invalid --port");
  }
  return opts;
}

function usage() {
  console.log(`Usage:
  npm run hotmail:register:velora -- --profile chrome-local-huys-macbook-pro
  npm run hotmail:register:velora -- --profile hotmail-13 --source-profile profile_13
  npm run hotmail:register:velora -- --endpoint http://127.0.0.1:9222

Options:
  --profile NAME          persistent Velora fingerprint/cookie profile
  --source-profile NAME   read proxy/mobile settings from scripts/profiles/NAME/meta.json
  --proxy URL             override proxy; passed to Velora --http-proxy
  --mobile                use a 375x812 viewport
  --email ADDRESS         use an explicit @outlook.com/@hotmail.com address
  --first-name NAME       override generated first name
  --last-name NAME        override generated last name
  --password VALUE        override generated password
  --endpoint URL          connect to an already-running Velora CDP server
  --port PORT             port used when this script starts Velora
  --timeout-ms NUMBER     timeout for each form step (default: 60000)
  --dry-run               only open signup.live.com and inspect the page
  --probe-email-step      submit only the email step, then stop at password
  --trace                 show page exceptions and failed network requests

Commands during a CAPTCHA/manual handoff:
  status                  show URL, challenge state and visible page text
  elements                list visible interactive elements and rectangles
  click <x> <y>           click viewport coordinates through trusted CDP input
  click <css selector>    click the centre of the first matching element
  key <text>              insert text into the focused element
  enter                   press Enter
  eval <expression>       evaluate JavaScript in the held page
  continue                finish only after the signup page has been left
  quit                    close without recording success`);
}

function randomAccount(overrides) {
  const firstNames = ["James", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Daniel", "Matthew", "Anthony", "Mark", "Steven", "Andrew", "Joshua", "Kevin", "Brian", "Isabella", "Sophia", "Emma", "Olivia"];
  const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White", "Harris"];
  const firstName = overrides.firstName || firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = overrides.lastName || lastNames[Math.floor(Math.random() * lastNames.length)];
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let index = 0; index < 12; index += 1) password += alphabet[Math.floor(Math.random() * alphabet.length)];
  password = overrides.password || `${password}!@#123`;
  const suffix = Math.floor(1_000_000 + Math.random() * 9_000_000);
  const email = overrides.email || `${firstName.toLowerCase()}${lastName.toLowerCase()}${suffix}@outlook.com`;
  if (!/@(?:outlook|hotmail)\.[a-z.]+$/i.test(email)) throw new Error("--email must be an Outlook or Hotmail address");
  return {
    firstName,
    lastName,
    password,
    email,
    birthYear: Math.floor(Math.random() * 20) + 1985,
    birthMonth: Math.floor(Math.random() * 12) + 1,
    birthDay: Math.floor(Math.random() * 28) + 1,
  };
}

function loadSourceProfile(opts) {
  if (!opts.sourceProfile) return null;
  if (opts.sourceProfile.includes("/") || opts.sourceProfile.includes("\\")) {
    throw new Error("--source-profile must be a profile directory name, not a path");
  }
  const metaPath = resolve(PROFILE_ROOT, opts.sourceProfile, "meta.json");
  if (!metaPath.startsWith(`${PROFILE_ROOT}/`) || !existsSync(metaPath)) {
    throw new Error(`source profile metadata not found: ${metaPath}`);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!opts.proxy && meta.proxy) opts.proxy = meta.proxy;
  if (!opts.mobile && meta.isMobile) opts.mobile = true;
  return { meta, metaPath };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(endpoint, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Velora CDP did not start at ${endpoint}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Velora CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 15_000) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluation failed");
  }
  return response.result?.value;
}

const FINDER_SOURCE = `
const find = (selectors, texts = []) => {
  // Prefer layout geometry over getComputedStyle — Fluent UI + Velora warn on
  // pseudo getComputedStyle and can leave inputs "invisible" under strict CSS checks.
  const visible = (element) => {
    if (!element) return false;
    if (element.disabled || element.getAttribute('aria-hidden') === 'true') return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width > 1 && rect.height > 1) return true;
    if ((element.offsetWidth || 0) > 1 && (element.offsetHeight || 0) > 1) return true;
    // Last resort: present in DOM and not display:none on self.
    try {
      const style = getComputedStyle(element);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    } catch {}
    return element.isConnected;
  };
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      if (!texts.length || texts.some((text) => (element.innerText || element.value || element.getAttribute('aria-label') || '').toLowerCase().includes(text.toLowerCase()))) return element;
    }
  }
  // Fallback: first connected match without geometry (SPA hydration lag).
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!element?.isConnected) continue;
      if (element.disabled) continue;
      if (!texts.length || texts.some((text) => (element.innerText || element.value || element.getAttribute('aria-label') || '').toLowerCase().includes(text.toLowerCase()))) return element;
    }
  }
  return null;
};`;

async function pageState(cdp, sessionId) {
  const expression = `(() => {
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const captcha = document.querySelector('iframe[data-testid="humanCaptchaIframe"], iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[src*="challenge"], [data-testid*="captcha" i]');
    const rect = captcha?.getBoundingClientRect?.();
    const href = location.href;
    const challenge = !!captcha || /captcha|verify you are human|press and hold|prove.*human/i.test(text);
    const onSignup = location.hostname === 'signup.live.com' || href.includes('/signup');
    const email = document.querySelector('input[type="email"], input[name="MemberName"], #usernameInput');
    return {
      href,
      title: document.title || '',
      readyState: document.readyState,
      onSignup,
      challenge,
      success: !onSignup && /^https:\\/\\/(?:[^/]+\\.)?(?:live|microsoft|outlook)\\.com(?:[/:]|$)/i.test(href),
      emailInput: !!document.querySelector('input[type="email"], input[name="MemberName"], #usernameInput'),
      emailControl: email ? {
        outerHTML: email.outerHTML.slice(0, 1000),
        parentText: (email.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      } : null,
      scriptCount: document.scripts.length,
      environment: {
        htmlLang: document.documentElement.lang,
        htmlDir: document.documentElement.dir,
        navigatorLanguage: navigator.language,
        navigatorLanguages: navigator.languages,
        userAgent: navigator.userAgent,
      },
      trace: globalThis.__veloraHotmailTrace || [],
      captchaRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      bodyHead: text.slice(0, 500),
    };
  })()`;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await evaluate(cdp, sessionId, expression);
    } catch (error) {
      lastError = error;
      if (!/execution context|realm|navigation/i.test(error.message)) throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

function printState(state) {
  const verdict = state.success ? "SUCCESS" : state.challenge ? "CAPTCHA" : "PENDING";
  console.log(`[${verdict}] ${state.href}`);
  console.log(`ready=${state.readyState} signup=${state.onSignup} emailInput=${state.emailInput} scripts=${state.scriptCount} title=${JSON.stringify(state.title)}`);
  if (state.captchaRect) console.log(`captchaRect=${JSON.stringify(state.captchaRect)}`);
  if (state.emailControl) console.log(`emailControl=${JSON.stringify(state.emailControl)}`);
  if (state.bodyHead) console.log(state.bodyHead);
  if (!state.emailInput) console.log(`environment=${JSON.stringify(state.environment)}`);
  if (state.trace?.length) console.log(`pageTrace=${JSON.stringify(state.trace, null, 2)}`);
}

async function waitFor(cdp, sessionId, label, selectors, timeoutMs, texts = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
        const element = find(${JSON.stringify(selectors)}, ${JSON.stringify(texts)});
        return element ? {
          found: true,
          tag: element.tagName,
          id: element.id || null,
          name: element.getAttribute('name'),
          type: element.getAttribute('type'),
          text: (element.innerText || element.value || '').trim().slice(0, 120),
        } : { found: false };
      })()`);
      if (result.found) return result;
    } catch (error) {
      if (!/execution context|realm|navigation/i.test(error.message)) throw error;
    }
    const state = await pageState(cdp, sessionId).catch(() => null);
    if (state?.success) return { success: true };
    if (state?.challenge) {
      console.warn(`[wait] challenge detected while waiting for ${label}`);
      printState(state);
      return { challenge: true, state };
    }
    await sleep(250);
  }
  const state = await pageState(cdp, sessionId).catch(() => null);
  if (state) printState(state);
  throw new Error(`timeout waiting for ${label}${state?.bodyHead ? `; page: ${state.bodyHead}` : ""}`);
}

async function fill(cdp, sessionId, selectors, value, label, timeoutMs) {
  const waited = await waitFor(cdp, sessionId, label, selectors, timeoutMs);
  if (waited?.challenge) throw new Error(`blocked by challenge while filling ${label}`);
  console.log(`[fill] ${label} found`, waited?.id || waited?.name || waited?.type || waited?.tag || "");

  const focused = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const element = find(${JSON.stringify(selectors)});
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus();
    element.click?.();
    globalThis.__veloraInputTrace = [];
    if (!globalThis.__veloraInputTraceInstalled) {
      globalThis.__veloraInputTraceInstalled = true;
      for (const type of ['beforeinput', 'input']) {
        document.addEventListener(type, event => {
          globalThis.__veloraInputTrace.push({ scope: 'document', type, data: event.data, target: event.target?.tagName, value: event.target?.value, trusted: event.isTrusted });
        }, true);
      }
    }
    for (const type of ['keydown', 'beforeinput', 'input', 'keyup', 'change']) {
      element.addEventListener(type, event => {
        globalThis.__veloraInputTrace.push({ scope: 'target', type, key: event.key, data: event.data, value: element.value, trusted: event.isTrusted });
        if (globalThis.__veloraInputTrace.length > 160) globalThis.__veloraInputTrace.shift();
      });
    }
    // Clear existing value via select+backspace when select works; else Cmd/Ctrl-A.
    try {
      const selectable = element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(element.type));
      if (selectable && typeof element.select === 'function') element.select();
    } catch {}
    return document.activeElement === element || element === document.activeElement;
  })()`);
  if (!focused) throw new Error(`could not focus ${label}`);

  // Trusted path: select-all + insertText (Velora now supports selection on
  // type=email; insertText replaces full selection like Chrome).
  const text = String(value);
  await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const element = find(${JSON.stringify(selectors)});
    if (!element) return false;
    element.focus();
    try {
      if (typeof element.select === 'function') element.select();
      else if (typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(0, (element.value || '').length);
      }
    } catch {}
    return true;
  })()`);
  await cdp.send("Input.insertText", { text }, sessionId);
  await sleep(250);

  // If insertText did not stick (empty), fall back to per-char keys once.
  // Skip key spam when Fluent kept the local-part of an email (normal).
  let current = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const element = find(${JSON.stringify(selectors)});
    return element?.value ?? null;
  })()`).catch(() => null);
  const localOfText = text.includes("@") ? text.split("@")[0] : text;
  const localOk = current && (current === text || current === localOfText || current.replace(/@.*/, "") === localOfText);
  if (!localOk) {
    console.warn(`[fill] insertText incomplete for ${label} (have=${JSON.stringify(current)}); typing keys`);
    await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
      const element = find(${JSON.stringify(selectors)});
      if (!element) return false;
      element.focus();
      try { element.select(); } catch {}
      return true;
    })()`);
    await cdp.send("Input.insertText", { text: localOfText }, sessionId);
    await sleep(100);
  }

  const wanted = text;
  const localPart = wanted.includes("@") ? wanted.split("@")[0] : wanted;
  const allowLocalOnly = !wanted.includes("@");
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let result = { matches: false, value: null, active: null, trace: null };
  while (Date.now() < deadline) {
    result = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
      const element = find(${JSON.stringify(selectors)});
      const v = element?.value ?? null;
      const wanted = ${JSON.stringify(wanted)};
      const local = ${JSON.stringify(localPart)};
      const allowLocal = ${JSON.stringify(allowLocalOnly)};
      // Domain-suffix UI ("New email" + visible "@outlook.com") only stores local-part.
      const label = (element.getAttribute('aria-label') || element.getAttribute('name') || '').toLowerCase();
      const domainSuffixUi = /new email|membername|username/.test(label)
        || (/enter your new email/i.test(document.body?.innerText || '')
          && !!document.querySelector('input[type="email"], input[name="email"]'));
      let matches = false;
      if (element && v != null) {
        if (v === wanted) matches = true;
        else if (allowLocal && v === local) matches = true;
        else if (domainSuffixUi && local && (v === local || v.replace(/@.*/, '') === local)) matches = true;
        // Fluent primary email field often keeps local-part only even when
        // insertText sent a full address — treat that as success (domain is
        // a separate control on later steps / implied @outlook.com).
        else if (local && wanted.includes('@') && (v === local || v.replace(/@.*/, '') === local)) matches = true;
      }
      return {
        matches,
        value: v,
        domainSuffixUi,
        active: document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute?.('type') || ''),
        trace: globalThis.__veloraInputTrace?.slice(-30) || null
      };
    })()`).catch(() => ({ matches: false, value: null, active: null, trace: null }));
    if (result.matches) break;
    await sleep(100);
  }
  if (!result.matches) {
    throw new Error(`could not fill ${label} through trusted input (value=${JSON.stringify(result.value)}, active=${result.active}, trace=${JSON.stringify(result.trace)})`);
  }
  console.log(`[fill] ${label} ok value=${JSON.stringify(result.value)}`);
  await sleep(350);
}

async function pointerClick(cdp, sessionId, x, y) {
  const common = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mousePressed" }, sessionId);
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
}

/**
 * Match hotmail-register.js (Playwright/Chroma):
 * - Target only iframe[data-testid="humanCaptchaIframe"] center
 * - mouse move → down → hold ~12s → up
 * - Never hold the page "Press and hold…" label DIV
 * - Hard cap 15s; longer / tiny iframe box = error (no 3‑minute wait)
 */
const CAPTCHA_HOLD_MS = 12_000;
const CAPTCHA_HOLD_MAX_MS = 15_000;
/** Chrome rejects useless boxes; Velora often reports 5×5 for broken iframe layout. */
const CAPTCHA_IFRAME_MIN_W = 40;
const CAPTCHA_IFRAME_MIN_H = 40;

async function findHumanCaptchaIframeBox(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)];
    const frames = [
      ...pick('iframe[data-testid="humanCaptchaIframe"]'),
      ...pick('iframe[src*="arkoselabs"]'),
      ...pick('iframe[src*="captcha"]'),
      ...pick('iframe[src*="challenge"]'),
      ...pick('iframe[title*="erification" i]'),
      ...pick('iframe[title*="challenge" i]'),
    ];
    // de-dupe
    const seen = new Set();
    const list = [];
    for (const el of frames) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      list.push({
        testid: el.getAttribute("data-testid") || "",
        title: (el.title || "").slice(0, 80),
        src: (el.src || "").slice(0, 120),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
      });
    }
    const usable = list.find((b) => b.w >= ${CAPTCHA_IFRAME_MIN_W} && b.h >= ${CAPTCHA_IFRAME_MIN_H});
    const any = list[0] || null;
    const text = (document.body?.innerText || "").replace(/\\s+/g, " ");
    const holdUi = /press and hold|prove you.?re human|verify you are human/i.test(text)
      || /prove you.?re human/i.test(document.title || "");
    return {
      holdUi,
      title: document.title || "",
      frames: list,
      box: usable || null,
      tiny: any && !usable ? any : null,
    };
  })()`);
}

/**
 * Press-and-hold like hotmail-register.js:
 * iframe center → mouseMoved → mousePressed → sleep(holdMs) → mouseReleased.
 */
async function pressAndHoldCaptcha(cdp, sessionId, holdMs = CAPTCHA_HOLD_MS) {
  const holdBudget = Math.min(Math.max(1_000, holdMs), CAPTCHA_HOLD_MAX_MS);

  // Chrome waits ~7s for iframe after name Next
  console.log("[captcha] waiting for humanCaptchaIframe (like Chroma/Playwright)…");
  let info = null;
  const waitDeadline = Date.now() + 15_000;
  while (Date.now() < waitDeadline) {
    info = await findHumanCaptchaIframeBox(cdp, sessionId).catch(() => null);
    if (info?.box) break;
    // Already left signup / captcha
    const state = await pageState(cdp, sessionId).catch(() => null);
    if (state?.success) {
      return { attempted: false, success: true, timedOut: false, failed: false, heldMs: 0, error: null, state };
    }
    if (info && !info.holdUi && !info.tiny && (!info.frames || info.frames.length === 0)) {
      // Not on captcha UI
      break;
    }
    await sleep(400);
  }

  if (!info) {
    return { attempted: false, success: false, timedOut: false, failed: true, heldMs: 0, error: "captcha_inspect_failed" };
  }

  console.log(`[captcha] ui title=${JSON.stringify(info.title)} holdUi=${!!info.holdUi} frames=${JSON.stringify(info.frames)}`);

  if (info.tiny && !info.box) {
    console.error(
      `[captcha] ERROR: humanCaptchaIframe layout unusable `
      + `(${info.tiny.w}×${info.tiny.h}); need ≥${CAPTCHA_IFRAME_MIN_W}×${CAPTCHA_IFRAME_MIN_H} `
      + `(Chrome uses real boundingBox). Skip fake hold on label text.`,
    );
    return {
      attempted: false,
      success: false,
      timedOut: false,
      failed: true,
      heldMs: 0,
      error: "captcha_iframe_layout_broken",
      target: info.tiny,
      state: await pageState(cdp, sessionId).catch(() => null),
    };
  }

  if (!info.box) {
    // Maybe auto-passed
    const state = await pageState(cdp, sessionId).catch(() => null);
    if (state?.success) {
      return { attempted: false, success: true, timedOut: false, failed: false, heldMs: 0, error: null, state };
    }
    if (!info.holdUi) {
      console.warn("[captcha] no humanCaptchaIframe and not hold UI — skip hold");
      return {
        attempted: false,
        success: false,
        timedOut: false,
        failed: true,
        heldMs: 0,
        error: "captcha_iframe_missing",
        state,
      };
    }
    console.error("[captcha] ERROR: hold UI visible but no usable iframe box");
    return {
      attempted: false,
      success: false,
      timedOut: false,
      failed: true,
      heldMs: 0,
      error: "captcha_iframe_missing",
      state,
    };
  }

  const x = info.box.cx;
  const y = info.box.cy;
  console.log(
    `[captcha] hold iframe center @(${x.toFixed(1)},${y.toFixed(1)}) `
    + `size=${info.box.w.toFixed(0)}×${info.box.h.toFixed(0)} hold=${holdBudget}ms (cap ${CAPTCHA_HOLD_MAX_MS}ms)`,
  );

  // Mirror Playwright: move → pause → down → hold → up
  const common = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none" }, sessionId);
  await sleep(1000);
  await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mousePressed" }, sessionId);
  console.log("[captcha] mousePressed — holding…");

  const started = Date.now();
  let released = false;
  let success = false;
  let leftUi = false;
  try {
    while (true) {
      const elapsed = Date.now() - started;
      const remaining = holdBudget - elapsed;
      if (remaining <= 0) break;
      await sleep(Math.min(400, remaining));
      const nowElapsed = Date.now() - started;
      const state = await pageState(cdp, sessionId).catch(() => null);
      if (state?.success) {
        success = true;
        console.log(`[captcha] success during hold after ${nowElapsed}ms → ${state.href}`);
        break;
      }
      const still = await evaluate(cdp, sessionId, `(() => {
        const t = (document.body?.innerText || "") + " " + (document.title || "");
        return /prove you.?re human|press and hold|verify you are human/i.test(t);
      })()`).catch(() => true);
      if (!still) {
        leftUi = true;
        console.log(`[captcha] human-check UI left after ${nowElapsed}ms`);
        break;
      }
      if (nowElapsed >= 2000 && (nowElapsed % 2000) < 500) {
        console.log(`[captcha] holding… ${nowElapsed}ms / ${holdBudget}ms`);
      }
    }
  } finally {
    try {
      await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
      released = true;
      console.log(`[captcha] mouseReleased after ${Date.now() - started}ms`);
    } catch (error) {
      console.warn(`[captcha] mouseReleased failed: ${error.message}`);
    }
  }

  const heldMs = Date.now() - started;
  await sleep(500);
  const after = await pageState(cdp, sessionId).catch(() => null);
  if (after?.success) success = true;
  // Short post-hold: only check if redirect started (Chrome waits up to 3m — we do not)
  if (!success) {
    const leftSignup = after && !after.onSignup;
    if (leftSignup) success = true;
  }
  const stillChallenge = !success && (
    !!after?.challenge
    || /prove you.?re human|press and hold|verify you are human/i.test(`${after?.title || ""} ${after?.bodyHead || ""}`)
  );
  const timedOut = !success && stillChallenge && heldMs >= holdBudget - 100;
  const failed = !success;

  console.log(
    `[captcha] after hold: success=${success} timedOut=${timedOut} challenge=${stillChallenge} `
    + `heldMs=${heldMs} title=${JSON.stringify(after?.title)} href=${after?.href || ""}`,
  );
  if (after?.bodyHead) console.log(`[captcha] bodyHead=${JSON.stringify(after.bodyHead.slice(0, 200))}`);
  if (timedOut) {
    console.error(`[captcha] ERROR: hold ${holdBudget}ms did not clear challenge (max allowed ${CAPTCHA_HOLD_MAX_MS}ms)`);
  } else if (failed) {
    console.error("[captcha] ERROR: press-and-hold did not pass");
  }

  return {
    attempted: true,
    success,
    timedOut,
    failed: failed || timedOut,
    released,
    heldMs,
    target: info.box,
    state: after,
    error: success
      ? null
      : timedOut
        ? `captcha_hold_timeout_${holdBudget}ms`
        : "captcha_hold_failed",
  };
}

async function clickElement(cdp, sessionId, selectors, label, timeoutMs, texts = []) {
  await waitFor(cdp, sessionId, label, selectors, timeoutMs, texts);
  const marker = `velora-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rect = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const element = find(${JSON.stringify(selectors)}, ${JSON.stringify(texts)});
    if (!element) return null;
    try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    element.id = ${JSON.stringify(marker)};
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      w: rect.width,
      h: rect.height,
      disabled: !!(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      text: (element.innerText || element.value || '').trim().slice(0, 80),
      tag: element.tagName,
    };
  })()`);
  if (!rect) throw new Error(`could not click ${label}`);
  if (rect.disabled) console.warn(`[click] ${label} appears disabled text=${JSON.stringify(rect.text)}`);

  // Prefer LP.clickNode (trusted click on the exact node). Pointer geometry on
  // Fluent is often collapsed/wrong and used to hit the footer instead of Next.
  let clicked = false;
  try {
    const { elements = [] } = await cdp.send("LP.getInteractiveElements", {}, sessionId, 8_000);
    const target = elements.find((element) => element.id === marker);
    if (target?.backendNodeId) {
      await cdp.send("LP.clickNode", { backendNodeId: target.backendNodeId }, sessionId, 8_000);
      clicked = true;
      console.log(`[click] ${label} via LP.clickNode text=${JSON.stringify(rect.text)}`);
    }
  } catch (error) {
    console.warn(`[click] LP.clickNode failed for ${label}: ${error.message}`);
  }

  // Pointer fallback only when rect looks like a real control (not 5×5 collapse).
  if (!clicked && rect.w >= 24 && rect.h >= 16) {
    await pointerClick(cdp, sessionId, rect.x, rect.y);
    clicked = true;
    console.log(`[click] ${label} via pointer (${rect.x.toFixed(1)},${rect.y.toFixed(1)})`);
  }
  if (!clicked) {
    // Last resort: trusted? HTMLElement.click is untrusted — still better than noop.
    await evaluate(cdp, sessionId, `(() => {
      const el = document.getElementById(${JSON.stringify(marker)});
      if (!el) return false;
      el.click();
      return true;
    })()`).catch(() => {});
    console.warn(`[click] ${label} fell back to element.click() (untrusted)`);
  }
  await sleep(500);
}

async function pressEnter(cdp, sessionId) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === "keyDown" ? "\r" : undefined,
    }, sessionId);
  }
  await sleep(500);
}

/** English Fluent month labels for numeric birth month (1–12). */
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function fluentOptionMatchSource(wanted) {
  return `(() => {
    const wanted = ${JSON.stringify(String(wanted))};
    const n = Number(wanted);
    const monthNames = ${JSON.stringify(MONTH_NAMES)};
    const monthAbbr = ${JSON.stringify(MONTH_ABBR)};
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const matches = (el) => {
      const t = textOf(el);
      const tl = t.toLowerCase();
      const dv = el.getAttribute("data-value") || el.getAttribute("value") || "";
      if (dv === wanted || t === wanted) return true;
      if (Number.isFinite(n) && (dv === String(n) || Number(dv) === n || t === String(n))) return true;
      if (Number.isFinite(n) && n >= 1 && n <= 12) {
        if (tl === monthNames[n - 1] || tl.startsWith(monthAbbr[n - 1])) return true;
      }
      return false;
    };
    const options = [...document.querySelectorAll('[role="option"], [role="listbox"] [data-value], option')]
      .filter((el) => el && el.isConnected && visible(el));
    let option = options.find(matches);
    if (!option && Number.isFinite(n) && n >= 1 && options.length >= n) option = options[n - 1];
    if (!option) {
      return {
        ok: false,
        count: options.length,
        sample: options.slice(0, 16).map((el) => ({ t: textOf(el).slice(0, 40), v: el.getAttribute("data-value") || "" })),
      };
    }
    const marker = "veloraOpt" + Date.now().toString(36);
    option.setAttribute("data-velora-opt", marker);
    option.id = option.id || marker;
    option.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = option.getBoundingClientRect();
    return {
      ok: true,
      marker,
      id: option.id,
      text: textOf(option),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      w: rect.width,
      h: rect.height,
    };
  })()`;
}

async function comboboxShowsValue(cdp, sessionId, selectors, value) {
  return evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const el = find(${JSON.stringify(selectors)});
    if (!el) return { ok: false, reason: "missing" };
    const shown = (el.querySelector('[data-testid="truncatedSelectedText"]')?.textContent
      || el.innerText || el.getAttribute("value") || "").replace(/\\s+/g, " ").trim();
    const wanted = ${JSON.stringify(String(value))};
    const n = Number(wanted);
    const monthNames = ${JSON.stringify(MONTH_NAMES)};
    const monthAbbr = ${JSON.stringify(MONTH_ABBR)};
    const sl = shown.toLowerCase();
    let ok = shown.length > 0;
    if (ok && Number.isFinite(n) && n >= 1 && n <= 12 && /month/i.test(${JSON.stringify(selectors.join(" "))})) {
      ok = sl === monthNames[n - 1] || sl.startsWith(monthAbbr[n - 1]) || shown === String(n);
    } else if (ok && Number.isFinite(n) && /day/i.test(${JSON.stringify(selectors.join(" "))})) {
      ok = shown === String(n) || Number(shown) === n;
    }
    return { ok, shown, value: el.getAttribute("value") };
  })()`).catch(() => ({ ok: false }));
}

async function dispatchKey(cdp, sessionId, key, code, windowsVirtualKeyCode, text) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", {
    ...base,
    type: "keyDown",
    text: text ?? undefined,
    unmodifiedText: text ?? undefined,
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, sessionId);
}

/**
 * Open Fluent combobox / <select> and pick a value.
 * Prefer hotmail-register.js keyboard path: click open → Home → ArrowDown×(n-1) → Enter.
 */
async function choose(cdp, sessionId, selectors, value, label, timeoutMs) {
  await waitFor(cdp, sessionId, label, selectors, timeoutMs);
  const wanted = String(value);
  const n = Number(wanted);

  // Native <select>
  const native = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
    const element = find(${JSON.stringify(selectors)});
    if (!(element instanceof HTMLSelectElement)) return { done: false };
    const wanted = ${JSON.stringify(wanted)};
    const n = Number(wanted);
    const option = [...element.options].find((item) =>
      item.value === wanted
      || item.textContent.trim() === wanted
      || (Number.isFinite(n) && (item.value === String(n) || Number(item.value) === n))
    ) || (Number.isFinite(n) && n >= 1 ? element.options[n - 1] : null);
    if (!option) return { done: false, reason: "no-native-option" };
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { done: true, via: "select", text: option.textContent.trim() };
  })()`);
  if (native?.done) {
    console.log(`[choose] ${label}=${wanted} via <select> ${JSON.stringify(native.text)}`);
    return;
  }

  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`could not select ${value} for ${label}: need numeric option`);
  }

  // Primary path = Chrome script: force open + Home + ArrowDown (n-1) + Enter
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await dispatchKey(cdp, sessionId, "Escape", "Escape", 27);
    await sleep(120);
    await clickElement(cdp, sessionId, selectors, `${label} open#${attempt}`, timeoutMs);
    await sleep(800);
    await dispatchKey(cdp, sessionId, "Home", "Home", 36);
    await sleep(400);
    // hotmail-register.js: for (i = 1; i < n; i++) ArrowDown  → n-1 downs from first item
    for (let i = 1; i < n; i += 1) {
      await dispatchKey(cdp, sessionId, "ArrowDown", "ArrowDown", 40);
      await sleep(40);
    }
    await pressEnter(cdp, sessionId);
    await sleep(500);
    const shown = await comboboxShowsValue(cdp, sessionId, selectors, wanted);
    if (shown?.ok) {
      console.log(`[choose] ${label}=${wanted} via keyboard shown=${JSON.stringify(shown.shown)} value=${JSON.stringify(shown.value)}`);
      return;
    }
    console.warn(`[choose] ${label} keyboard attempt ${attempt} not confirmed: ${JSON.stringify(shown)}`);
  }

  // Secondary: LP.clickNode on list option (less reliable for Fluent state)
  await dispatchKey(cdp, sessionId, "Escape", "Escape", 27);
  await clickElement(cdp, sessionId, selectors, `${label} option-fallback`, timeoutMs);
  await sleep(400);
  let found = null;
  const findDeadline = Date.now() + 4_000;
  while (Date.now() < findDeadline) {
    found = await evaluate(cdp, sessionId, fluentOptionMatchSource(wanted)).catch(() => null);
    if (found?.ok) break;
    await sleep(200);
  }
  if (found?.ok) {
    try {
      const { elements = [] } = await cdp.send("LP.getInteractiveElements", {}, sessionId, 8_000);
      const byText = elements.find((el) => {
        const t = String(el.text || el.name || "").replace(/\s+/g, " ").trim().toLowerCase();
        const want = String(found.text || "").toLowerCase();
        return t === want || t === wanted || t === String(n);
      });
      if (byText?.backendNodeId) {
        await cdp.send("LP.clickNode", { backendNodeId: byText.backendNodeId }, sessionId, 8_000);
        await sleep(400);
        const shown = await comboboxShowsValue(cdp, sessionId, selectors, wanted);
        if (shown?.ok) {
          console.log(`[choose] ${label}=${wanted} via LP option ${JSON.stringify(found.text)}`);
          return;
        }
      }
    } catch (error) {
      console.warn(`[choose] ${label} option LP: ${error.message}`);
    }
  }

  throw new Error(`could not select ${value} for ${label}`);
}

const SUBMIT_SELECTORS = [
  "button[type='submit']",
  "input[type='submit']",
  "#idSIButton9",
  "button[data-testid='primaryButton']",
  "button",
];
const NEXT_TEXTS = ["next", "submit", "tiếp theo", "continue"];

async function openSignup(cdp, sessionId, opts) {
  console.log(`Opening ${SIGNUP_URL}`);
  // Target may already be on signup (createTarget url). Wait first; only
  // navigate/reload if the Fluent form never mounts.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      console.warn(`[nav] signup form missing; reload attempt ${attempt}/3`);
      try {
        await cdp.send("Page.reload", { ignoreCache: true }, sessionId, opts.timeoutMs);
      } catch {
        await cdp.send("Page.navigate", { url: SIGNUP_URL }, sessionId, opts.timeoutMs).catch((error) => {
          console.warn(`[nav] navigate error: ${error.message}`);
        });
      }
      await sleep(1_200);
    } else {
      // If still about:blank / other origin, navigate once.
      const href = await evaluate(cdp, sessionId, "location.href").catch(() => "");
      if (!String(href).includes("signup.live.com")) {
        await cdp.send("Page.navigate", { url: SIGNUP_URL }, sessionId, opts.timeoutMs).catch((error) => {
          console.warn(`[nav] navigate error: ${error.message}`);
        });
        await sleep(1_200);
      }
    }
    const readyDeadline = Date.now() + Math.min(opts.timeoutMs, 25_000);
    while (Date.now() < readyDeadline) {
      const state = await pageState(cdp, sessionId).catch(() => null);
      if (state?.emailInput || state?.challenge) {
        console.log(`[nav] signup ready attempt=${attempt} emailInput=${!!state.emailInput} challenge=${!!state.challenge} title=${JSON.stringify(state.title)}`);
        return state;
      }
      await sleep(400);
    }
  }
  const state = await pageState(cdp, sessionId).catch(() => null);
  if (state) printState(state);
  throw new Error(`signup.live.com did not render email input after reloads${state?.bodyHead ? `; page: ${state.bodyHead}` : ""}`);
}

async function runRegistration(cdp, sessionId, account, opts) {
  const opened = await openSignup(cdp, sessionId, opts);
  if (opts.dryRun) {
    printState(opened || await pageState(cdp, sessionId));
    return { dryRun: true };
  }

  console.log(`[1/4] Email: ${account.email}`);
  // Fluent signup is multi-step:
  //   A) "Enter your email address" (type=email, often wants full someone@example.com)
  //   B) optional "New email" + "@outlook.com" domain suffix (local-part only)
  //   C) password
  const emailSelectors = [
    "input[type='email']",
    "input[name='email']",
    "input[name='MemberName']",
    "#usernameInput",
    "input[id^='floatingLabelInput']",
    "input[aria-label='Email' i]",
    "input[aria-label*='email' i]",
    "input[aria-label*='New email' i]",
  ];
  const emailLocal = String(account.email).split("@")[0];

  const inspectEmailUi = async () => evaluate(cdp, sessionId, `(() => {
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
    const newEmail = !!document.querySelector('input[aria-label*="New email" i]')
      || /enter your new email/i.test(text);
    const domainSuffix = /@outlook\\.com|@hotmail\\.com/i.test(text) && newEmail;
    const password = !!document.querySelector('input[type="password"], input[name="Password"], #passwordInput');
    const invalid = document.querySelector('input[aria-invalid="true"]');
    const alert = document.querySelector('[id*="validationMessage"], [role="alert"]');
    return {
      newEmail,
      domainSuffix,
      password,
      invalid: !!invalid,
      invalidValue: invalid?.value || null,
      alert: (alert?.innerText || '').trim().slice(0, 200),
      bodyHead: text.slice(0, 220),
    };
  })()`).catch(() => null);

  // Step A: primary email field — type full address (insertText may drop @domain;
  // fill falls back to keys; domain-suffix pages accept local-only).
  console.log(`[1/4] typing full email into primary field`);
  await fill(cdp, sessionId, emailSelectors, account.email, "email input", opts.timeoutMs);
  // If field refused domain (value left as local-part only), retry local on purpose.
  {
    const v = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
      const el = find(${JSON.stringify(emailSelectors)});
      return el?.value || null;
    })()`).catch(() => null);
    if (v && v === emailLocal) {
      console.log("[1/4] field kept local-part only; OK if domain is separate");
    } else if (v && !String(v).includes("@") && account.email.includes("@")) {
      console.warn(`[1/4] unexpected value without domain: ${v}`);
    }
  }
  console.log("[1/4] Email field filled; clicking Next");
  await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (email)", opts.timeoutMs, NEXT_TEXTS);
  // Do not press Enter here: form Enter → submitForm can block the CDP thread.
  console.log("[1/4] Next click dispatched");
  await sleep(1500);

  // Step B: "New email" + @outlook.com (common after CheckAvailableSigninNames).
  {
    const uiDeadline = Date.now() + Math.min(opts.timeoutMs, 30_000);
    let retriedFull = false;
    let newEmailAttempts = 0;
    while (Date.now() < uiDeadline) {
      const state = await pageState(cdp, sessionId).catch(() => null);
      if (state?.challenge) {
        console.warn("[1/4] challenge/CAPTCHA after email Next");
        printState(state);
        break;
      }
      const ui = await inspectEmailUi();
      if (ui?.password) {
        console.log("[1/4] password field visible");
        break;
      }
      if (ui?.newEmail || ui?.domainSuffix) {
        newEmailAttempts += 1;
        if (newEmailAttempts > 3) {
          console.warn(`[1/4] still on new-email after ${newEmailAttempts} submits: ${JSON.stringify(ui)}`);
          const buttons = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('button,[role="button"],input[type="submit"]')]
            .map((b) => ({
              text: (b.innerText || b.value || '').trim().slice(0, 60),
              disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true'),
              type: b.getAttribute('type'),
              id: b.id,
            })).filter((b) => b.text))()`).catch(() => []);
          console.warn(`[1/4] buttons=${JSON.stringify(buttons)}`);
          break;
        }
        // New-email UI shows "@outlook.com" beside the field and keeps local-part
        // only. React state is already seeded from step-1 full insertText + the
        // first CheckAvailable. Re-fill here breaks Fluent (full email → custom
        // "someone@example.com" error; re-typing local resets controlled state
        // and often prevents the second CheckAvailable). Prefer the prefilled
        // value; only fill local-part when the field is empty.
        const cur = await evaluate(cdp, sessionId, `(() => { ${FINDER_SOURCE}
          const el = find(${JSON.stringify(emailSelectors)});
          return el ? { value: el.value || '', id: el.id, aria: el.getAttribute('aria-label') } : null;
        })()`).catch(() => null);
        const hasLocal = cur?.value && String(cur.value).replace(/@.*/, "") === emailLocal;
        if (!hasLocal) {
          console.log(`[1/4] New-email step (attempt ${newEmailAttempts}); field empty/mismatch → local-part fill`);
          await fill(cdp, sessionId, emailSelectors, emailLocal, "new email local-part", opts.timeoutMs);
        } else {
          console.log(`[1/4] New-email step (attempt ${newEmailAttempts}); keep prefilled value=${JSON.stringify(cur.value)}`);
        }
        // Single trusted activation — no requestSubmit / Enter / double click.
        await clickElement(cdp, sessionId, ["button[type='submit']", ...SUBMIT_SELECTORS], "Next (new email)", opts.timeoutMs, NEXT_TEXTS);
        console.log("[1/4] New-email Next dispatched");
        await sleep(3000);
        continue;
      }
      if ((ui?.invalid || ui?.alert) && !retriedFull) {
        console.warn(`[1/4] validation: ${JSON.stringify(ui)}`);
        retriedFull = true;
        await fill(cdp, sessionId, emailSelectors, account.email, "email input retry", opts.timeoutMs);
        await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (email retry)", opts.timeoutMs, NEXT_TEXTS);
        await pressEnter(cdp, sessionId);
        await sleep(800);
        continue;
      }
      await sleep(400);
    }
  }

  if (opts.probeEmailStep) {
    await waitFor(cdp, sessionId, "password input", ["input[name='Password']", "input[type='password']", "#passwordInput"], opts.timeoutMs);
    console.log("Email-step probe passed: Microsoft rendered the password step.");
    return { probe: true };
  }

  console.log("[2/4] Password");
  await fill(cdp, sessionId, ["input[name='Password']", "input[type='password']", "#passwordInput"], account.password, "password input", opts.timeoutMs);
  await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (password)", opts.timeoutMs, NEXT_TEXTS);

  console.log(`[3/4] Birth date: ${account.birthDay}/${account.birthMonth}/${account.birthYear}`);
  // Fluent "Add some details" (country + birth) after password animation.
  await waitFor(cdp, sessionId, "birth date step", [
    "#BirthMonthDropdown",
    "[name='BirthMonth']",
    "#countryDropdownId",
    "input[name='BirthYear']",
    "[data-testid='birthdateControls']",
  ], opts.timeoutMs);
  const country = await evaluate(cdp, sessionId, "!!document.querySelector('#countryDropdownId, [name=\"countryDropdownName\"]')");
  if (country) console.log("Using the country already selected by Microsoft from this session/proxy.");
  const monthSelectors = ["#BirthMonthDropdown", "button[name='BirthMonth']", "[name='BirthMonth']"];
  const daySelectors = ["#BirthDayDropdown", "button[name='BirthDay']", "[name='BirthDay']"];
  const yearSelectors = [
    "input[name='BirthYear']",
    "input[aria-label*='Birth year' i]",
    "input[aria-label*='year' i]",
    "#floatingLabelInput25",
    "#floatingLabelInput24",
    "input[type='number'][name='BirthYear']",
  ];
  await choose(cdp, sessionId, monthSelectors, account.birthMonth, "birth month", opts.timeoutMs);
  await choose(cdp, sessionId, daySelectors, account.birthDay, "birth day", opts.timeoutMs);
  await fill(cdp, sessionId, yearSelectors, String(account.birthYear), "birth year", opts.timeoutMs);

  // Confirm Fluent accepted values before Next (empty → validation "Enter your birthdate").
  {
    const snap = await evaluate(cdp, sessionId, `(() => {
      const m = document.querySelector('#BirthMonthDropdown');
      const d = document.querySelector('#BirthDayDropdown');
      const y = document.querySelector('input[name="BirthYear"]');
      const text = (el) => (el?.querySelector('[data-testid="truncatedSelectedText"]')?.textContent
        || el?.innerText || el?.value || "").replace(/\\s+/g, " ").trim();
      return {
        month: text(m), monthVal: m?.getAttribute("value") || m?.value || "",
        day: text(d), dayVal: d?.getAttribute("value") || d?.value || "",
        year: y?.value || "",
        alert: (document.querySelector('[id*="validationMessage"], [role="alert"]')?.innerText || "").trim().slice(0, 120),
      };
    })()`).catch(() => null);
    console.log(`[3/4] birth snap ${JSON.stringify(snap)}`);
    if (!snap?.month || !snap?.day || !snap?.year) {
      console.warn("[3/4] incomplete birth fields; retrying empty ones");
      if (!snap?.month) await choose(cdp, sessionId, monthSelectors, account.birthMonth, "birth month retry", opts.timeoutMs);
      if (!snap?.day) await choose(cdp, sessionId, daySelectors, account.birthDay, "birth day retry", opts.timeoutMs);
      if (!snap?.year) await fill(cdp, sessionId, yearSelectors, String(account.birthYear), "birth year retry", opts.timeoutMs);
    }
  }
  await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (birth date)", opts.timeoutMs, NEXT_TEXTS);
  await sleep(1500);

  // Still on birth page? (validation / animation) — retry once
  {
    const stillBirth = await evaluate(cdp, sessionId, `(() => {
      const t = (document.body?.innerText || "");
      return /add some details|birthdate|birth date/i.test(t)
        && !!document.querySelector('#BirthMonthDropdown, input[name="BirthYear"]')
        && !document.querySelector('#firstNameInput, input[name="firstNameInput"], input[autocomplete="given-name"]');
    })()`).catch(() => false);
    if (stillBirth) {
      console.warn("[3/4] still on birth step after Next; re-select + Next");
      await choose(cdp, sessionId, monthSelectors, account.birthMonth, "birth month re", opts.timeoutMs);
      await choose(cdp, sessionId, daySelectors, account.birthDay, "birth day re", opts.timeoutMs);
      await fill(cdp, sessionId, yearSelectors, String(account.birthYear), "birth year re", opts.timeoutMs);
      await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (birth date retry)", opts.timeoutMs, NEXT_TEXTS);
      await sleep(2000);
    }
  }

  console.log(`[4/4] Name: ${account.firstName} ${account.lastName}`);
  await fill(cdp, sessionId, ["#firstNameInput", "[name='firstNameInput']", "input[autocomplete='given-name']"], account.firstName, "first name", opts.timeoutMs);
  await fill(cdp, sessionId, ["#lastNameInput", "[name='lastNameInput']", "input[autocomplete='family-name']"], account.lastName, "last name", opts.timeoutMs);
  await clickElement(cdp, sessionId, SUBMIT_SELECTORS, "Next (name)", opts.timeoutMs, NEXT_TEXTS);
  console.log("[4/4] Name Next dispatched — waiting for next Fluent step…");

  // After name, Microsoft usually shows CAPTCHA / risk verify; sometimes phone,
  // consent, or leaves signup. Log the first stable post-name screen clearly.
  let postName = null;
  for (let index = 0; index < 80; index += 1) {
    await sleep(500);
    postName = await inspectPostNameStep(cdp, sessionId).catch(() => null);
    if (!postName) continue;
    // Skip transient same-page paint (still name form for a moment)
    if (postName.step === "name" && index < 4) continue;
    if (index === 0 || index === 2 || index === 5 || postName.step !== "pending") {
      console.log(`[after-name t=${(index + 1) * 500}ms] step=${postName.step}`);
      console.log(`  title=${JSON.stringify(postName.title)}`);
      console.log(`  href=${postName.href}`);
      console.log(`  path=${postName.path}`);
      console.log(`  h1=${JSON.stringify(postName.h1)}`);
      console.log(`  subtitle=${JSON.stringify(postName.subtitle)}`);
      console.log(`  bodyHead=${JSON.stringify(postName.bodyHead)}`);
      if (postName.inputs?.length) console.log(`  inputs=${JSON.stringify(postName.inputs)}`);
      if (postName.buttons?.length) console.log(`  buttons=${JSON.stringify(postName.buttons)}`);
      if (postName.iframes?.length) console.log(`  iframes=${JSON.stringify(postName.iframes)}`);
      if (postName.hints?.length) console.log(`  hints=${JSON.stringify(postName.hints)}`);
    }
    const state = await pageState(cdp, sessionId);
    if (state.success) {
      console.log(`[after-name] SUCCESS left signup → ${state.href}`);
      return { success: true, state, postName };
    }
    if (state.challenge || postName.step === "captcha") {
      console.log(`[after-name] next step = CAPTCHA / human verify (${postName.step})`);
      // hotmail-register.js: sleep(7000) then hold iframe 12s (we cap at 15s)
      console.log(`[after-name] settle 7s then hold iframe center ${CAPTCHA_HOLD_MS}ms (max ${CAPTCHA_HOLD_MAX_MS}ms)`);
      await sleep(7_000);
      const hold = await pressAndHoldCaptcha(cdp, sessionId, CAPTCHA_HOLD_MS);
      const afterHold = hold.state || await pageState(cdp, sessionId).catch(() => state);
      if (afterHold?.success || hold.success) {
        console.log("[after-name] CAPTCHA hold → success");
        return { success: true, state: afterHold, postName, captchaHold: hold };
      }
      // No 3‑minute handoff (Chrome waits redirect; we fail fast on hold/layout error)
      console.error(`[after-name] CAPTCHA ERROR: ${hold.error || "hold_failed"} (held ${hold.heldMs ?? 0}ms)`);
      return {
        success: false,
        challenge: true,
        captchaError: true,
        state: afterHold,
        postName,
        captchaHold: hold,
        error: hold.error || "captcha_hold_failed",
      };
    }
    if (postName.step !== "name" && postName.step !== "pending") {
      console.log(`[after-name] next step = ${postName.step} (not auto-filled; handoff if needed)`);
      return { challenge: true, state, postName, nextStep: postName.step };
    }
  }
  const finalState = await pageState(cdp, sessionId);
  postName = postName || await inspectPostNameStep(cdp, sessionId).catch(() => null);
  console.log(`[after-name] timeout; last step=${postName?.step || "unknown"}`);
  if (postName) {
    console.log(`  title=${JSON.stringify(postName.title)} h1=${JSON.stringify(postName.h1)}`);
    console.log(`  bodyHead=${JSON.stringify(postName.bodyHead)}`);
  }
  return { challenge: true, state: finalState, postName };
}

/**
 * Classify the Fluent screen after the name step for operator/debug logs.
 */
async function inspectPostNameStep(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    const href = location.href;
    const path = location.pathname || "";
    const title = document.title || "";
    const h1 = (document.querySelector('h1, [data-testid="title"]')?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);
    const subtitle = (document.querySelector('[data-testid="subtitle"]')?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    const inputs = [...document.querySelectorAll("input, select, textarea")].slice(0, 20).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute("type") || el.type || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      aria: (el.getAttribute("aria-label") || "").slice(0, 60),
      testid: el.getAttribute("data-testid") || "",
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .map((b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 12);
    const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
      src: (f.src || "").slice(0, 160),
      testid: f.getAttribute("data-testid") || "",
      title: (f.title || "").slice(0, 80),
      w: Math.round(f.getBoundingClientRect().width),
      h: Math.round(f.getBoundingClientRect().height),
    })).slice(0, 8);

    const hasName = !!document.querySelector('#firstNameInput, input[name="firstNameInput"], input[autocomplete="given-name"]');
    const hasBirth = !!document.querySelector('#BirthMonthDropdown, input[name="BirthYear"]');
    const hasPass = !!document.querySelector('input[type="password"]');
    const hasEmail = !!document.querySelector('input[type="email"]');
    const captchaIframe = !!document.querySelector('iframe[data-testid="humanCaptchaIframe"], iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[src*="challenge"]');
    const captchaText = /prove you.?re human|verify you are human|press and hold|captcha|i.?m not a robot/i.test(text) || /prove you.?re human/i.test(title + h1);
    const phone = /phone|sms|text message|mobile number|verification code|one-time code|otp/i.test(text + h1) || !!document.querySelector('input[type="tel"], input[name*="phone" i], input[autocomplete="tel"]');
    const consent = /privacy|terms|consent|stay signed in|keep me signed in|permissions/i.test(h1 + subtitle) && /accept|agree|next|yes/i.test(buttons.join(" "));
    const successHost = !/signup\\.live\\.com/i.test(location.hostname)
      && /(?:live|microsoft|outlook|account\\.microsoft)\\.com/i.test(location.hostname + href);
    const error = /something went wrong|try again|couldn.?t create|error/i.test(text.slice(0, 400));

    let step = "pending";
    const hints = [];
    if (successHost) { step = "success_redirect"; hints.push("left signup host"); }
    else if (captchaIframe || captchaText) { step = "captcha"; if (captchaIframe) hints.push("captcha iframe"); if (/press and hold/i.test(text)) hints.push("press-and-hold"); }
    else if (phone) { step = "phone_verify"; hints.push("phone/otp cues"); }
    else if (consent) { step = "consent"; }
    else if (hasName && !hasPass) { step = "name"; hints.push("still on name form"); }
    else if (hasBirth) { step = "birth"; }
    else if (hasPass) { step = "password"; }
    else if (hasEmail) { step = "email"; }
    else if (error) { step = "error"; }
    else if (h1 || subtitle) { step = "unknown_ui"; hints.push("has title but no known pattern"); }
    else { step = "pending"; }

    return {
      step,
      href,
      path,
      title,
      h1,
      subtitle,
      bodyHead: text.slice(0, 280),
      inputs,
      buttons,
      iframes,
      hints,
    };
  })()`);
}

async function manualHandoff(cdp, sessionId) {
  let state = await pageState(cdp, sessionId);
  printState(state);
  if (state.success) return true;
  if (!process.stdin.isTTY) {
    console.error("CAPTCHA/manual verification requires an interactive terminal; session will remain open for 3 minutes.");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      state = await pageState(cdp, sessionId);
      if (state.success) return true;
    }
    return false;
  }

  console.log("\nSession is held open. Type 'status' or 'elements'; CAPTCHA is not solved automatically.");
  const readline = createInterface({ input: process.stdin, output: process.stdout, prompt: "hotmail> " });
  readline.prompt();
  for await (const raw of readline) {
    const trimmed = raw.trim();
    const [command, ...parts] = trimmed.split(/\s+/);
    try {
      if (!command) {}
      else if (command === "help") usage();
      else if (command === "status") state = await pageState(cdp, sessionId);
      else if (command === "elements") {
        const elements = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('button, input, select, iframe, [role="button"], [role="option"]')]
          .map((element) => { const rect = element.getBoundingClientRect(); return { tag: element.tagName, id: element.id, name: element.getAttribute('name'), role: element.getAttribute('role'), text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 100), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; })
          .filter((item) => item.rect.width > 0 && item.rect.height > 0).slice(0, 80))()`);
        console.log(JSON.stringify(elements, null, 2));
      } else if (command === "click") {
        if (parts.length >= 2 && Number.isFinite(Number(parts[0])) && Number.isFinite(Number(parts[1]))) {
          await pointerClick(cdp, sessionId, Number(parts[0]), Number(parts[1]));
        } else {
          const selector = trimmed.slice(command.length).trim();
          if (!selector) throw new Error("usage: click <x> <y> or click <css selector>");
          await clickElement(cdp, sessionId, [selector], selector, 5_000);
        }
        await sleep(500);
        state = await pageState(cdp, sessionId);
      } else if (command === "key") {
        await cdp.send("Input.insertText", { text: trimmed.slice(command.length).trim() }, sessionId);
      } else if (command === "enter") await pressEnter(cdp, sessionId);
      else if (command === "eval") console.log(await evaluate(cdp, sessionId, trimmed.slice(command.length).trim()));
      else if (command === "continue") {
        state = await pageState(cdp, sessionId);
        if (!state.success) throw new Error("signup has not completed yet");
        readline.close();
        return true;
      } else if (command === "quit" || command === "exit") {
        readline.close();
        return false;
      } else console.log(`unknown command: ${command}`);
      if (state) printState(state);
    } catch (error) {
      console.error(error.message || error);
    }
    readline.prompt();
  }
  return false;
}

function recordSuccess(account, source) {
  const result = `${account.email}|${account.password}|${account.firstName}|${account.lastName}|${account.birthDay}/${account.birthMonth}/${account.birthYear}\n`;
  appendFileSync(SUCCESS_FILE, result, { mode: 0o600 });
  chmodSync(SUCCESS_FILE, 0o600);
  if (source) {
    source.meta.hotmail = account.email;
    source.meta.password = account.password;
    writeFileSync(source.metaPath, `${JSON.stringify(source.meta, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(`Registered successfully: ${account.email}`);
  console.log(`Credentials saved to ${SUCCESS_FILE}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  if (!opts.endpoint && !existsSync(VELORA)) throw new Error(`missing binary: ${VELORA}; run zig build first`);
  const source = loadSourceProfile(opts);
  const account = randomAccount(opts);
  const port = opts.port || (opts.endpoint ? null : await freePort());
  const endpoint = opts.endpoint || `http://127.0.0.1:${port}`;
  let child = null;
  if (!opts.endpoint) {
    const args = [
      "serve", "--host", "127.0.0.1", "--port", String(port),
      "--browser-profile", opts.profile,
      "--log-level", "warn",
    ];
    if (opts.proxy) args.push("--http-proxy", opts.proxy);
    child = spawn(VELORA, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  } else if (opts.proxy || source) {
    console.warn("--endpoint connects to an existing server; profile/proxy must already be configured on that Velora process.");
  }

  let ws = null;
  const stopChild = () => {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  try {
    const version = await waitForServer(endpoint);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((open, reject) => {
      ws.once("open", open);
      ws.once("error", reject);
    });
    const cdp = new Cdp(ws);
    if (opts.trace) {
      cdp.on("Runtime.exceptionThrown", ({ exceptionDetails = {} }) => {
        const exception = exceptionDetails.exception || {};
        console.error("[page:exception]", exception.description || exceptionDetails.text || "unknown");
      });
      cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
        console.error(`[page:console:${type}]`, args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      });
      cdp.on("Network.loadingFailed", ({ type, errorText, blockedReason }) => {
        console.error(`[page:loadingFailed] ${JSON.stringify({ type, errorText, blockedReason })}`);
      });
      cdp.on("Network.responseReceived", ({ type, response = {} }) => {
        if (type === "Fetch" || type === "XHR" || Number(response.status) >= 400) {
          console.error(`[page:response] ${JSON.stringify({ type, status: response.status, url: response.url })}`);
        }
      });
    }
    // Prefer opening signup URL directly — about:blank → navigate races Velora
    // realm drain (realm.scheduler_suppressed) and can yield a blank SPA shell.
    const { targetId } = await cdp.send("Target.createTarget", { url: SIGNUP_URL });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    if (opts.trace) await cdp.send("Network.enable", {}, sessionId);
    await sleep(500);
    if (opts.trace) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        globalThis.__veloraHotmailTrace = [];
        const record = (type, value) => globalThis.__veloraHotmailTrace.push({
          type,
          value: String(value?.stack || value?.message || value),
        });
        addEventListener('error', (event) => record('error', event.error || event.message));
        addEventListener('unhandledrejection', (event) => record('unhandledrejection', event.reason));
        const originalFetch = globalThis.fetch;
        if (typeof originalFetch === 'function') globalThis.fetch = function(...args) {
          record('fetch-call', args[0]?.url || args[0]);
          const promise = Reflect.apply(originalFetch, this, args);
          promise.then(
            (response) => record('fetch-resolved', (response?.status || '') + ' ' + (response?.url || '')),
            (error) => record('fetch-rejected', error),
          );
          return promise;
        };
        for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData']) {
          const original = globalThis.Response?.prototype?.[method];
          if (typeof original !== 'function') continue;
          globalThis.Response.prototype[method] = function(...args) {
            record('response-' + method + '-call', this.url || '');
            const promise = Reflect.apply(original, this, args);
            promise.then(
              () => record('response-' + method + '-resolved', this.url || ''),
              (error) => record('response-' + method + '-rejected', error),
            );
            return promise;
          };
        }
      })()` }, sessionId);
    }
    if (opts.mobile) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      }, sessionId).catch((error) => console.warn(`mobile viewport unavailable: ${error.message}`));
    }
    console.log(`Velora endpoint: ${endpoint}`);
    console.log(`Velora profile: ${opts.profile}`);
    if (source) console.log(`Source profile: ${opts.sourceProfile}`);
    const result = await runRegistration(cdp, sessionId, account, opts);
    if (result.dryRun || result.probe) return;
    if (result.postName) {
      console.log(`[summary] step after name: ${result.postName.step}${result.nextStep ? ` (nextStep=${result.nextStep})` : ""}`);
      console.log(`[summary] title=${JSON.stringify(result.postName.title)} h1=${JSON.stringify(result.postName.h1)}`);
      console.log(`[summary] body=${JSON.stringify(result.postName.bodyHead)}`);
    }
    if (result.captchaError) {
      process.exitCode = 3;
      console.error(`[FAIL] CAPTCHA press-and-hold failed within ${CAPTCHA_HOLD_MAX_MS}ms: ${result.error || "unknown"}`);
      if (result.captchaHold?.heldMs != null) {
        console.error(`[FAIL] heldMs=${result.captchaHold.heldMs} timedOut=${!!result.captchaHold.timedOut}`);
      }
      console.log("Registration was not recorded; no long manual wait after CAPTCHA timeout.");
      return;
    }
    // Only interactive handoff for non-CAPTCHA stalls (phone/consent/etc.).
    const success = result.success || await manualHandoff(cdp, sessionId);
    if (!success) {
      process.exitCode = 2;
      console.log("Registration was not recorded; Velora profile state will still be persisted.");
      return;
    }
    recordSuccess(account, source);
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    stopChild();
    if (child) await Promise.race([new Promise((done) => child.once("exit", done)), sleep(3_000)]);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
