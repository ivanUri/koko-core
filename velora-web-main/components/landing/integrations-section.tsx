"use client";

import { useEffect, useState, useRef } from "react";
import { AsciiCube } from "./ascii-cube";
import { SITE } from "@/lib/site";

const integrations = [
  { 
    name: "CDP", 
    category: "Protocol",
    ascii: `  ┌─┐
  │C│
  └─┘`
  },
  { 
    name: "MCP", 
    category: "Agents",
    ascii: `  ╔═╗
  ║M║
  ╚═╝`
  },
  { 
    name: "Velora SDK", 
    category: "Client",
    ascii: `  ┌▶┐
  └─┘`
  },
  { 
    name: "TypeScript", 
    category: "Language",
    ascii: `  [TS]
  [TS]`
  },
  { 
    name: "Zig", 
    category: "Engine",
    ascii: `  ◈◈
  ◈◈`
  },
  { 
    name: "V8", 
    category: "JS runtime",
    ascii: `  ≋≋
  ≋≋`
  },
  { 
    name: "velora-fetch", 
    category: "CLI",
    ascii: `  {f}
  ---`
  },
  { 
    name: "Node.js", 
    category: "Tooling",
    ascii: `  ▲
  ─`
  },
];

export function IntegrationsSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="relative py-16 overflow-hidden">
      <div className="absolute left-10 top-1/3 opacity-5 pointer-events-none hidden xl:block">
        <AsciiCube className="w-[400px] h-[350px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        <div
          className={`text-center max-w-3xl mx-auto mb-12 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <p className="text-sm font-mono text-primary mb-2">// PROTOCOLS & TOOLING</p>
          <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
            Connect agents,<br />scripts, and infra.
          </h2>
          <p className="text-base text-muted-foreground leading-relaxed">
            Velora speaks the protocols automation systems already use — CDP for scripts, MCP for agents, and a first-party SDK for programmatic control.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {integrations.map((integration, index) => (
            <div
              key={integration.name}
              className={`group relative bg-card rounded-xl p-6 border border-border card-shadow hover:border-primary/50 transition-all duration-500 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              }`}
              style={{ transitionDelay: `${index * 50}ms` }}
            >
              <pre className="font-mono text-lg text-primary mb-4 leading-tight h-12 flex items-center justify-center">
                {integration.ascii}
              </pre>
              
              <div className="text-center">
                <h3 className="font-semibold mb-1">{integration.name}</h3>
                <p className="text-xs text-muted-foreground">{integration.category}</p>
              </div>

              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-primary font-mono text-xs">→</span>
              </div>
            </div>
          ))}
        </div>

        <div
          className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-card to-muted/50 border border-border card-shadow transition-all duration-700 delay-300 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="relative z-10 p-8 lg:p-12">
            <div className="grid lg:grid-cols-2 gap-8 items-center">
              <div>
                <h3 className="text-2xl lg:text-3xl font-semibold mb-4">
                  Agent-oriented extraction
                </h3>
                <p className="text-muted-foreground mb-6">
                  Token-efficient page state for LLM workflows — markdown, semantic trees, structured data, and stable backendNodeId handles.
                </p>
                <a href={SITE.docsUrl} className="inline-block px-6 py-3 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors">
                  SDK documentation
                </a>
              </div>

              <div className="font-mono text-[11px] sm:text-xs text-muted-foreground space-y-2 bg-background/50 rounded-lg p-4 sm:p-6 border border-border overflow-x-auto">
                <div className="text-primary mb-2">// Agent extraction</div>
                <div>
                  <span className="text-purple-400">const</span> md = <span className="text-blue-400">await</span> page.markdown();
                </div>
                <div>
                  <span className="text-purple-400">const</span> tree = <span className="text-blue-400">await</span> page.semanticTree({'{'}
                </div>
                <div className="pl-4">
                  <span className="text-green-400">format</span>: <span className="text-yellow-400">&quot;text&quot;</span>,
                </div>
                <div className="pl-4">
                  <span className="text-green-400">maxDepth</span>: <span className="text-yellow-400">4</span>
                </div>
                <div>{'}'});</div>
              </div>
            </div>
          </div>

          <div className="absolute inset-0 opacity-5 grid-pattern pointer-events-none" />
        </div>
      </div>
    </section>
  );
}