import type { JsonLd } from "@/lib/seo";

type JsonLdScriptProps = {
  data: JsonLd | JsonLd[];
};

export function JsonLdScript({ data }: JsonLdScriptProps) {
  const payload = Array.isArray(data) ? data : [data];

  return (
    <>
      {payload.map((item, index) => (
        <script
          key={`${String(item["@type"])}-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(item) }}
        />
      ))}
    </>
  );
}