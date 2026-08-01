'use client';

import { ArrowRight, Calendar } from 'lucide-react';
import Link from 'next/link';
import { blogPosts } from '@/lib/blog-posts';
import { getCategoryForPost } from '@/lib/blog-categories';

const featuredPosts = blogPosts.slice(0, 3);

export function FeaturedBlogSection() {
  return (
    <section id="blog" className="relative py-16 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <p className="text-sm font-mono text-primary mb-2">// DEV STORY</p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl sm:text-3xl lg:text-5xl font-semibold tracking-tight text-balance">
                Notes from the knowledge folder.
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-xl">
                Real debugging stories — right or wrong at the time. Each published once from{' '}
                <code className="font-mono text-primary">knowledge/</code>.
              </p>
            </div>
            <Link
              href="/blog"
              className="group flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-secondary/50 transition-colors shrink-0 self-start sm:self-auto"
            >
              View all
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>
        </div>

        {featuredPosts.length === 0 ? (
          <p className="text-muted-foreground text-sm font-mono">
            No stories published yet — run <span className="text-primary">npm run blog:publish</span> in velora-blog.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featuredPosts.map((post) => {
              const category = getCategoryForPost(post);
              return (
                <article
                  key={post.id}
                  className="group rounded-lg border border-border bg-card p-6 hover:border-primary/50 transition-all hover:shadow-lg"
                >
                  <div className="mb-3">
                    <Link
                      href={`/blog/category/${category.slug}`}
                      className="text-xs font-mono uppercase tracking-wider px-2 py-1 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
                    >
                      {category.name}
                    </Link>
                  </div>

                  <Link href={`/blog/${post.slug}`}>
                    <h3 className="text-lg font-semibold mb-3 group-hover:text-primary transition-colors line-clamp-2">
                      {post.title}
                    </h3>

                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">{post.excerpt}</p>

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
            })}
          </div>
        )}
      </div>
    </section>
  );
}