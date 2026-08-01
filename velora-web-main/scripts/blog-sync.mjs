#!/usr/bin/env node
import { syncPosts, loadManifest, KNOWLEDGE_ROOT } from "./lib/knowledge-blog.mjs";

const manifest = loadManifest();
const posts = syncPosts();

console.log(
  `[blog-sync] ${posts.length} published post(s) from ${manifest.entries.length} manifest entries`
);
console.log(`[blog-sync] knowledge: ${KNOWLEDGE_ROOT}`);