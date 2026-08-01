import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";

type SitePageProps = {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
};

export function SitePage({ eyebrow, title, description, children }: SitePageProps) {
  return (
    <div className="min-h-screen bg-background flex flex-col overflow-x-hidden">
      <Navigation />

      <section className="py-12 border-b border-border bg-muted/30">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-sm font-mono text-primary mb-2">{eyebrow}</p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
            {title}
          </h1>
          {description ? (
            <p className="text-base text-muted-foreground leading-relaxed">{description}</p>
          ) : null}
        </div>
      </section>

      <main className="flex-1 py-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 min-w-0">{children}</div>
      </main>

      <FooterSection />
    </div>
  );
}

export function Prose({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6 text-muted-foreground leading-relaxed">{children}</div>;
}

export function ProseSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="space-y-3 text-muted-foreground leading-relaxed">{children}</div>
    </section>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-lg border border-border bg-card p-4 font-mono text-sm text-foreground overflow-x-auto">
      {children}
    </pre>
  );
}

export function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-5">
      <h3 className="font-semibold text-foreground mb-2">{title}</h3>
      <div className="text-sm text-muted-foreground space-y-2">{children}</div>
    </div>
  );
}