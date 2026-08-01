import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/docs/docs-layout";
import { DocsArticle } from "@/components/docs/docs-article";
import { JsonLdScript } from "@/components/seo/json-ld";
import { getAllDocSlugs, getCategoryForDoc, getDocBySlug } from "@/lib/docs";
import { breadcrumbJsonLd, createMetadata, techArticleJsonLd } from "@/lib/seo";

export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    return createMetadata({
      title: "Documentation not found",
      description: "No Velora documentation page for this URL.",
      path: `/docs/${slug}`,
      noIndex: true,
    });
  }

  const category = getCategoryForDoc(slug);

  return createMetadata({
    title: doc.title,
    description: doc.description,
    path: `/docs/${doc.slug}`,
    keywords: [
      doc.title,
      "Velora documentation",
      category?.title ?? "documentation",
      "browser automation",
    ],
  });
}

export default async function DocDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    return (
      <DocsLayout title="Page not found" activeSlug={slug}>
        <div className="max-w-3xl text-center py-12">
          <h1 className="text-2xl font-semibold mb-4">Documentation page not found</h1>
          <p className="text-muted-foreground mb-8">
            No doc page for <code className="font-mono text-primary">{slug}</code>.
          </p>
          <Link href="/docs" className="text-primary hover:underline">
            Back to documentation
          </Link>
        </div>
      </DocsLayout>
    );
  }

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Docs", path: "/docs" },
    { name: doc.title, path: `/docs/${doc.slug}` },
  ];

  return (
    <>
      <JsonLdScript
        data={[
          techArticleJsonLd({
            title: doc.title,
            description: doc.description,
            path: `/docs/${doc.slug}`,
          }),
          breadcrumbJsonLd(breadcrumbs),
        ]}
      />
      <DocsLayout title={doc.title} description={doc.description} activeSlug={doc.slug}>
        <DocsArticle doc={doc} />
      </DocsLayout>
    </>
  );
}