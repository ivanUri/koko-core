"use client";

import { useEffect, useState, useRef } from "react";
import { AsciiDna } from "./ascii-dna";

const layers = [
  { name: "Core Engine", detail: "DOM, parser, V8 bindings, Web APIs", status: "stable" },
  { name: "Runtime", detail: "Lifecycle, network, storage, telemetry", status: "active" },
  { name: "Protocols", detail: "CDP and MCP implementations", status: "active" },
  { name: "Adapters", detail: "CLI and server entry points", status: "stable" },
  { name: "Public API", detail: "Velora SDK and CDP surface", status: "active" },
  { name: "SDK / CLI", detail: "velora-fetch, @velora/sdk client", status: "stable" },
];

export function InfrastructureSection() {
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
    <section ref={sectionRef} className="relative py-16 bg-muted/30 overflow-hidden">
      <div className="absolute right-0 top-1/2 -translate-y-1/2 opacity-10 pointer-events-none">
        <AsciiDna className="w-[min(100%,600px)] h-auto max-h-[500px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-8"
            }`}
          >
            <p className="text-sm font-mono text-primary mb-2">// ARCHITECTURE</p>
            <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
              Engine internals, explicit layers.
            </h2>
            <p className="text-base text-muted-foreground leading-relaxed mb-6">
              Velora separates browser execution into explicit runtime layers — keeping engine internals isolated, protocols modular, and public APIs stable for embeddable automation.
            </p>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <pre className="font-mono text-2xl text-primary">⚡</pre>
                <div>
                  <h3 className="font-semibold mb-1">Zig-based runtime</h3>
                  <p className="text-sm text-muted-foreground">
                    Low-level control over lifecycle, memory, and protocol behavior
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <pre className="font-mono text-2xl text-primary">🔗</pre>
                <div>
                  <h3 className="font-semibold mb-1">CDP + MCP first-class</h3>
                  <p className="text-sm text-muted-foreground">
                    Automation scripts and AI agents connect through standard protocols
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <pre className="font-mono text-2xl text-primary">📦</pre>
                <div>
                  <h3 className="font-semibold mb-1">Embeddable by design</h3>
                  <p className="text-sm text-muted-foreground">
                    Multi-session model for crawling, testing, and cloud browser runtimes
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div
            className={`transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <div className="grid grid-cols-1 gap-3">
              {layers.map((layer, index) => (
                <div
                  key={layer.name}
                  className="group relative bg-card rounded-lg p-5 border border-border card-shadow hover:border-primary/50 transition-all duration-300"
                  style={{ transitionDelay: `${index * 50}ms` }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-semibold">{layer.name}</h4>
                    <span className="font-mono text-xs text-primary">{layer.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{layer.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 p-6 rounded-lg bg-foreground/5 border border-border">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="font-mono text-2xl font-semibold text-primary">CDP</div>
                  <div className="text-xs text-muted-foreground">Automation</div>
                </div>
                <div>
                  <div className="font-mono text-2xl font-semibold text-primary">MCP</div>
                  <div className="text-xs text-muted-foreground">AI agents</div>
                </div>
                <div>
                  <div className="font-mono text-2xl font-semibold text-primary">SDK</div>
                  <div className="text-xs text-muted-foreground">TypeScript</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}