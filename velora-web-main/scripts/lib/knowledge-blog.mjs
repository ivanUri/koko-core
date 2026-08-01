import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BLOG_ROOT = path.resolve(__dirname, "../..");
export const KNOWLEDGE_ROOT =
  process.env.VELORA_KNOWLEDGE_PATH ||
  path.join(process.env.HOME || "", "Desktop/velora/knowledge");
export const MANIFEST_PATH = path.join(BLOG_ROOT, "content/published-manifest.json");
export const POSTS_PATH = path.join(BLOG_ROOT, "content/posts.json");
export const CATEGORIES_PATH = path.join(BLOG_ROOT, "content/categories.json");

const SKIP_NAMES = new Set(["README.md", "_template.md"]);

function loadCategories() {
  return JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf8"));
}

let categoriesCache = null;
function getCategories() {
  if (!categoriesCache) categoriesCache = loadCategories();
  return categoriesCache;
}

marked.setOptions({ gfm: true, breaks: false });

export function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { version: 1, entries: [] };
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function saveManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function slugFromSourcePath(relPath) {
  return path.basename(relPath, ".md");
}

export function listKnowledgeArticles() {
  if (!fs.existsSync(KNOWLEDGE_ROOT)) {
    throw new Error(`Knowledge folder not found: ${KNOWLEDGE_ROOT}`);
  }

  const results = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".md") || SKIP_NAMES.has(name)) continue;
      const rel = path.relative(KNOWLEDGE_ROOT, full).replace(/\\/g, "/");
      results.push(rel);
    }
  }

  walk(KNOWLEDGE_ROOT);
  return results.sort();
}

export function categoryFromPath(relPath) {
  return resolveCategory(relPath).name;
}

export function categorySlugFromPath(relPath) {
  return resolveCategory(relPath).slug;
}

function resolveCategory(relPath) {
  const top = relPath.split("/")[0];
  const categories = getCategories();
  const hit =
    categories.find((c) => c.knowledgeFolder === top) ??
    categories.find((c) => c.slug === "dev-story");
  return hit;
}

export function dateFromPath(relPath, fallback = new Date()) {
  const base = path.basename(relPath);
  const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return formatDate(new Date(`${m[1]}T12:00:00Z`));
  return formatDate(fallback);
}

function formatDate(d) {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseKnowledgeArticle(relPath) {
  const fullPath = path.join(KNOWLEDGE_ROOT, relPath);
  const raw = fs.readFileSync(fullPath, "utf8");

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(relPath, ".md");

  const summaryMatch = raw.match(/## Summary\s*\n+([\s\S]*?)(?=\n---|\n## )/);
  let excerpt = "";
  if (summaryMatch) {
    excerpt = stripMarkdown(summaryMatch[1]).slice(0, 300);
  } else {
    const para = raw
      .replace(/^#.*$/m, "")
      .split(/\n\n+/)
      .map(stripMarkdown)
      .find((p) => p.length > 40);
    excerpt = (para || title).slice(0, 300);
  }

  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const readTime = `${Math.max(3, Math.ceil(wordCount / 200))} min read`;

  return {
    slug: slugFromSourcePath(relPath),
    sourcePath: relPath,
    title,
    excerpt,
    author: "Velora dev",
    date: dateFromPath(relPath),
    category: categoryFromPath(relPath),
    categorySlug: categorySlugFromPath(relPath),
    readTime,
    wordCount,
    content: marked.parse(raw),
  };
}

export function isPublished(manifest, relPath) {
  return manifest.entries.some((e) => e.sourcePath === relPath);
}

export function publishArticles(relPaths, { force = false } = {}) {
  const manifest = loadManifest();
  const published = [];
  const skipped = [];
  const missing = [];

  for (const relPath of relPaths) {
    const normalized = relPath.replace(/\\/g, "/");
    const fullPath = path.join(KNOWLEDGE_ROOT, normalized);

    if (!fs.existsSync(fullPath)) {
      missing.push(normalized);
      continue;
    }

    if (isPublished(manifest, normalized) && !force) {
      skipped.push(normalized);
      continue;
    }

    if (!isPublished(manifest, normalized)) {
      manifest.entries.push({
        sourcePath: normalized,
        slug: slugFromSourcePath(normalized),
        publishedAt: new Date().toISOString(),
      });
    }

    published.push(normalized);
  }

  saveManifest(manifest);
  return { manifest, published, skipped, missing };
}

function loadCachedPosts() {
  if (!fs.existsSync(POSTS_PATH)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(POSTS_PATH, "utf8"));
    return new Map((data.posts || []).map((p) => [p.slug, p]));
  } catch {
    return new Map();
  }
}

export function syncPosts() {
  const manifest = loadManifest();
  const cached = loadCachedPosts();

  const posts = manifest.entries
    .map((entry) => {
      const fullPath = path.join(KNOWLEDGE_ROOT, entry.sourcePath);
      try {
        if (fs.existsSync(fullPath)) {
          const post = parseKnowledgeArticle(entry.sourcePath);
          return {
            id: entry.slug,
            slug: entry.slug,
            sourcePath: entry.sourcePath,
            publishedAt: entry.publishedAt,
            ...post,
          };
        }
        const hit = cached.get(entry.slug);
        if (hit) {
          console.warn(
            `[blog-sync] knowledge missing for ${entry.sourcePath} — using cached snapshot`
          );
          return hit;
        }
        throw new Error(`knowledge file not found and no cache for ${entry.slug}`);
      } catch (err) {
        console.warn(`[blog-sync] skip ${entry.sourcePath}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.mkdirSync(path.dirname(POSTS_PATH), { recursive: true });
  fs.writeFileSync(POSTS_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), posts }, null, 2)}\n`);
  return posts;
}