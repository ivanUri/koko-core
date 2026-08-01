"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { AsciiCube } from "./ascii-cube";
import { AsciiSphere } from "./ascii-sphere";
import { SITE } from "@/lib/site";

export function CtaSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="relative py-16 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div
          className={`relative rounded-2xl overflow-hidden transition-all duration-1000 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="absolute inset-0 bg-foreground" />
          <div className="absolute inset-0 grid-pattern opacity-10" />
          
          <div className="absolute right-0 top-1/2 -translate-y-1/2 overflow-hidden opacity-25 hidden sm:block">
            <AsciiCube className="w-[280px] sm:w-[400px] lg:w-[600px] h-auto aspect-square" />
          </div>

          <div className="relative z-10 px-5 sm:px-8 lg:px-16 py-10 sm:py-12 bg-transparent">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div className="max-w-2xl">
                <h2 className="text-2xl sm:text-3xl lg:text-5xl font-semibold tracking-tight mb-4 text-background text-balance">
                  Build on programmable browser infrastructure.
                </h2>

                <p className="text-base text-background/70 mb-6 leading-relaxed max-w-lg">
                  Velora is under active development — focused on automation reliability, lifecycle correctness, and AI-agent integration. Clone the repo and run your first session today.
                </p>

                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <Button
                    size="lg"
                    className="bg-background hover:bg-background/90 text-foreground px-6 h-12 text-sm font-medium group"
                    asChild
                  >
                    <a href={SITE.docsUrl}>
                      Read the docs
                      <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-0.5" />
                    </a>
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="h-12 px-6 text-sm font-medium border-background/30 text-background hover:bg-background/10 bg-transparent"
                    asChild
                  >
                    <a href={SITE.githubUrl} target="_blank" rel="noopener noreferrer">Star on GitHub</a>
                  </Button>
                </div>

                <p className="text-sm text-background/50 mt-6 font-mono">
                  AGPL-3.0 · Zig + TypeScript · CDP + MCP
                </p>
              </div>
              
              <div className="hidden lg:block opacity-40">
                <AsciiSphere className="w-[600px] h-[560px]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}