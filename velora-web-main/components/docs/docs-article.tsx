import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getAdjacentDocs, getCategoryForDoc } from "@/lib/docs";
import type { DocPage } from "@/lib/docs";

type DocsArticleProps = {
  doc: DocPage;
};

export function DocsArticle({ doc }: DocsArticleProps) {
  const category = getCategoryForDoc(doc.slug);
  const { prev, next } = getAdjacentDocs(doc.slug);

  return (
    <div className="max-w-3xl">
      {category ? (
        <p className="text-xs font-mono uppercase tracking-wider text-primary mb-4">
          {category.title}
        </p>
      ) : null}

      <article
        className="prose prose-invert max-w-none blog-content"
        dangerouslySetInnerHTML={{ __html: doc.content }}
      />

      <nav className="mt-12 pt-8 border-t border-border flex flex-col sm:flex-row gap-4 justify-between">
        {prev ? (
          <Link
            href={`/docs/${prev.slug}`}
            className="group flex items-center gap-2 p-4 border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/50 transition-all flex-1"
          >
            <ArrowLeft className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground mb-1">Previous</p>
              <p className="text-sm font-medium group-hover:text-primary transition-colors">
                {prev.title}
              </p>
            </div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}

        {next ? (
          <Link
            href={`/docs/${next.slug}`}
            className="group flex items-center justify-end gap-2 p-4 border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/50 transition-all flex-1 text-right"
          >
            <div>
              <p className="text-xs text-muted-foreground mb-1">Next</p>
              <p className="text-sm font-medium group-hover:text-primary transition-colors">
                {next.title}
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0" />
          </Link>
        ) : null}
      </nav>
    </div>
  );
}