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
  title: "License",
  description: "Velora is licensed under AGPL-3.0-only. What that means for users and contributors.",
  path: "/license",
  keywords: ["AGPL-3.0", "Velora license", "open source browser runtime", "copyleft"],
});

export default function LicensePage() {
  return (
    <>
      <JsonLdScript
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "License", path: "/license" },
        ])}
      />
      <SitePage
      eyebrow="// LICENSE"
      title="AGPL-3.0"
      description="Velora's default license is GNU Affero General Public License v3.0 (AGPL-3.0-only). SPDX identifiers follow the SPDX License List."
    >
      <div className="space-y-10">
        <ProseSection title="Summary">
          <p>
            You may use, study, modify, and distribute Velora under the terms of AGPL-3.0. If you
            run a modified version as a network service, you must offer corresponding source to
            users interacting with it over the network. That copyleft requirement is intentional
            for browser runtime infrastructure offered as a service.
          </p>
          <p>
            License names in the Velora repository follow the{" "}
            <a
              href="https://spdx.org/licenses/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              SPDX License List
            </a>
            . The canonical license file is <code className="font-mono text-primary">LICENSE</code>{" "}
            in the project root; dependency licensing is documented in{" "}
            <code className="font-mono text-primary">LICENSING.md</code>.
          </p>
        </ProseSection>

        <ProseSection title="What AGPL adds beyond GPL">
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-foreground">Network copyleft</strong> — SaaS use triggers
              source-offer obligations when you modify the program and let users interact with it
              remotely.
            </li>
            <li>
              <strong className="text-foreground">Freedom to fork</strong> — you receive source,
              may patch the runtime, and may redistribute under the same license.
            </li>
            <li>
              <strong className="text-foreground">No trademark grant</strong> — the license does
              not grant permission to use the Velora name for derivative branding without separate
              agreement.
            </li>
          </ul>
        </ProseSection>

        <ProseSection title="Typical use cases">
          <div className="space-y-4">
            <InfoCard title="Internal automation (on your hardware)">
              <p>
                Build and run Velora inside your own infrastructure for crawling, agents, or
                testing. AGPL obligations depend on how you distribute or expose the software —
                consult your counsel for your deployment model.
              </p>
            </InfoCard>
            <InfoCard title="Forks and patches">
              <p>
                Modifications must stay under AGPL when you convey the program. Publish your
                changes when required by the license, especially for network-facing deployments.
              </p>
            </InfoCard>
            <InfoCard title="SDK (@velora/sdk)">
              <p>
                The TypeScript SDK is part of the Velora workspace. Treat it as part of the same
                licensing story unless a separate license file explicitly states otherwise in your
                checkout.
              </p>
            </InfoCard>
          </div>
        </ProseSection>

        <ProseSection title="Third-party components">
          <p>
            Velora bundles and links against many open-source dependencies (V8, libcurl, Rust
            crates, npm packages, etc.). Each carries its own license. See{" "}
            <code className="font-mono text-primary">LICENSING.md</code> and vendored{" "}
            <code className="font-mono text-primary">licenses.html</code> in the repository for
            the full matrix.
          </p>
        </ProseSection>

        <ProseSection title="Full license text">
          <p>
            The complete AGPL-3.0 legal text ships in the repository{" "}
            <code className="font-mono text-primary">LICENSE</code> file. This page is a plain-language
            overview only — not legal advice.
          </p>
          <p>
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.en.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Read AGPL-3.0 on gnu.org →
            </a>
          </p>
        </ProseSection>

        <p className="text-sm text-muted-foreground pt-4 border-t border-border">
          Questions about licensing? Open a discussion in the{" "}
          <a href={SITE.githubUrl} className="text-primary hover:underline">
            GitHub repository
          </a>{" "}
          or contact{" "}
          <a href="mailto:security@velora.io" className="text-primary hover:underline">
            security@velora.io
          </a>{" "}
          for sensitive commercial inquiries.
        </p>
      </div>
    </SitePage>
    </>
  );
}