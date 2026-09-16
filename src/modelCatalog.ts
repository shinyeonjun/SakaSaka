import type { ModelCatalogEntry } from "./types";

/**
 * The Codex CLI does not expose a portable `models` discovery command. These
 * are selectable product defaults, not evidence that every account is
 * entitled to every model. The server catalog can extend or replace them via
 * CODEX_CLI_MODELS, and the first real model turn remains the source of truth.
 */
export const recommendedCodexModels: readonly ModelCatalogEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", group: "recommended" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "recommended" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "recommended" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "recommended" },
  { id: "gpt-daybreak-blue-latest", label: "Daybreak Blue", group: "recommended" },
  { id: "gpt-5.5", label: "GPT-5.5", group: "recommended" },
] as const;

export function getRecommendedCodexModels(): ModelCatalogEntry[] {
  return recommendedCodexModels.map((model) => ({ ...model }));
}

export function labelForModelId(id: string): string { return id; }
