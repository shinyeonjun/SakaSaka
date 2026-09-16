import type { ModelProvider } from "./types";

export interface UserPreferences {
  modelProvider: ModelProvider;
  modelName?: string;
}

const STORAGE_KEY = "intent-world-agent-preferences-v1";
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const providers: ModelProvider[] = ["auto", "deterministic", "openai-compatible", "codex-cli"];

export const defaultUserPreferences: UserPreferences = { modelProvider: "auto" };

function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && providers.includes(value as ModelProvider);
}

export function loadUserPreferences(): UserPreferences {
  if (typeof window === "undefined") return defaultUserPreferences;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<UserPreferences> | null;
    if (!parsed || !isModelProvider(parsed.modelProvider)) return defaultUserPreferences;
    const modelName = typeof parsed.modelName === "string" && modelIdPattern.test(parsed.modelName.trim()) ? parsed.modelName.trim() : undefined;
    return { modelProvider: parsed.modelProvider, modelName };
  } catch {
    return defaultUserPreferences;
  }
}

export function saveUserPreferences(preferences: UserPreferences): void {
  if (typeof window === "undefined") return;
  const modelName = preferences.modelName?.trim();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      modelProvider: preferences.modelProvider,
      modelName: modelName && modelIdPattern.test(modelName) ? modelName : undefined,
    } satisfies UserPreferences));
  } catch {
    // Browser storage can be disabled; project creation still carries its own settings.
  }
}
