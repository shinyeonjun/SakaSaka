import type { ModelCatalogEntry } from "./types";

/** No static recommendation is evidence that the connected account supports a model. */
export const recommendedCodexModels: readonly ModelCatalogEntry[] = [];
export function getRecommendedCodexModels(): ModelCatalogEntry[] { return []; }
export function labelForModelId(id: string): string { return id; }
