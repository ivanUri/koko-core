"use client";

import Link from "next/link";
import { Github, Terminal } from "lucide-react";
import { FOOTER_LINKS } from "@/lib/navigation";
import { SITE } from "@/lib/site";

export function FooterSection() {
  return (
    <footer className="relative border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="py-10 sm:py-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-8 sm:gap-6">
            <div className="sm:col-span-2">
              <Link href="/" className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Terminal className="w-4 h-4 text-primary" />
                </div>
                <span className="font-semibold text-lg tracking-tight">velora</span>
              </Link>

              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                {SITE.description}
              </p>

              <div className="flex gap-2">
                <a
                  href={SITE.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="GitHub"
                >
                  <Github className="w-5 h-5" />
                </a>
              </div>
            </div>

            {Object.entries(FOOTER_LINKS).map(([title, links]) => (
              <div key={title}>
                <h3 className="text-sm font-medium mb-3">{title}</h3>
                <ul className="space-y-2">
                  {links.map((link) => (
                    <li key={link.name}>
                      {"external" in link && link.external ? (
                        <a
                          href={link.href}
                          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {link.name}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {link.name}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="py-4 border-t border-border flex flex-col md:flex-row items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            2026 Velora. Open source under {SITE.license}.
          </p>

          <Link href="/status" className="flex items-center gap-4 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Active development
            </span>
          </Link>
        </div>
      </div>
    </footer>
  );
}