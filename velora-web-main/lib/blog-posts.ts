import postsData from "@/content/posts.json";

export type BlogPost = {
  id: string;
  slug: string;
  sourcePath: string;
  publishedAt: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  category: string;
  categorySlug?: string;
  readTime: string;
  wordCount: number;
  content: string;
};

export const blogPosts: BlogPost[] = postsData.posts as BlogPost[];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find((p) => p.slug === slug);
}

export function getRelatedPosts(post: BlogPost, limit = 3): BlogPost[] {
  return blogPosts
    .filter((p) => p.category === post.category && p.slug !== post.slug)
    .slice(0, limit);
}