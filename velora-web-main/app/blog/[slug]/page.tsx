import type { Metadata } from "next";
import { blogPosts, getPostBySlug, getRelatedPosts } from "@/lib/blog-posts";
import { getCategoryForPost } from "@/lib/blog-categories";
import { BlogDetailView } from "@/components/blog/blog-detail-view";
import { JsonLdScript } from "@/components/seo/json-ld";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { articleJsonLd, breadcrumbJsonLd, createMetadata } from "@/lib/seo";
import Link from "next/link";

export function generateStaticParams() {
  return blogPosts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    return createMetadata({
      title: "Story not found",
      description: "No published Velora engineering story for this URL.",
      path: `/blog/${slug}`,
      noIndex: true,
    });
  }

  const category = getCategoryForPost(post);

  return createMetadata({
    title: post.title,
    description: post.excerpt,
    path: `/blog/${post.slug}`,
    type: "article",
    publishedTime: post.publishedAt,
    modifiedTime: post.publishedAt,
    authors: [post.author],
    section: category.name,
    keywords: [post.category, "Velora engineering", "browser runtime", category.name],
  });
}

export default async function BlogDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24 text-center">
          <h1 className="text-3xl font-bold mb-4">Story not found</h1>
          <p className="text-muted-foreground mb-4">
            No published story for <code className="font-mono text-primary">{slug}</code>.
          </p>
          <p className="text-sm text-muted-foreground mb-8">
            Publish from knowledge:{" "}
            <code className="font-mono">npm run blog:publish -- &lt;path&gt;.md</code>
          </p>
          <Link href="/blog" className="text-primary hover:underline">
            Back to dev stories
          </Link>
        </div>
        <FooterSection />
      </div>
    );
  }

  const relatedPosts = getRelatedPosts(post);
  const category = getCategoryForPost(post);

  return (
    <>
      <JsonLdScript
        data={[
          articleJsonLd({
            title: post.title,
            description: post.excerpt,
            path: `/blog/${post.slug}`,
            publishedAt: post.publishedAt,
            author: post.author,
          }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Blog", path: "/blog" },
            { name: category.name, path: `/blog/category/${category.slug}` },
            { name: post.title, path: `/blog/${post.slug}` },
          ]),
        ]}
      />
      <BlogDetailView post={post} relatedPosts={relatedPosts} />
    </>
  );
}