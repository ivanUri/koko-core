import { DOC_PAGES, type DocPage } from "./docs-content";

export type DocEntry = { title: string; slug: string };

export type DocCategory = {
  id: number;
  title: string;
  docs: DocEntry[];
};

export const DOC_CATEGORIES: DocCategory[] = [
  {
    id: 1,
    title: "Getting Started",
    docs: [
      { title: "Quick start", slug: "quickstart" },
      { title: "SDK quickstart", slug: "sdk-quickstart" },
      { title: "Agents & MCP", slug: "agents-mcp" },
      { title: "velora-fetch CLI", slug: "velora-fetch" },
    ],
  },
  {
    id: 2,
    title: "Core Concepts",
    docs: [
      { title: "Why not Chromium?", slug: "why-not-chromium" },
      { title: "Architecture layers", slug: "architecture" },
      { title: "Lifecycle correctness", slug: "lifecycle" },
      { title: "Multi-session runtime", slug: "multi-session" },
    ],
  },
  {
    id: 3,
    title: "Protocols",
    docs: [
      { title: "CDP server", slug: "cdp" },
      { title: "Run CDP server", slug: "serve" },
      { title: "MCP tools", slug: "mcp" },
      { title: "LP CDP domain", slug: "lp-domain" },
      { title: "Profiles & fingerprints", slug: "profiles" },
    ],
  },
  {
    id: 4,
    title: "SDK Reference",
    docs: [
      { title: "Browser.connect()", slug: "browser-connect" },
      { title: "Page & Locators", slug: "page-locators" },
      { title: "Agent extraction APIs", slug: "agent-apis" },
      { title: "Playwright migration", slug: "playwright-migration" },
    ],
  },
  {
    id: 5,
    title: "Benchmarks",
    docs: [
      { title: "Microbench (local fixtures)", slug: "microbench" },
      { title: "Wikipedia crawl", slug: "crawl-wikipedia" },
      { title: "Reproduce locally", slug: "reproduce" },
      { title: "Methodology & limitations", slug: "methodology" },
    ],
  },
  {
    id: 6,
    title: "Development",
    docs: [
      { title: "Requirements (Zig, V8)", slug: "requirements" },
      { title: "Build from source", slug: "build" },
      { title: "code-check tests", slug: "code-check" },
      { title: "CDP probes", slug: "cdp-probes" },
      { title: "Contributing", slug: "contributing" },
    ],
  },
];

const slugOrder = DOC_CATEGORIES.flatMap((c) => c.docs.map((d) => d.slug));

export function getDocBySlug(slug: string): DocPage | undefined {
  return DOC_PAGES[slug];
}

export function getAllDocSlugs(): string[] {
  return slugOrder;
}

export function getCategoryForDoc(slug: string): DocCategory | undefined {
  return DOC_CATEGORIES.find((c) => c.docs.some((d) => d.slug === slug));
}

export function getAdjacentDocs(slug: string): {
  prev?: DocPage;
  next?: DocPage;
} {
  const idx = slugOrder.indexOf(slug);
  if (idx === -1) return {};
  return {
    prev: idx > 0 ? DOC_PAGES[slugOrder[idx - 1]] : undefined,
    next: idx < slugOrder.length - 1 ? DOC_PAGES[slugOrder[idx + 1]] : undefined,
  };
}

export type { DocPage };