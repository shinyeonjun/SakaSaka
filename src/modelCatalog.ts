import type { ModelCatalogEntry } from "./types";

/** Provider metadata shared by the API catalog and the no-project UI. */
export const recommendedCodexModels: readonly ModelCatalogEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", group: "recommended" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "recommended" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "recommended" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "recommended" },
  { id: "gpt-daybreak-blue-latest", label: "Daybreak Blue", group: "recommended" },
  { id: "gpt-5.5", label: "GPT-5.5", group: "recommended" },
];

export function getRecommendedCodexModels(): ModelCatalogEntry[] {
  return recommendedCodexModels.map((model) => ({ ...model }));
}

export function labelForModelId(id: string): string {
  return recommendedCodexModels.find((model) => model.id === id)?.label ?? id;
}
