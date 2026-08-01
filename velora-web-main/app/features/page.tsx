import {
  MarketingPage,
  PageHero,
  PageCta,
} from "@/components/layout/marketing-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { FeaturesSection } from "@/components/landing/features-section";
import { InfrastructureSection } from "@/components/landing/infrastructure-section";
import { SecuritySection } from "@/components/landing/security-section";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Features",
  description:
    "Velora runtime features — programmable browser infrastructure for AI agents, automation, and embeddable web execution.",
  path: "/features",
  keywords: [
    "browser infrastructure",
    "headless runtime",
    "V8 browser engine",
    "automation-native browser",
    "AI agent browser",
  ],
});

export default function FeaturesPage() {
  return (
    <MarketingPage>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Features", path: "/features" },
        ])}
      />
      <PageHero
        eyebrow="// FEATURES"
        title={
          <>
            Browser infrastructure
            <br />
            for machine execution.
          </>
        }
        description="Velora treats the browser as programmable runtime — deterministic, embeddable, and automation-native. Built for AI agents, crawling, and scalable web interaction."
      />
      <FeaturesSection />
      <InfrastructureSection />
      <SecuritySection />
      <PageCta
        title="See how it fits together"
        description="From Zig build to CDP server to SDK automation — three steps to programmable browsing."
        primaryHref="/how-it-works"
        primaryLabel="How it works"
        secondaryHref="/docs"
        secondaryLabel="Read the docs"
      />
    </MarketingPage>
  );
}