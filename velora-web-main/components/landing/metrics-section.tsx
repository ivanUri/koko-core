"use client";

import { useEffect, useState, useRef } from "react";
import { AsciiWave } from "./ascii-wave";

function AnimatedCounter({ end, suffix = "", prefix = "", decimals = 0 }: { end: number; suffix?: string; prefix?: string; decimals?: number }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [hasAnimated, setHasAnimated] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          setHasAnimated(true);
          const duration = 2000;
          const startTime = performance.now();

          const animate = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const value = eased * end;
            setCount(decimals > 0 ? Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals) : Math.floor(value));

            if (progress < 1) {
              requestAnimationFrame(animate);
            }
          };

          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.5 }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, hasAnimated, decimals]);

  const display = decimals > 0 ? count.toFixed(decimals) : count.toLocaleString();

  return (
    <div ref={ref} className="font-mono text-3xl sm:text-4xl lg:text-6xl font-semibold tracking-tight">
      {prefix}{display}{suffix}
    </div>
  );
}

const metrics = [
  {
    value: 0.22,
    suffix: "×",
    decimals: 2,
    label: "Navigation geomean vs Chromium",
    sublabel: "Local static fixtures (2026-06-29)"
  },
  {
    value: 106,
    suffix: "ms",
    label: "Cold start (Velora mean)",
    sublabel: "Comparable to bundled headless Chromium"
  },
  {
    value: 4,
    suffix: "",
    label: "Fixture pages benchmarked",
    sublabel: "dom-heavy, js-compute, minimal, mixed"
  },
  {
    value: 0,
    suffix: "",
    label: "Benchmark errors",
    sublabel: "Velora + Chromium, 3 repeats each"
  },
];

export function MetricsSection() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section id="metrics" className="relative py-12 sm:py-16 overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
        <AsciiWave className="w-full h-full object-cover" />
      </div>
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-12">
          <div>
            <p className="text-sm font-mono text-primary mb-2">// BENCHMARKS</p>
            <h2 className="text-3xl lg:text-5xl font-semibold tracking-tight text-balance">
              Measured on<br />local fixtures.
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs sm:text-sm text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span>Local fixtures only</span>
            <span className="text-border hidden sm:inline">|</span>
            <span>{time.toLocaleTimeString()}</span>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden card-shadow">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="bg-card p-6 flex flex-col gap-3"
            >
              <div className="text-primary">
                <AnimatedCounter 
                  end={metric.value} 
                  suffix={metric.suffix}
                  decimals={metric.decimals ?? 0}
                />
              </div>
              <div>
                <div className="text-foreground font-medium">{metric.label}</div>
                <div className="text-sm text-muted-foreground">{metric.sublabel}</div>
              </div>
            </div>
          ))}
        </div>
        
        <div className="mt-12 p-4 sm:p-6 rounded-xl bg-card border border-border card-shadow overflow-hidden">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="font-mono text-sm text-muted-foreground">Navigation results (mean ms)</span>
          </div>
          <div className="font-mono text-xs space-y-2 text-muted-foreground">
            <ActivityLine page="dom-heavy.html" velora="19.9" chromium="72.7" ratio="0.27×" />
            <ActivityLine page="js-compute.html" velora="8.1" chromium="37.9" ratio="0.21×" />
            <ActivityLine page="minimal.html" velora="8.1" chromium="37.9" ratio="0.21×" />
            <ActivityLine page="mixed.html" velora="9.4" chromium="48.7" ratio="0.19×" />
          </div>
        </div>
      </div>
    </section>
  );
}

function ActivityLine({ page, velora, chromium, ratio }: { 
  page: string; 
  velora: string; 
  chromium: string; 
  ratio: string; 
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4 py-1 border-b border-border/50 last:border-0 sm:border-0 sm:py-0">
      <span className="text-foreground font-medium truncate sm:w-32 shrink-0">{page}</span>
      <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm">
        <span className="text-primary shrink-0">{velora}ms</span>
        <span className="text-muted-foreground/50 shrink-0">{chromium}ms</span>
        <span className="text-green-500 shrink-0">{ratio}</span>
      </div>
    </div>
  );
}