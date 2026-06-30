import type { Page } from "./page.js";
import type { GoogleExtractResult, GoogleSearchOptions } from "./lp-types.js";
export declare const GOOGLE_TTFX_EXPR = "(() => {\n  const h3 = document.querySelector(\"#search a h3, #rso a h3, a h3\");\n  if (h3?.innerText?.trim()) return h3.innerText.trim();\n  const t = document.title || \"\";\n  if (t.includes(\"Google Search\") && !t.startsWith(\"http\")) return t;\n  if (t && !t.startsWith(\"http\") && !t.includes(\"/sorry\")) return t;\n  return null;\n})()";
export declare function buildGoogleExtractExpression(limit?: number): string;
export declare function validateGoogleExtract(data: GoogleExtractResult): void;
export declare function buildGoogleSearchUrl(query: string, hl?: string): string;
export declare function searchGoogle(page: Page, options: GoogleSearchOptions): Promise<GoogleExtractResult>;
