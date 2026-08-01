import Link from "next/link";
import {
  SitePage,
  ProseSection,
  InfoCard,
} from "@/components/layout/site-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { SITE } from "@/lib/site";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Status",
  description: "Velora project status, development focus, and what is production-ready today.",
  path: "/status",
  keywords: ["Velora project status", "browser runtime roadmap", "development focus"],
});

const focusAreas = [
  {
    name: "Lifecycle correctness",
    status: "active",
    detail: "Navigation ordering, realm isolation, WindowProxy semantics, teardown.",
  },
  {
    name: "CDP consistency",
    status: "active",
    detail: "Protocol behavior aligned with automation client expectations.",
  },
  {
    name: "MCP integration",
    status: "active",
    detail: "Agent tools: goto, markdown, semantic_tree, links, evaluate.",
  },
  {
    name: "Multi-session runtime",
    status: "active",
    detail: "Embeddable infrastructure for crawling and orchestration.",
  },
  {
    name: "TypeScript SDK",
    status: "stable",
    detail: "Playwright-style API over direct CDP WebSocket transport.",
  },
  {
    name: "Desktop browser parity",
    status: "out of scope",
    detail: "Velora targets automation infrastructure, not a consumer browser.",
  },
];

const statusColor: Record<string, string> = {
  active: "bg-green-500",
  stable: "bg-primary",
  "out of scope": "bg-muted-foreground/50",
};

export default function StatusPage() {
  return (
    <>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Status", path: "/status" },
        ])}
      />
      <SitePage
      eyebrow="// STATUS"
      title="Project status"
      description="Velora is under active development. This page reflects where the runtime is today — honest scope, not a product launch checklist."
    >
      <div className="space-y-10">
        <ProseSection title="Current phase">
          <p>
            {SITE.name} is an AI-first headless browser runtime for automation, agents, and
            programmable web execution. The engine is real and benchmarked, but the project is
            still engineering-forward — expect API movement, probe-driven fixes, and frequent
            knowledge notes before anything is positioned as production SaaS.
          </p>
          <p>
            Primary focus today: automation reliability, lifecycle correctness, runtime
            architecture, and browser execution infrastructure for AI systems.
          </p>
        </ProseSection>

        <ProseSection title="Development focus">
          <div className="grid gap-3">
            {focusAreas.map((area) => (
              <div
                key={area.name}
                className="flex items-start gap-4 rounded-lg border border-border bg-card p-4"
              >
                <span
                  className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${statusColor[area.status]}`}
                />
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <h3 className="font-medium text-foreground">{area.name}</h3>
                    <span className="text-xs font-mono text-muted-foreground uppercase">
                      {area.status}
                    </span>
                  </div>
                  <p className="text-sm">{area.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </ProseSection>

        <ProseSection title="What you can try today">
          <ul className="list-disc pl-6 space-y-2">
            <li>Build with Zig and run the CDP server on localhost</li>
            <li>Connect via <code className="font-mono text-primary">@velora/sdk</code></li>
            <li>Run microbench and crawl benchmarks against Playwright Chromium</li>
            <li>Read dev stories on the <Link href="/blog" className="text-primary hover:underline">blog</Link></li>
          </ul>
        </ProseSection>

        <ProseSection title="What is not ready">
          <ul className="list-disc pl-6 space-y-2">
            <li>Hosted cloud browser product or managed fleet</li>
            <li>Stable semver guarantees across every CDP domain</li>
            <li>Full parity with Google Chrome desktop feature set</li>
            <li>24/7 operational SLA for this marketing site</li>
          </ul>
        </ProseSection>

        <div className="grid sm:grid-cols-2 gap-4">
          <InfoCard title="Engine">
            <p>Zig 0.15.2 · V8 · libcurl · CDP + MCP</p>
          </InfoCard>
          <InfoCard title="License">
            <p>
              <Link href="/license" className="text-primary hover:underline">
                {SITE.license}
              </Link>{" "}
              — open source, copyleft for network use.
            </p>
          </InfoCard>
        </div>

        <p className="text-sm font-mono text-muted-foreground pt-4 border-t border-border">
          Last updated: June 2026 · Status reflects active development on main branch.
        </p>
      </div>
    </SitePage>
    </>
  );
}