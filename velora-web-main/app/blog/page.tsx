'use client';

import { useState } from 'react';
import { Navigation } from '@/components/landing/navigation';
import { FooterSection } from '@/components/landing/footer-section';
import { DevStoryBanner } from '@/components/blog/dev-story-banner';
import { CategoryNav } from '@/components/blog/category-nav';
import { BlogPostCard } from '@/components/blog/blog-post-card';
import { blogPosts } from '@/lib/blog-posts';

export default function BlogPage() {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredPosts = blogPosts.filter(post => {
    return post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
           post.excerpt.toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      <Navigation />

      <section className="py-12 border-b border-border bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-mono text-primary mb-2">// DEV STORY</p>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-4">
              Velora engineering notes
            </h1>
            <p className="text-base text-muted-foreground">
              Pulled from <code className="font-mono text-sm text-primary">knowledge/</code> in the
              Velora repo — bugs chased, benchmarks run, assumptions overturned. Published once; never
              duplicated.
            </p>
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <DevStoryBanner />

          {blogPosts.length === 0 ? (
            <div className="text-center py-16 rounded-xl border border-dashed border-border">
              <p className="text-muted-foreground mb-4">No posts published yet.</p>
              <p className="text-sm text-muted-foreground font-mono">
                npm run blog:publish -- &lt;path-to-knowledge-article.md&gt;
              </p>
            </div>
          ) : (
            <>
              <CategoryNav title="Browse by category" />

              <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <h2 className="text-lg font-semibold">All stories</h2>
                <input
                  type="text"
                  placeholder="Search articles..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full sm:max-w-xs px-4 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>

              {filteredPosts.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-muted-foreground">No articles match your search.</p>
                </div>
              ) : (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredPosts.map(post => (
                    <BlogPostCard key={post.slug} post={post} />
                  ))}
                </div>
              )}


            </>
          )}
        </div>
      </section>

      <FooterSection />
    </div>
  );
}