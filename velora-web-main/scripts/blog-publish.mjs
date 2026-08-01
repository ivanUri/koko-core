#!/usr/bin/env node
import {
  KNOWLEDGE_ROOT,
  listKnowledgeArticles,
  loadManifest,
  publishArticles,
  syncPosts,
  isPublished,
} from "./lib/knowledge-blog.mjs";

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
Velora blog — publish from knowledge/

Usage:
  npm run blog:publish -- <knowledge-path.md> [more...]
  npm run blog:publish -- --list
  npm run blog:publish -- --publish-all

Examples:
  npm run blog:publish -- bugs/2026-06-29-google-search-nid-trust-tier.md
  npm run blog:publish -- captcha/detection/google-search-investigation-journey.md

Knowledge root: ${KNOWLEDGE_ROOT}
`);
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--list")) {
  const manifest = loadManifest();
  const all = listKnowledgeArticles();
  const unpublished = all.filter((p) => !isPublished(manifest, p));
  const published = all.filter((p) => isPublished(manifest, p));

  console.log(`Published (${published.length}):`);
  for (const p of published) console.log(`  ✓ ${p}`);
  console.log(`\nUnpublished (${unpublished.length}):`);
  for (const p of unpublished) console.log(`  · ${p}`);
  process.exit(0);
}

let paths = args.filter((a) => !a.startsWith("--"));

if (args.includes("--publish-all")) {
  const manifest = loadManifest();
  paths = listKnowledgeArticles().filter((p) => !isPublished(manifest, p));
  if (paths.length === 0) {
    console.log("Nothing new to publish.");
    process.exit(0);
  }
  console.log(`Publishing ${paths.length} unpublished articles...`);
}

const { published, skipped, missing } = publishArticles(paths);

if (missing.length) {
  console.error("Missing files:");
  for (const p of missing) console.error(`  ✗ ${p}`);
}

if (skipped.length) {
  console.log("Already published (skipped):");
  for (const p of skipped) console.log(`  ↷ ${p}`);
}

if (published.length) {
  console.log("Newly published:");
  for (const p of published) console.log(`  ✓ ${p}`);
  const posts = syncPosts();
  console.log(`\nSynced ${posts.length} post(s) → content/posts.json`);
} else if (!missing.length) {
  console.log("No new articles published.");
}