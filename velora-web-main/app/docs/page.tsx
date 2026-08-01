import Link from "next/link";
import { BookOpen } from "lucide-react";
import { DocsLayout } from "@/components/docs/docs-layout";
import { DOC_CATEGORIES } from "@/lib/docs";
import { SITE } from "@/lib/site";

export default function DocsPage() {
  return (
    <DocsLayout
      title={`${SITE.name} Documentation`}
      description="Install the SDK, connect to Velora, and automate — CDP server, MCP agents, and TypeScript APIs."
    >
      <div className="max-w-3xl">
        <div className="mb-12 p-6 border border-border rounded-lg bg-secondary/30">
          <div className="flex items-start gap-4 mb-4">
            <div className="p-2 rounded-lg bg-primary/10">
              <BookOpen className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold mb-2">Welcome to Velora Docs</h2>
              <p className="text-muted-foreground">
                Velora is an AI-first headless browser runtime. Install the SDK, launch or connect
                to a runtime, and automate — no compiler required for everyday use.
              </p>
            </div>
          </div>
        </div>

        <div className="mb-12">
          <h3 className="text-lg font-semibold mb-4">Quick start</h3>
          <div className="rounded-lg border border-border bg-card p-6 font-mono text-sm space-y-2 text-muted-foreground">
            <div>
              <span className="text-primary">$</span> npm install @velora/sdk
            </div>
            <div className="pt-2 border-t border-border mt-4">
              <span className="text-muted-foreground/60"># Launch and automate</span>
            </div>
            <div>
              <span className="text-green-400">import</span> {"{ Browser }"}{" "}
              <span className="text-green-400">from</span>{" "}
              <span className="text-yellow-400">&quot;@velora/sdk&quot;</span>;
            </div>
            <div>
              <span className="text-green-400">const</span> launched ={" "}
              <span className="text-green-400">await</span> Browser.launch({"{"} binary:{" "}
              <span className="text-yellow-400">&quot;/path/to/velora&quot;</span> {"}"});
            </div>
            <div>
              <span className="text-green-400">const</span> page = <span className="text-green-400">await</span>{" "}
              launched.browser.newPage();
            </div>
            <div>
              <span className="text-green-400">await</span> page.goto(
              <span className="text-yellow-400">&quot;https://example.com&quot;</span>);
            </div>
          </div>
        </div>

        <div className="mb-12">
          <h3 className="text-lg font-semibold mb-4">Quick links</h3>
          <div className="grid gap-4">
            {DOC_CATEGORIES[0].docs.map((doc) => (
              <Link
                key={doc.slug}
                href={`/docs/${doc.slug}`}
                className="p-4 border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/50 transition-all group"
              >
                <div className="flex items-center justify-between">
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

        <div>
          <h3 className="text-lg font-semibold mb-4">Browse by category</h3>
          <div className="grid md:grid-cols-2 gap-4">
            {DOC_CATEGORIES.slice(1).map((category) => (
              <div
                key={category.id}
                className="p-4 border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/50 transition-all"
              >
                <h4 className="font-medium mb-2">{category.title}</h4>
                <ul className="space-y-1">
                  {category.docs.map((doc) => (
                    <li key={doc.slug}>
                      <Link
                        href={`/docs/${doc.slug}`}
                        className="text-sm text-muted-foreground hover:text-primary transition-colors"
                      >
                        {doc.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DocsLayout>
  );
}