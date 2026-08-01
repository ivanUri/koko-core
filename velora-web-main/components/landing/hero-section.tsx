"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { AsciiWave } from "./ascii-wave";
import { SITE } from "@/lib/site";

export function HeroSection() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <section className="relative flex flex-col justify-center overflow-hidden py-12 sm:py-16">
      {/* Subtle grid */}
      <div className="absolute inset-0 grid-pattern opacity-50" />
      
      {/* ASCII Wave full width and height */}
      <div className="absolute inset-0 opacity-30 pointer-events-none overflow-hidden">
        <AsciiWave className="w-full h-full" />
      </div>
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Badge */}
        <div 
          className={`flex justify-center mb-6 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          
        </div>
        
        {/* Headline */}
        <div className="text-center max-w-5xl mx-auto mb-6">
          <h1 
            className={`text-4xl sm:text-5xl md:text-7xl font-semibold tracking-tight leading-[1.05] sm:leading-[0.95] mb-4 transition-all duration-700 delay-100 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
            style={{ fontFamily: 'var(--font-geist-pixel-line), monospace' }}
          >
            <span className="text-balance">The browser runtime</span>
            <br />
            <span className="text-balance">built for</span>{" "}
            <span className="text-primary">agents.</span>
          </h1>
          
          <p 
            className={`text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed px-2 sm:px-0 transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            {SITE.tagline} Lightweight, CDP-native, MCP-ready — programmable web infrastructure without the Chromium monolith.
          </p>
        </div>
        
        {/* CTAs */}
        <div 
          className={`flex flex-col sm:flex-row items-center justify-center gap-3 mb-12 transition-all duration-700 delay-300 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <Button 
            size="lg" 
            className="bg-foreground hover:bg-foreground/90 text-background px-6 h-11 text-sm font-medium group"
            asChild
          >
            <a href={SITE.docsUrl}>
              Get started
              <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-0.5" />
            </a>
          </Button>
          <Button 
            size="lg" 
            variant="outline" 
            className="h-11 px-6 text-sm font-medium border-border hover:bg-secondary/50 bg-transparent"
            asChild
          >
            <a href={SITE.githubUrl} target="_blank" rel="noopener noreferrer">View on GitHub</a>
          </Button>
        </div>
        
        {/* Stats with company logos style */}
        <div 
          className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden card-shadow transition-all duration-700 delay-400 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          {[
            { value: "0.22×", label: "navigation vs Chromium.", company: "SPEED" },
            { value: "CDP", label: "compatible automation API.", company: "PROTOCOL" },
            { value: "MCP", label: "native agent tools.", company: "AGENTS" },
            { value: "Zig", label: "low-level runtime control.", company: "ENGINE" },
          ].map((stat) => (
            <div key={stat.company} className="p-4 sm:p-6 lg:p-8 flex justify-between min-h-[120px] sm:min-h-[140px] bg-black shadow-none flex-col">
              <div>
                <span className="text-lg sm:text-xl lg:text-2xl font-semibold">{stat.value}</span>
                <span className="text-muted-foreground text-sm lg:text-base"> {stat.label}</span>
              </div>
              <div className="font-mono text-xs text-muted-foreground/60 tracking-widest mt-4">
                {stat.company}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
