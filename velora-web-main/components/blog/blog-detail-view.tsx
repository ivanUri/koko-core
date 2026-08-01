import { ArrowLeft, Calendar, User, Clock, FileText } from "lucide-react";
import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { DevStoryBanner } from "@/components/blog/dev-story-banner";
import type { BlogPost } from "@/lib/blog-posts";
import { getCategoryForPost } from "@/lib/blog-categories";

type BlogDetailViewProps = {
  post: BlogPost;
  relatedPosts: BlogPost[];
};

export function BlogDetailView({ post, relatedPosts }: BlogDetailViewProps) {
  const category = getCategoryForPost(post);

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      <Navigation />

      <section className="py-8 border-b border-border bg-muted/30">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to dev stories
          </Link>

          <div className="mb-4 flex flex-wrap gap-2">
            <Link
              href={`/blog/category/${category.slug}`}
              className="text-xs font-mono uppercase tracking-wider px-3 py-1 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
            >
              {category.name}
            </Link>
            <span
              className="text-xs font-mono px-3 py-1 border border-border text-muted-foreground rounded inline-flex items-center gap-1 max-w-full min-w-0"
              title={post.sourcePath}
            >
              <FileText className="w-3 h-3 shrink-0" />
              <span className="truncate">{post.sourcePath}</span>
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-6 text-balance">
            {post.title}
          </h1>

          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4" />
              {post.author}
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              {post.date}
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              {post.readTime}
            </div>
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 min-w-0">
          <DevStoryBanner compact />

          <article
            className="prose prose-invert max-w-none blog-content"
            dangerouslySetInnerHTML={{ __html: post.content }}
          />

          <div className="mt-12 p-6 border border-border rounded-lg bg-secondary/30">
            <h3 className="text-lg font-semibold mb-2">Source</h3>
            <p className="text-sm text-muted-foreground font-mono mb-2 break-all">
              knowledge/{post.sourcePath}
            </p>
            <p className="text-sm text-muted-foreground">
              Snapshot published{" "}
              {new Date(post.publishedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}.
              The canonical note may evolve in the repo; this page stays as the story we shipped
              that day.
            </p>
          </div>

          {relatedPosts.length > 0 && (
            <div className="mt-12 pt-12 border-t border-border">
              <h3 className="text-2xl font-semibold mb-6">Related stories</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {relatedPosts.map((related) => (
                  <Link
                    key={related.slug}
                    href={`/blog/${related.slug}`}
                    className="group rounded-lg border border-border bg-card p-6 hover:border-primary/50 transition-all hover:shadow-lg"
                  >
                    <span className="text-xs font-mono uppercase tracking-wider px-2 py-1 bg-primary/10 text-primary rounded">
                      {related.category}
                    </span>
                    <h4 className="text-base font-semibold mt-3 mb-2 group-hover:text-primary transition-colors line-clamp-2">
                      {related.title}
                    </h4>
                    <p className="text-xs text-muted-foreground line-clamp-2">{related.excerpt}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <FooterSection />
    </div>
  );
}