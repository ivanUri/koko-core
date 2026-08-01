import { gettingStartedPages } from "./getting-started";
import { coreConceptPages } from "./core-concepts";
import { protocolPages } from "./protocols";
import { sdkReferencePages } from "./sdk-reference";
import { benchmarkPages } from "./benchmarks";
import { developmentPages } from "./development";
import type { DocPage, DocPageMap } from "./types";

export type { DocPage };

export const DOC_PAGES: DocPageMap = {
  ...gettingStartedPages,
  ...coreConceptPages,
  ...protocolPages,
  ...sdkReferencePages,
  ...benchmarkPages,
  ...developmentPages,
};