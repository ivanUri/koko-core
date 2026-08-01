import { SITE } from "@/lib/site";

export type NavLink = {
  name: string;
  href: string;
  external?: boolean;
};

export const HEADER_LINKS: NavLink[] = [
  { name: "Features", href: "/features" },
  { name: "How it works", href: "/how-it-works" },
  { name: "Benchmarks", href: "/benchmarks" },
  { name: "SDK", href: "/sdk" },
  { name: "Blog", href: "/blog" },
  { name: "Docs", href: "/docs" },
];

export function isNavLinkActive(pathname: string, href: string): boolean {
  if (href === "/blog") return pathname.startsWith("/blog");
  if (href === "/docs") return pathname.startsWith("/docs");
  return pathname === href;
}

export const FOOTER_LINKS = {
  Product: [
    { name: "Features", href: "/features" },
    { name: "How it works", href: "/how-it-works" },
    { name: "Benchmarks", href: "/benchmarks" },
    { name: "Status", href: "/status" },
  ],
  Developers: [
    { name: "Documentation", href: "/docs" },
    { name: "SDK", href: "/sdk" },
    { name: "Blog", href: "/blog" },
    { name: "GitHub", href: SITE.githubUrl, external: true },
  ],
  Project: [
    { name: "Architecture", href: "/features" },
    { name: "Benchmarks", href: "/benchmarks" },
    { name: "Engineering notes", href: "/blog" },
    { name: "License", href: "/license" },
  ],
  Legal: [
    { name: "AGPL-3.0", href: "/license" },
    { name: "Security", href: "/security" },
    { name: "Contact", href: "mailto:security@velora.io", external: true },
  ],
} as const;