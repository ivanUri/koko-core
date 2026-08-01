import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { DevStoryBanner } from "@/components/blog/dev-story-banner";
import { CategoryNav } from "@/components/blog/category-nav";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { JsonLdScript } from "@/components/seo/json-ld";
import {
  getAllCategorySlugs,
  getCategoryBySlug,
  getPostsByCategorySlug,
} from "@/lib/blog-categories";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return getAllCategorySlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = getCategoryBySlug(slug);

  if (!category) {
    return createMetadata({
      title: "Category not found",
      description: "No Velora blog category for this URL.",
      path: `/blog/category/${slug}`,
      noIndex: true,
    });
  }

  return createMetadata({
    title: `${category.name} — Engineering notes`,
    description: category.description,
    path: `/blog/category/${slug}`,
    keywords: [category.name, "Velora dev stories", category.knowledgeFolder],
  });
}

export default async function BlogCategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const category = getCategoryBySlug(slug);

  if (!category) {
    return (
      <div className="min-h-screen bg-background overflow-x-hidden">
        <Navigation />
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24 text-center">
          <h1 className="text-3xl font-bold mb-4">Category not found</h1>
          <Link href="/blog" className="text-primary hover:underline">
            Back to all stories
          </Link>
        </div>
        <FooterSection />
      </div>
    );
  }

  const posts = getPostsByCategorySlug(slug);

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: category.name, path: `/blog/category/${category.slug}` },
        ])}
      />
      <Navigation />

      <section className="py-12 border-b border-border bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            All stories
          </Link>
          <div className="max-w-3xl">
            <p className="text-sm font-mono text-primary mb-2">
              // CATEGORY · knowledge/{category.knowledgeFolder}/
            </p>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-4">
              {category.name}
            </h1>
            <p className="text-base text-muted-foreground leading-relaxed">
              {category.description}
            </p>
            <p className="text-sm text-muted-foreground mt-4 font-mono">
              {posts.length} published {posts.length === 1 ? "story" : "stories"}
            </p>
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <DevStoryBanner compact />

          <CategoryNav activeSlug={slug} title="Other categories" />

          {posts.length === 0 ? (
            <div className="text-center py-16 rounded-xl border border-dashed border-border">
              <p className="text-muted-foreground mb-4">
                No stories published in this category yet.
              </p>
              <p className="text-sm text-muted-foreground font-mono">
                npm run blog:publish -- {category.knowledgeFolder}/your-article.md
              </p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {posts.map((post) => (
                <BlogPostCard key={post.slug} post={post} />
              ))}
            </div>
          )}
        </div>
      </section>

      <FooterSection />
    </div>
  );
}