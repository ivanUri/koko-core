import {
  MarketingPage,
  PageHero,
  PageCta,
} from "@/components/layout/marketing-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { HowItWorksSection } from "@/components/landing/how-it-works-section";
import { IntegrationsSection } from "@/components/landing/integrations-section";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "How it works",
  description:
    "Build Velora with Zig, start the CDP server, and automate with the SDK — three steps to programmable browsing.",
  path: "/how-it-works",
  keywords: ["Zig build", "CDP server", "browser automation setup", "Velora quickstart"],
});

export default function HowItWorksPage() {
  return (
    <MarketingPage>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "How it works", path: "/how-it-works" },
        ])}
      />
      <PageHero
        eyebrow="// HOW IT WORKS"
        title={
          <>
            Three steps to
            <br />
            programmable browsing.
          </>
        }
        description="Compile the runtime, expose CDP on localhost, and connect with the Velora SDK or any CDP client. No Chromium monolith required for everyday automation."
      />
      <HowItWorksSection />
      <IntegrationsSection />
      <PageCta
        title="Ready to write your first script?"
        description="Install @velora/sdk, connect to a running CDP server, and automate pages with Playwright-style APIs plus agent extraction helpers."
        primaryHref="/sdk"
        primaryLabel="Explore the SDK"
        secondaryHref="/docs/quickstart"
        secondaryLabel="Quickstart guide"
      />
    </MarketingPage>
  );
}