import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { DocsSidebar } from "@/components/docs/docs-sidebar";

type DocsLayoutProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  activeSlug?: string;
  children: React.ReactNode;
};

export function DocsLayout({
  eyebrow = "// DOCUMENTATION",
  title,
  description,
  activeSlug,
  children,
}: DocsLayoutProps) {
  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      <Navigation />

      <section className="py-10 sm:py-12 border-b border-border bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-mono text-primary mb-2">{eyebrow}</p>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
              {title}
            </h1>
            {description ? (
              <p className="text-base text-muted-foreground leading-relaxed">{description}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="py-10 sm:py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
            <aside className="lg:col-span-1 min-w-0">
              <details className="lg:hidden rounded-lg border border-border bg-card mb-6 group">
                <summary className="px-4 py-3 cursor-pointer text-sm font-semibold list-none flex items-center justify-between">
                  Browse documentation
                  <span className="text-muted-foreground text-xs group-open:rotate-180 transition-transform">
                    ▾
                  </span>
                </summary>
                <div className="p-4 border-t border-border max-h-[50vh] overflow-y-auto">
                  <DocsSidebar activeSlug={activeSlug} />
                </div>
              </details>

              <div className="hidden lg:block sticky top-24">
                <h3 className="text-sm font-semibold mb-4 uppercase tracking-wide">
                  Documentation
                </h3>
                <DocsSidebar activeSlug={activeSlug} />
              </div>
            </aside>

            <div className="lg:col-span-3 min-w-0">{children}</div>
          </div>
        </div>
      </section>

      <FooterSection />
    </div>
  );
}