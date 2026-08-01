"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { DOC_CATEGORIES, getCategoryForDoc } from "@/lib/docs";

type DocsSidebarProps = {
  activeSlug?: string;
};

export function DocsSidebar({ activeSlug }: DocsSidebarProps) {
  const pathname = usePathname();
  const slugFromPath = pathname.startsWith("/docs/")
    ? pathname.replace("/docs/", "")
    : undefined;
  const currentSlug = activeSlug ?? slugFromPath;

  const activeCategory = currentSlug ? getCategoryForDoc(currentSlug) : undefined;
  const defaultExpanded = activeCategory?.id ?? 1;

  const [expandedCategories, setExpandedCategories] = useState<number[]>([defaultExpanded]);

  const toggleCategory = (id: number) => {
    setExpandedCategories((prev) =>
      prev.includes(id) ? prev.filter((cat) => cat !== id) : [...prev, id]
    );
  };

  return (
    <nav className="space-y-1">
      {DOC_CATEGORIES.map((category) => {
        const isExpanded = expandedCategories.includes(category.id);
        const hasActiveDoc = category.docs.some((d) => d.slug === currentSlug);

        return (
          <div key={category.id}>
            <button
              type="button"
              onClick={() => toggleCategory(category.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-sm font-medium ${
                hasActiveDoc
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <span>{category.title}</span>
              <ChevronDown
                className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
              />
            </button>

            {isExpanded && (
              <div className="pl-4 mt-1 space-y-1 border-l border-border/50">
                {category.docs.map((doc) => {
                  const isActive = doc.slug === currentSlug;
                  return (
                    <Link
                      key={doc.slug}
                      href={`/docs/${doc.slug}`}
                      className={`block px-3 py-2 text-sm rounded-lg transition-colors ${
                        isActive
                          ? "text-primary bg-primary/10 font-medium"
                          : "text-muted-foreground hover:text-primary hover:bg-secondary/50"
                      }`}
                    >
                      {doc.title}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}