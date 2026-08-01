import Link from "next/link";
import { getCategoriesWithCounts } from "@/lib/blog-categories";

type CategoryNavProps = {
  activeSlug?: string | null;
  showAll?: boolean;
  title?: string;
};

export function CategoryNav({
  activeSlug = null,
  showAll = true,
  title = "Categories",
}: CategoryNavProps) {
  const categories = getCategoriesWithCounts();

  if (categories.length === 0) return null;

  return (
    <div className="mb-8">
      {title ? (
        <h2 className="text-sm font-medium text-muted-foreground mb-3">{title}</h2>
      ) : null}
      <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto scrollbar-none max-w-[100vw]">
        <div className="flex flex-nowrap gap-2 pb-1 min-w-min">
          {showAll ? (
            <Link
              href="/blog"
              className={`shrink-0 px-3 py-1.5 rounded-full transition-colors text-xs font-medium ${
                !activeSlug
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
              }`}
            >
              All
            </Link>
          ) : null}
          {categories.map((category) => (
            <Link
              key={category.slug}
              href={`/blog/category/${category.slug}`}
              className={`shrink-0 px-3 py-1.5 rounded-full transition-colors text-xs font-medium whitespace-nowrap ${
                activeSlug === category.slug
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:border-primary hover:text-primary"
              }`}
            >
              {category.name}
              <span className="ml-1 opacity-60 tabular-nums">{category.count}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}