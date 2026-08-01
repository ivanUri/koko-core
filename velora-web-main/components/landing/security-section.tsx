"use client";

import { useEffect, useState, useRef } from "react";
import { AsciiTorus } from "./ascii-torus";

const engineeringFeatures = [
  {
    title: "Realm Isolation",
    description: "Frames, workers, and execution contexts stay isolated — no cross-realm leaks in automation",
    ascii: `  ╔═══╗
  ║ ◈ ║
  ╚═══╝`
  },
  {
    title: "Navigation Ordering",
    description: "Deterministic domcontentloaded and lifecycle events for anti-flake scripts",
    ascii: `  ┌───┐
  │ ✓ │
  └───┘`
  },
  {
    title: "WindowProxy Semantics",
    description: "Correct proxy behavior across frames — critical for protocol integrations",
    ascii: `  ╭───╮
  │ ★ │
  ╰───╯`
  },
  {
    title: "Teardown Correctness",
    description: "Clean session close without zombie processes or leaked handles",
    ascii: `  [===]
  [===]`
  },
  {
    title: "Deterministic Events",
    description: "Predictable event ordering and microtask scheduling for stable automation",
    ascii: `  ◉─◉─◉
  │ │ │`
  },
  {
    title: "Lifecycle Tests",
    description: "Regression suites under code-check/lifecycle for continuous correctness",
    ascii: `  ▪ ▪ ▪
  ▪ ▪ ▪`
  },
];

const focusAreas = [
  { name: "CDP", status: "Consistent" },
  { name: "MCP", status: "Active dev" },
  { name: "Realms", status: "Tested" },
  { name: "AGPL-3.0", status: "Open source" },
];

export function SecuritySection() {
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
      <div className="absolute right-0 bottom-0 opacity-5 pointer-events-none">
        <AsciiTorus className="w-[min(100%,500px)] h-auto max-h-[450px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8">
        <div
          className={`text-center max-w-3xl mx-auto mb-12 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <p className="text-sm font-mono text-primary mb-2">// ENGINEERING</p>
          <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight mb-4 text-balance">
            Correctness you can rely on.
          </h2>
          <p className="text-base text-muted-foreground leading-relaxed">
            Reliable automation depends on browser lifecycle behavior. Velora engineers correctness into navigation, realms, and teardown — not as an afterthought.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {engineeringFeatures.map((feature, index) => (
            <div
              key={feature.title}
              className={`bg-card rounded-xl p-5 border border-border card-shadow transition-all duration-500 hover:border-primary/50 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              }`}
              style={{ transitionDelay: `${index * 50}ms` }}
            >
              <pre className="font-mono text-sm text-primary mb-3 leading-tight h-10 flex items-center">
                {feature.ascii}
              </pre>

              <h3 className="font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>

        <div
          className={`rounded-xl bg-card border border-border card-shadow p-8 transition-all duration-700 delay-300 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div>
              <h3 className="font-semibold text-lg mb-2">Development focus</h3>
              <p className="text-sm text-muted-foreground">
                Under active development — automation reliability, CDP consistency, and AI-agent integration
              </p>
            </div>

            <div className="flex flex-wrap gap-4 justify-center md:justify-end">
              {focusAreas.map((area) => (
                <div
                  key={area.name}
                  className="flex flex-col items-center gap-2 px-6 py-4 rounded-lg bg-muted/50 border border-border"
                >
                  <span className="font-mono text-xs text-primary">{area.name}</span>
                  <span className="text-xs text-muted-foreground">{area.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          className={`mt-8 p-6 rounded-xl bg-foreground/5 border border-primary/20 transition-all duration-700 delay-400 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="flex items-start gap-4">
            <pre className="font-mono text-2xl text-primary mt-1">📋</pre>
            <div>
              <h4 className="font-semibold mb-2">Open source & transparent</h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Velora is AGPL-3.0 licensed. Benchmarks, lifecycle tests, and engineering notes are published in-repo. 
                <a href="/blog" className="text-primary hover:underline ml-1">Read engineering notes →</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}