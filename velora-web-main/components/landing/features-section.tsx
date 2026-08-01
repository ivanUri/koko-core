"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AsciiCube } from "./ascii-cube";

// Animated ASCII generators
const asciiAnimations = {
  neural: (frame: number) => {
    const states = ["◉", "◎", "○", "◎"];
    const getChar = (offset: number) => states[(frame + offset) % states.length];
    return `  ┌───────┐
  │ ${getChar(0)} ${getChar(1)} ${getChar(2)} │
  │ ${getChar(3)} ${getChar(4)} ${getChar(5)} │
  │ ${getChar(6)} ${getChar(7)} ${getChar(8)} │
  └───────┘`;
  },
  workflow: (frame: number) => {
    const arrows = ["─", "═", "━", "═"];
    const pulse = ["►", "▸", "▹", "▸"];
    const a = arrows[frame % arrows.length];
    const p = pulse[frame % pulse.length];
    return `  ┌─┐   ┌─┐
  │A├${a}${a}${p}│B│
  └─┘   └┬┘
        ┌▼┐
        │C│
        └─┘`;
  },
  security: (frame: number) => {
    const lock = ["◈", "◇", "◆", "◇"];
    const bars = ["░", "▒", "▓", "▒"];
    const l = lock[frame % lock.length];
    const b = bars[frame % bars.length];
    return `   ╔═══╗
   ║ ${l} ║
  ┌╨───╨┐
  │${b}${b}${b}${b}${b}│
  └─────┘`;
  },
  analytics: (frame: number) => {
    const heights = [
      [1, 2, 3, 2],
      [2, 3, 2, 3],
      [3, 2, 3, 1],
      [2, 1, 2, 2],
    ];
    const h = heights[frame % heights.length];
    const bar = (height: number) => {
      if (height === 3) return "█";
      if (height === 2) return "▄";
      return "▁";
    };
    return `  │${h[0] === 3 ? "▄" : " "}${h[1] === 3 ? "▄" : " "}${h[2] === 3 ? "▄" : " "}${h[3] === 3 ? "▄" : " "}
  │${bar(h[0])} ${bar(h[1])} ${bar(h[2])} ${bar(h[3])}
  │█ █ █ █
  └────────`;
  },
  globe: (frame: number) => {
    const rotations = [
      `    .--.
   /    \\
  | (  ) |
   \\    /
    '--'`,
      `    .--.
   /    \\
  |  () |
   \\    /
    '--'`,
      `    .--.
   /    \\
  |  (  )|
   \\    /
    '--'`,
      `    .--.
   /    \\
  | ()  |
   \\    /
    '--'`,
    ];
    return rotations[frame % rotations.length];
  },
  api: (frame: number) => {
    const methods = ["GET", "POST", "PUT", "GET"];
    const arrows = [
      "────────►",
      "═══════►",
      "━━━━━━━►",
      "────────►",
    ];
    const m = methods[frame % methods.length];
    const a = arrows[frame % arrows.length];
    return `  ${m} /api
  ${a}
  ◄────────
  { data }`;
  },
};

const features = [
  {
    title: "CDP-Compatible Runtime",
    description: "Connect over Chrome DevTools Protocol — use the Velora SDK, existing CDP clients, or raw WebSocket automation without Chromium internals.",
    animationKey: "api" as const,
  },
  {
    title: "MCP for AI Agents",
    description: "Native Model Context Protocol tools: goto, markdown, links, evaluate, and semantic_tree for token-efficient agent browsing.",
    animationKey: "neural" as const,
  },
  {
    title: "Multi-Session Execution",
    description: "Run many isolated browser sessions from one embeddable runtime. Built for orchestration, crawling, and cloud browser infrastructure.",
    animationKey: "workflow" as const,
  },
  {
    title: "Lifecycle Correctness",
    description: "Deterministic navigation, realm isolation, WindowProxy semantics, and teardown — anti-flake automation from the engine up.",
    animationKey: "security" as const,
  },
  {
    title: "Lightweight Infrastructure",
    description: "Avoid the Chromium-scale runtime model. Lower memory overhead, faster navigation, and simpler embedding for automation workloads.",
    animationKey: "analytics" as const,
  },
  {
    title: "Velora SDK",
    description: "Browser, Page, and Locator APIs over direct CDP — automate pages and agent workflows from Node.js.",
    animationKey: "globe" as const,
  },
];

function AnimatedAscii({ animationKey }: { animationKey: keyof typeof asciiAnimations }) {
  const [frame, setFrame] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => f + 1);
    }, 400);
    return () => clearInterval(interval);
  }, []);
  
  const getAscii = useCallback(() => {
    return asciiAnimations[animationKey](frame);
  }, [animationKey, frame]);
  
  return (
    <pre className="font-mono text-xs text-primary leading-tight whitespace-pre">
      {getAscii()}
    </pre>
  );
}

function FeatureCard({
  feature,
  index,
}: {
  feature: (typeof features)[0];
  index: number;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={`group relative rounded-xl p-6 card-shadow transition-all duration-700 hover:border-primary/50 bg-transparent border-0 border-none border-transparent ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      {/* Animated ASCII Icon */}
      <div className="mb-4 h-16 flex items-center">
        <AnimatedAscii animationKey={feature.animationKey} />
      </div>

      {/* Content */}
      <h3 className="text-base font-semibold mb-1">{feature.title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}

export function FeaturesSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

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
    <section
      id="features"
      ref={sectionRef}
      className="relative py-16 overflow-hidden"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header with ASCII cube */}
        <div className="grid lg:grid-cols-2 gap-12 items-center mb-12">
          <div>
            <p className="text-sm font-mono text-primary mb-2">// RUNTIME</p>
            <h2
              className={`text-3xl lg:text-5xl font-semibold tracking-tight mb-4 transition-all duration-700 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
            >
              <span className="text-balance">Browser infrastructure</span>
              <br />
              <span className="text-balance">for machine execution.</span>
            </h2>
            <p
              className={`text-base text-muted-foreground leading-relaxed max-w-lg transition-all duration-700 delay-100 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
            >
              Velora treats the browser as programmable runtime — deterministic, embeddable, and automation-native. Built for AI agents, crawling, and scalable web interaction.
            </p>
          </div>
          
          {/* ASCII Cube visualization */}
          <div className="flex justify-center lg:justify-end w-full max-w-full overflow-hidden">
            <AsciiCube className="w-full max-w-[240px] sm:max-w-[320px] lg:max-w-[480px] h-auto aspect-[3/4]" />
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
