import type { Metadata } from "next";
import { SITE } from "@/lib/site";

export function getSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export function absoluteUrl(path = "/"): string {
  const base = getSiteUrl();
  if (path === "/" || path === "") return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

type CreateMetadataOptions = {
  title: string;
  description: string;
  path?: string;
  keywords?: string[];
  type?: "website" | "article";
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
  section?: string;
  noIndex?: boolean;
  titleAbsolute?: boolean;
};

export function createMetadata({
  title,
  description,
  path = "/",
  keywords,
  type = "website",
  publishedTime,
  modifiedTime,
  authors,
  section,
  noIndex = false,
  titleAbsolute = false,
}: CreateMetadataOptions): Metadata {
  const canonical = absoluteUrl(path);
  const ogImage = absoluteUrl("/opengraph-image");
  const resolvedTitle = titleAbsolute ? title : title;
  const openGraphTitle = titleAbsolute ? title : `${title} | ${SITE.name}`;

  return {
    title: titleAbsolute ? { absolute: resolvedTitle } : resolvedTitle,
    description,
    keywords: keywords ?? [...SITE.keywords],
    alternates: {
      canonical,
    },
    openGraph: {
      type,
      locale: SITE.locale,
      url: canonical,
      siteName: SITE.name,
      title: openGraphTitle,
      description,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: `${SITE.name} — ${SITE.tagline}`,
        },
      ],
      ...(type === "article" && {
        publishedTime,
        modifiedTime: modifiedTime ?? publishedTime,
        authors,
        section,
      }),
    },
    twitter: {
      card: "summary_large_image",
      title: openGraphTitle,
      description,
      images: [ogImage],
      creator: SITE.twitterHandle,
    },
    robots: noIndex
      ? { index: false, follow: false }
      : {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
          },
        },
  };
}

export type JsonLd = Record<string, unknown>;

export function organizationJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: getSiteUrl(),
    logo: absoluteUrl("/icon.svg"),
    sameAs: [SITE.githubUrl],
    description: SITE.description,
  };
}

export function websiteJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: getSiteUrl(),
    description: SITE.description,
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: getSiteUrl(),
    },
  };
}

export function softwareApplicationJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE.name,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux, macOS",
    description: SITE.description,
    url: getSiteUrl(),
    downloadUrl: SITE.githubUrl,
    softwareVersion: "development",
    license: `https://spdx.org/licenses/${SITE.license}.html`,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

export function breadcrumbJsonLd(
  items: Array<{ name: string; path: string }>
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function articleJsonLd({
  title,
  description,
  path,
  publishedAt,
  modifiedAt,
  author,
}: {
  title: string;
  description: string;
  path: string;
  publishedAt: string;
  modifiedAt?: string;
  author: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: title,
    description,
    url: absoluteUrl(path),
    datePublished: publishedAt,
    dateModified: modifiedAt ?? publishedAt,
    author: {
      "@type": "Person",
      name: author,
    },
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: getSiteUrl(),
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/icon.svg"),
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": absoluteUrl(path),
    },
    image: absoluteUrl("/opengraph-image"),
  };
}

export function techArticleJsonLd({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: absoluteUrl(path),
    author: {
      "@type": "Organization",
      name: SITE.name,
      url: getSiteUrl(),
    },
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      url: getSiteUrl(),
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": absoluteUrl(path),
    },
  };
}