import type { Page } from "./page.js";
import type { GotoWaitOptions } from "./waiter.js";
import type { GoogleExtractResult, GoogleSearchOptions } from "./lp-types.js";
import { ProtocolError } from "../cdp/errors.js";

export const GOOGLE_TTFX_EXPR = `(() => {
  const h3 = document.querySelector("#search a h3, #rso a h3, a h3");
  if (h3?.innerText?.trim()) return h3.innerText.trim();
  const t = document.title || "";
  if (t.includes("Google Search") && !t.startsWith("http")) return t;
  if (t && !t.startsWith("http") && !t.includes("/sorry")) return t;
  return null;
})()`;

export function buildGoogleExtractExpression(limit = 5): string {
  return `(() => {
  const out = [];
  const seen = new Set();
  const roots = [...document.querySelectorAll("a h3")].map((h) => h.closest("a")).filter(Boolean);
  for (const a of roots) {
    const h3 = a.querySelector("h3");
    const title = h3?.innerText?.trim();
    let href = a.href || "";
    if (!title || !href) continue;
    if (href.includes("google.com/search") || href.includes("/sorry")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title, url: href });
    if (out.length >= ${limit}) break;
  }
  const html = document.documentElement.innerHTML;
  const blocked = /google\\.com\\/sorry|unusual traffic from your computer/i.test(html)
    || /accounts\\.google\\.com\\/v3\\/signin/i.test(location.href);
  return {
    title: document.title,
    resultCount: out.length,
    results: out,
    linkCount: out.length,
    htmlBytes: html.length,
    pathHint: {
      bodyLen: html.length,
      hasKnitsail: html.includes("knitsail"),
      hasSclm: /sclm=/.test(html),
      blocked,
      shortSerp: !blocked && html.length > 120000 && !html.includes("knitsail"),
    },
  };
})()`;
}

export function validateGoogleExtract(data: GoogleExtractResult): void {
  if (!data || typeof data !== "object") throw new ProtocolError("google search: invalid extract payload");
  if (data.pathHint?.blocked) throw new ProtocolError("google search: blocked (sorry/captcha/sign-in)");
  if (!data.resultCount || data.resultCount < 1) {
    throw new ProtocolError(`google search: no organic results (title=${data.title ?? "?"})`);
  }
}

export function buildGoogleSearchUrl(query: string, hl = "en"): string {
  const params = new URLSearchParams({ q: query, hl });
  return `https://www.google.com/search?${params}`;
}

export async function searchGoogle(page: Page, options: GoogleSearchOptions): Promise<GoogleExtractResult> {
  const limit = options.limit ?? 5;
  const timeout = options.timeout ?? 30_000;
  const waitUntil = options.waitUntil ?? "load";
  const url = buildGoogleSearchUrl(options.query, options.hl);

  await page.goto(url, { waitUntil, timeout });
  const data = await page.extract({
    ttfx: GOOGLE_TTFX_EXPR,
    expression: buildGoogleExtractExpression(limit),
    timeout,
  }) as unknown as GoogleExtractResult;
  validateGoogleExtract(data);
  return data;
}