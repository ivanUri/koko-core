import { createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Engineering notes",
  description:
    "Velora dev stories — bugs chased, benchmarks run, and assumptions overturned. Published from the knowledge/ folder in the Velora repository.",
  path: "/blog",
  keywords: [
    "Velora engineering blog",
    "browser runtime dev stories",
    "automation debugging",
    "CDP development notes",
  ],
});

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return children;
}