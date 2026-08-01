import { ArrowRight, Calendar } from "lucide-react";
import Link from "next/link";
import type { BlogPost } from "@/lib/blog-posts";
import { getCategoryForPost } from "@/lib/blog-categories";

type BlogPostCardProps = {
  post: BlogPost;
  showSource?: boolean;
};

export function BlogPostCard({ post, showSource = true }: BlogPostCardProps) {
  const category = getCategoryForPost(post);

  return (
    <article className="group rounded-lg border border-border bg-card p-6 hover:border-primary/50 transition-all hover:shadow-lg flex flex-col h-full">
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <Link
          href={`/blog/category/${category.slug}`}
          className="text-xs font-mono uppercase tracking-wider px-2 py-1 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
        >
          {category.name}
        </Link>
        {showSource ? (
          <span
            className="text-xs text-muted-foreground font-mono truncate max-w-[160px]"
            title={post.sourcePath}
          >
            {post.sourcePath}
          </span>
        ) : null}
      </div>

      <Link href={`/blog/${post.slug}`} className="flex flex-col flex-1">
        <h3 className="text-lg font-semibold mb-3 group-hover:text-primary transition-colors line-clamp-2">
          {post.title}
        </h3>

        <p className="text-sm text-muted-foreground mb-4 line-clamp-3 flex-1">{post.excerpt}</p>

        <div className="flex items-center justify-between text-xs text-muted-foreground mb-4 pb-4 border-t border-border">
          <div className="flex items-center gap-1 mt-4">
            <Calendar className="w-3 h-3" />
            {post.date}
          </div>
          <span>{post.readTime}</span>
        </div>

        <div className="flex items-center gap-2 text-primary font-medium">
          Read story
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </div>
      </Link>
    </article>
  );
}