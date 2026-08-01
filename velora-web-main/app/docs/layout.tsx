import { createMetadata } from "@/lib/seo";
import { SITE } from "@/lib/site";

export const metadata = createMetadata({
  title: "Documentation",
  description: `Install the ${SITE.name} SDK, connect to the CDP server, and automate — MCP agents, protocols, and TypeScript APIs.`,
  path: "/docs",
  keywords: [
    "Velora documentation",
    "CDP server docs",
    "MCP browser tools",
    "SDK reference",
    "browser automation guide",
  ],
});

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}