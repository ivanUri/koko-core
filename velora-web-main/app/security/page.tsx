import Link from "next/link";
import {
  SitePage,
  ProseSection,
  InfoCard,
  CodeBlock,
} from "@/components/layout/site-page";
import { JsonLdScript } from "@/components/seo/json-ld";
import { SITE } from "@/lib/site";
import { breadcrumbJsonLd, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Security",
  description: "How to report security vulnerabilities in Velora responsibly.",
  path: "/security",
  keywords: ["Velora security policy", "responsible disclosure", "vulnerability reporting"],
});

export default function SecurityPage() {
  return (
    <>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Security", path: "/security" },
        ])}
      />
      <SitePage
      eyebrow="// SECURITY"
      title="Security policy"
      description="Velora is a browser runtime — security issues can affect automation infrastructure, network behavior, and embedded deployments. Please report vulnerabilities privately."
    >
      <div className="space-y-10">
        <ProseSection title="Supported versions">
          <p>
            Security fixes are applied to the latest <code className="font-mono text-primary">main</code>{" "}
            branch of the Velora repository. There are no long-term support branches at this stage
            of the project.
          </p>
        </ProseSection>

        <ProseSection title="Reporting a vulnerability">
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-5 mb-4">
            <p className="text-foreground font-medium mb-2">Please do not file public GitHub issues for security bugs.</p>
            <p>
              Send reports privately to{" "}
              <a href="mailto:security@velora.io" className="text-primary hover:underline font-mono">
                security@velora.io
              </a>
              .
            </p>
          </div>
          <p>Include as much of the following as you can:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Description of the issue and impact (RCE, sandbox escape, memory safety, etc.)</li>
            <li>Steps to reproduce on a current <code className="font-mono text-primary">main</code> checkout</li>
            <li>Velora version or git commit hash</li>
            <li>Platform (OS, CPU arch) and build mode (Debug / ReleaseFast)</li>
            <li>Proof-of-concept if available — minimize harm to third parties</li>
          </ul>
        </ProseSection>

        <ProseSection title="What we consider in scope">
          <ul className="list-disc pl-6 space-y-2">
            <li>Memory safety issues in the Zig/V8/runtime boundary</li>
            <li>Sandbox or realm isolation failures</li>
            <li>CDP/MCP endpoints exposing unintended privilege escalation</li>
            <li>TLS or network stack misbehavior shipped in Velora binaries</li>
            <li>Supply-chain issues in first-party Velora build scripts (case by case)</li>
          </ul>
        </ProseSection>

        <ProseSection title="Out of scope (usually)">
          <ul className="list-disc pl-6 space-y-2">
            <li>Websites you automate behaving maliciously — that is the target site&apos;s problem</li>
            <li>Captcha or bot-detection bypass as a &quot;vulnerability&quot; in Velora</li>
            <li>Issues in upstream Chromium/V8 already tracked upstream (we may still cherry-pick fixes)</li>
            <li>Denial of service from intentionally hostile pages without a novel engine bug</li>
          </ul>
        </ProseSection>

        <ProseSection title="Disclosure timeline">
          <p>
            We aim to acknowledge reports within a few business days. Coordinated disclosure
            depends on severity and fix complexity. We credit researchers in release notes when
            they agree — anonymous disclosure is respected if you request it.
          </p>
        </ProseSection>

        <ProseSection title="Secure development practices">
          <div className="grid sm:grid-cols-2 gap-4">
            <InfoCard title="Runtime">
              <p>Zig safety checks, isolated test probes, CDP budget timeouts on scripts.</p>
            </InfoCard>
            <InfoCard title="Automation tests">
              <p>
                <code className="font-mono text-primary">code-check/</code> lifecycle and fingerprint
                regression suites.
              </p>
            </InfoCard>
          </div>
        </ProseSection>

        <ProseSection title="Contact">
          <CodeBlock>{`security@velora.io`}</CodeBlock>
          <p className="text-sm">
            For non-security engineering discussion, use the{" "}
            <Link href="/blog" className="text-primary hover:underline">
              dev blog
            </Link>{" "}
            or{" "}
            <a href={SITE.githubUrl} className="text-primary hover:underline">
              GitHub
            </a>
            .
          </p>
        </ProseSection>
      </div>
    </SitePage>
    </>
  );
}