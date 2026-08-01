import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

type MarketingPageProps = {
  children: React.ReactNode;
};

export function MarketingPage({ children }: MarketingPageProps) {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-background">
      <Navigation />
      {children}
      <FooterSection />
    </main>
  );
}

type PageHeroProps = {
  eyebrow: string;
  title: React.ReactNode;
  description: string;
};

export function PageHero({ eyebrow, title, description }: PageHeroProps) {
  return (
    <section className="py-10 sm:py-12 lg:py-16 border-b border-border bg-muted/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm font-mono text-primary mb-2">{eyebrow}</p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
            {title}
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
    </section>
  );
}

type PageCtaProps = {
  title: string;
  description: string;
  primaryHref: string;
  primaryLabel: string;
  primaryExternal?: boolean;
  secondaryHref?: string;
  secondaryLabel?: string;
  secondaryExternal?: boolean;
};

function CtaButton({
  href,
  label,
  external,
  variant = "primary",
}: {
  href: string;
  label: string;
  external?: boolean;
  variant?: "primary" | "outline";
}) {
  const className =
    variant === "primary"
      ? "bg-foreground hover:bg-foreground/90 text-background"
      : undefined;

  if (external || href.startsWith("http")) {
    return (
      <Button className={className} variant={variant === "outline" ? "outline" : "default"} asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {label}
          {variant === "primary" ? <ArrowRight className="w-4 h-4 ml-2" /> : null}
        </a>
      </Button>
    );
  }

  return (
    <Button className={className} variant={variant === "outline" ? "outline" : "default"} asChild>
      <Link href={href}>
        {label}
        {variant === "primary" ? <ArrowRight className="w-4 h-4 ml-2" /> : null}
      </Link>
    </Button>
  );
}

export function PageCta({
  title,
  description,
  primaryHref,
  primaryLabel,
  primaryExternal,
  secondaryHref,
  secondaryLabel,
  secondaryExternal,
}: PageCtaProps) {
  return (
    <section className="py-16 border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-8 lg:p-12 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="max-w-xl">
            <h2 className="text-2xl lg:text-3xl font-semibold tracking-tight mb-3">{title}</h2>
            <p className="text-muted-foreground leading-relaxed">{description}</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 shrink-0">
            <CtaButton href={primaryHref} label={primaryLabel} external={primaryExternal} />
            {secondaryHref && secondaryLabel ? (
              <CtaButton
                href={secondaryHref}
                label={secondaryLabel}
                external={secondaryExternal}
                variant="outline"
              />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}