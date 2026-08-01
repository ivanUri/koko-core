export type DocPage = {
  slug: string;
  title: string;
  description: string;
  categoryId: number;
  content: string;
};

export type DocPageMap = Record<string, DocPage>;