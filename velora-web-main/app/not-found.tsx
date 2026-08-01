import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Page not found",
  description: "The page you are looking for does not exist on Velora.",
  path: "/404",
  noIndex: true,
  titleAbsolute: true,
});

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Navigation />
      <main className="flex-1 flex items-center justify-center px-6 py-24">
        <div className="text-center max-w-md">
          <p className="text-sm font-mono text-primary mb-3">// 404</p>
          <h1 className="text-4xl font-semibold tracking-tight mb-4">Page not found</h1>
          <p className="text-muted-foreground mb-8">
            This URL does not exist. Try the docs, blog, or homepage.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors"
            >
              Go home
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-border text-sm font-medium hover:bg-secondary/50 transition-colors"
            >
              Documentation
            </Link>
          </div>
        </div>
      </main>
      <FooterSection />
    </div>
  );
}