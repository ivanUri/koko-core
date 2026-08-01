import type { MetadataRoute } from "next";
import { blogPosts } from "@/lib/blog-posts";
import { getAllCategorySlugs } from "@/lib/blog-categories";
import { getAllDocSlugs } from "@/lib/docs";
import { getSiteUrl } from "@/lib/seo";

const STATIC_ROUTES: Array<{
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
}> = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/features", changeFrequency: "monthly", priority: 0.9 },
  { path: "/how-it-works", changeFrequency: "monthly", priority: 0.9 },
  { path: "/benchmarks", changeFrequency: "weekly", priority: 0.85 },
  { path: "/sdk", changeFrequency: "monthly", priority: 0.9 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.95 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.9 },
  { path: "/status", changeFrequency: "monthly", priority: 0.5 },
  { path: "/security", changeFrequency: "yearly", priority: 0.4 },
  { path: "/license", changeFrequency: "yearly", priority: 0.4 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl();
  const now = new Date();

  const staticEntries = STATIC_ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${base}${path === "/" ? "" : path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));

  const docEntries = getAllDocSlugs().map((slug) => ({
    url: `${base}/docs/${slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const blogEntries = blogPosts.map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: new Date(post.publishedAt),
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  const categoryEntries = getAllCategorySlugs().map((slug) => ({
    url: `${base}/blog/category/${slug}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.65,
  }));

  return [...staticEntries, ...docEntries, ...blogEntries, ...categoryEntries];
}