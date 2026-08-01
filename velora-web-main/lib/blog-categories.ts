import categoriesData from "@/content/categories.json";
import { blogPosts, type BlogPost } from "@/lib/blog-posts";

export type BlogCategory = {
  slug: string;
  name: string;
  knowledgeFolder: string;
  description: string;
};

export const blogCategories: BlogCategory[] = categoriesData as BlogCategory[];

const folderToCategory = new Map(
  blogCategories.map((c) => [c.knowledgeFolder, c])
);

const nameToCategory = new Map(blogCategories.map((c) => [c.name, c]));

export function categoryFromKnowledgePath(sourcePath: string): BlogCategory {
  const folder = sourcePath.split("/")[0];
  return folderToCategory.get(folder) ?? blogCategories.find((c) => c.slug === "dev-story")!;
}

export function getCategoryBySlug(slug: string): BlogCategory | undefined {
  return blogCategories.find((c) => c.slug === slug);
}

export function getCategoryForPost(post: BlogPost): BlogCategory {
  if (post.categorySlug) {
    const bySlug = getCategoryBySlug(post.categorySlug);
    if (bySlug) return bySlug;
  }
  const byName = nameToCategory.get(post.category);
  if (byName) return byName;
  return categoryFromKnowledgePath(post.sourcePath);
}

export function getPostsByCategorySlug(slug: string): BlogPost[] {
  const category = getCategoryBySlug(slug);
  if (!category) return [];
  return blogPosts.filter((post) => getCategoryForPost(post).slug === category.slug);
}

export type CategoryWithCount = BlogCategory & { count: number };

export function getCategoriesWithCounts(): CategoryWithCount[] {
  const counts = new Map<string, number>();
  for (const post of blogPosts) {
    const slug = getCategoryForPost(post).slug;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }

  return blogCategories
    .map((category) => ({
      ...category,
      count: counts.get(category.slug) ?? 0,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function getAllCategorySlugs(): string[] {
  return blogCategories.map((c) => c.slug);
}