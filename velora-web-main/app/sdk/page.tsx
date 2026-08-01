import Link from "next/link";
import {
  MarketingPage,
  PageHero,
  PageCta,
} from "@/components/layout/marketing-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { DevelopersSection } from "@/components/landing/developers-section";
import { DOC_CATEGORIES } from "@/lib/docs";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "SDK",
  description:
    "@velora/sdk — TypeScript browser automation over direct CDP transport, with agent-friendly extraction APIs.",
  path: "/sdk",
  keywords: [
    "@velora/sdk",
    "TypeScript browser SDK",
    "CDP client",
    "semanticTree",
    "browser automation API",
  ],
});

const sdkDocSlugs = [
  "quickstart",
  "sdk-quickstart",
  "agents-mcp",
  "cdp",
  "browser-connect",
  "page-locators",
  "agent-apis",
] as const;

const sdkDocs = DOC_CATEGORIES.flatMap((category) =>
  category.docs
    .filter((doc) => (sdkDocSlugs as readonly string[]).includes(doc.slug))
    .map((doc) => ({ ...doc, category: category.title }))
);

export default function SdkPage() {
  return (
    <MarketingPage>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "SDK", path: "/sdk" },
        ])}
      />
      <PageHero
        eyebrow="// SDK"
        title={
          <>
            Velora SDK,
            <br />
            automate in code.
          </>
        }
        description="Connect over CDP, automate pages, and extract agent-friendly state — Browser, Context, Page, Locator APIs plus Velora-only helpers like markdown() and semanticTree()."
      />
      <DevelopersSection />
      <section className="py-16 border-t border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="mb-8 max-w-2xl">
            <p className="text-sm font-mono text-primary mb-2">// DOCUMENTATION</p>
            <h2 className="text-2xl lg:text-3xl font-semibold tracking-tight mb-3">
              SDK guides and reference
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Start with quickstart, then explore MCP agent tools and the full API surface.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {sdkDocs.map((doc) => (
              <Link
                key={doc.slug}
                href={`/docs/${doc.slug}`}
                className="group p-5 rounded-xl border border-border bg-card hover:border-primary/50 hover:bg-secondary/30 transition-all"
              >
                <p className="text-xs font-mono text-muted-foreground mb-2 uppercase tracking-wide">
                  {doc.category}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium group-hover:text-primary transition-colors">
                    {doc.title}
                  </span>
                  <span className="text-muted-foreground group-hover:text-primary transition-colors">
                    →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <PageCta
        title="Install and connect in minutes"
        description="npm install @velora/sdk — launch or connect to a Velora CDP server and run your first automation script."
        primaryHref="/docs/quickstart"
        primaryLabel="Quickstart"
        secondaryHref="/docs/sdk-quickstart"
        secondaryLabel="SDK reference"
      />
    </MarketingPage>
  );
}