"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { SITE } from "@/lib/site";

const codeExamples = [
  {
    label: "Connect",
    code: `import { Browser } from "@velora/sdk";

const browser = await Browser.connect(
  "http://127.0.0.1:9222"
);
const page = await browser.newPage();`,
  },
  {
    label: "Agent",
    code: `const md = await page.markdown();
const tree = await page.semanticTree({
  format: "text",
  maxDepth: 4
});

const [search] = await page.findElement({
  role: "combobox", name: "search"
});
await page.node(search.backendNodeId!).fill("velora");`,
  },
  {
    label: "Launch",
    code: `const launched = await Browser.launch({
  profile: "chrome-local-huys-macbook-pro",
  cookieJar: "browser/profiles/sessions/my-session.json",
});

const page = await launched.browser.newPage();
await page.goto("https://example.com");
await launched.close();`,
  },
];

const features = [
  { 
    title: "Browser automation API", 
    description: "Browser, Context, Page, Locator, and wait strategies for scripts and test suites."
  },
  { 
    title: "Velora-only agent APIs", 
    description: "markdown(), semanticTree(), detectForms(), searchGoogle(), and backendNodeId handles."
  },
  { 
    title: "Direct CDP transport", 
    description: "Lightweight WebSocket CDP client — no third-party browser driver stack."
  },
  { 
    title: "CLI helpers", 
    description: "velora-fetch and CDP probes for quick extraction and regression testing."
  },
];

export function DevelopersSection() {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeExamples[activeTab].code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="developers" className="relative py-16 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-start">
          <div>
            <p className="text-sm font-mono text-primary mb-2">// SDK</p>
            <h2 className="text-3xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
              Velora SDK,<br />automate in code.
            </h2>
            <p className="text-base text-muted-foreground mb-6 leading-relaxed">
              Connect over CDP, automate pages, and extract agent-friendly state — without pulling in a full Chromium stack.
            </p>
            
            <div className="grid gap-4">
              {features.map((feature) => (
                <div key={feature.title} className="flex gap-4">
                  <div className="w-1 bg-primary/30 rounded-full shrink-0" />
                  <div>
                    <h3 className="font-medium mb-1">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="lg:sticky lg:top-32 min-w-0">
            <div className="rounded-xl overflow-hidden bg-card border border-border card-shadow">
              <div className="flex items-center gap-1 p-2 border-b border-border bg-secondary/30">
                {codeExamples.map((example, idx) => (
                  <button
                    key={example.label}
                    type="button"
                    onClick={() => setActiveTab(idx)}
                    className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                      activeTab === idx
                        ? "bg-card text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {example.label}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Copy code"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
              
              <div className="p-6 font-mono text-sm overflow-x-auto">
                <pre className="text-muted-foreground">
                  <code>
                    {codeExamples[activeTab].code.split('\n').map((line, i) => (
                      <div key={i} className="leading-relaxed">
                        <span className="text-muted-foreground/40 select-none w-8 inline-block">{i + 1}</span>
                        <span 
                          dangerouslySetInnerHTML={{ 
                            __html: highlightSyntax(line) 
                          }} 
                        />
                      </div>
                    ))}
                  </code>
                </pre>
              </div>
              
              <div className="border-t border-border p-4 bg-secondary/20">
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mb-2">
                  <span className="text-green-500">$</span>
                  <span>npm install @velora/sdk</span>
                </div>
                <div className="text-xs font-mono text-muted-foreground/60">
                  workspace package in the Velora monorepo
                </div>
              </div>
            </div>
            
            <div className="mt-6 flex items-center gap-4 text-sm">
              <a href={SITE.docsUrl} className="text-primary hover:underline font-mono">
                Read the docs
              </a>
              <span className="text-border">|</span>
              <a href={SITE.githubUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground font-mono">
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function highlightSyntax(line: string): string {
  return line
    .replace(/(import|from|const|await|async)/g, '<span class="text-primary">$1</span>')
    .replace(/('.*?'|".*?")/g, '<span class="text-green-400">$1</span>')
    .replace(/(\/\/.*$)/g, '<span class="text-muted-foreground/50">$1</span>')
    .replace(/(\{|\}|\(|\)|\[|\])/g, '<span class="text-muted-foreground">$1</span>');
}