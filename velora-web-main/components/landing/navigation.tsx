"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { SITE } from "@/lib/site";
import { HEADER_LINKS, isNavLinkActive } from "@/lib/navigation";

function navLinkClassName(isActive: boolean) {
  return `px-4 py-2 text-sm transition-colors duration-200 rounded-lg ${
    isActive
      ? "text-foreground bg-secondary/70 font-medium"
      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
  }`;
}

export function Navigation() {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  return (
    <>
      <header
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 bg-background border-b border-border ${
          isScrolled || isMobileMenuOpen
            ? "shadow-sm backdrop-blur-xl supports-[backdrop-filter]:bg-background/95"
            : ""
        }`}
      >
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 sm:h-20">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="relative w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-accent/20" />
                <span className="font-mono text-primary font-bold text-lg relative z-10">
                  V
                </span>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-primary/10" />
              </div>
              <span className="text-xl font-bold tracking-tight">{SITE.name}</span>
            </Link>

            <div className="hidden md:flex items-center gap-1">
              {HEADER_LINKS.map((link) => {
                const active = isNavLinkActive(pathname, link.href);
                return (
                  <Link
                    key={link.name}
                    href={link.href}
                    className={navLinkClassName(active)}
                    aria-current={active ? "page" : undefined}
                  >
                    {link.name}
                  </Link>
                );
              })}
            </div>

            <div className="hidden md:flex items-center gap-3">
              <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
                <a href={SITE.githubUrl} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
              </Button>
              <Button
                size="sm"
                className="bg-foreground hover:bg-foreground/90 text-background"
                asChild
              >
                <Link href={SITE.docsUrl}>Get started</Link>
              </Button>
            </div>

            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 rounded-lg hover:bg-secondary/50 transition-colors"
              aria-label="Toggle menu"
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>

          <div
            className={`md:hidden overflow-hidden transition-all duration-300 ${
              isMobileMenuOpen ? "max-h-[500px] pb-6" : "max-h-0"
            }`}
          >
            <div className="flex flex-col gap-2 pt-4 border-t border-border/50">
              {HEADER_LINKS.map((link) => {
                const active = isNavLinkActive(pathname, link.href);
                return (
                  <Link
                    key={link.name}
                    href={link.href}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={`px-4 py-3 rounded-lg transition-colors ${
                      active
                        ? "text-foreground bg-secondary/70 font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {link.name}
                  </Link>
                );
              })}
              <div className="flex flex-col gap-2 pt-4 mt-2 border-t border-border/50">
                <Button variant="ghost" className="justify-start text-muted-foreground" asChild>
                  <a href={SITE.githubUrl} target="_blank" rel="noopener noreferrer">
                    GitHub
                  </a>
                </Button>
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" asChild>
                  <Link href={SITE.docsUrl}>Get started</Link>
                </Button>
              </div>
            </div>
          </div>
        </nav>
      </header>
      <div className="h-16 sm:h-20 shrink-0" aria-hidden="true" />
    </>
  );
}