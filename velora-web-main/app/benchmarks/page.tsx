import Link from "next/link";
import {
  MarketingPage,
  PageHero,
  PageCta,
} from "@/components/layout/marketing-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { MetricsSection } from "@/components/landing/metrics-section";
import { InfoCard } from "@/components/layout/site-page";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Benchmarks",
  description:
    "Velora microbench results on local static fixtures — navigation geomean, cold start, and per-page comparisons vs Chromium.",
  path: "/benchmarks",
  keywords: [
    "browser benchmarks",
    "headless browser performance",
    "microbench",
    "Chromium comparison",
    "navigation latency",
  ],
});

const methodology = [
  {
    title: "Fixture set",
    body: "Four local HTML pages: dom-heavy, js-compute, minimal, and mixed. Static files only — no live network variance.",
  },
  {
    title: "Comparison",
    body: "Velora headless runtime vs Playwright-driven Chromium on the same machine, three repeats per page, mean reported.",
  },
  {
    title: "Navigation metric",
    body: "Time from navigation request to load event — the primary signal for automation cold-path performance.",
  },
  {
    title: "Reproducibility",
    body: "Run zig build microbench in the Velora repo. Full methodology and raw tables live in knowledge/ and the dev blog.",
  },
];

export default function BenchmarksPage() {
  return (
    <MarketingPage>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Benchmarks", path: "/benchmarks" },
        ])}
      />
      <PageHero
        eyebrow="// BENCHMARKS"
        title={
          <>
            Measured on
            <br />
            local fixtures.
          </>
        }
        description="Honest numbers from the Velora microbench suite — not marketing claims. Results reflect active development on main; re-run benchmarks after major lifecycle changes."
      />
      <MetricsSection />
      <section className="py-16 border-t border-border bg-muted/20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="mb-10 max-w-2xl">
            <p className="text-sm font-mono text-primary mb-2">// METHODOLOGY</p>
            <h2 className="text-2xl lg:text-3xl font-semibold tracking-tight mb-3">
              How these numbers are produced
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Benchmarks are probe-driven engineering artifacts. Treat them as directional signals
              for automation infrastructure — not a guarantee for every production workload.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {methodology.map((item) => (
              <InfoCard key={item.title} title={item.title}>
                <p>{item.body}</p>
              </InfoCard>
            ))}
          </div>
          <p className="mt-8 text-sm text-muted-foreground">
            Deep dive:{" "}
            <Link href="/blog/2026-06-29-microbench-baseline" className="text-primary hover:underline">
              microbench baseline write-up
            </Link>{" "}
            on the engineering blog.
          </p>
        </div>
      </section>
      <PageCta
        title="Want the raw tables?"
        description="Clone the Velora repository and run the microbench target locally. Compare against your own fixtures and hardware."
        primaryHref="https://github.com/ivanUri/velora"
        primaryLabel="View repository"
        primaryExternal
        secondaryHref="/blog"
        secondaryLabel="Read dev stories"
      />
    </MarketingPage>
  );
}