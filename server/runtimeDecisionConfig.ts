import {
  decisionSettingsPathForDiagnostics,
  resolveDecisionSettings,
  updateStoredDecisionSettings,
  type DecisionProviderPreference,
} from "./decisionSettings";

/** Compatibility facade for CLI/DecisionGateway callers. The only durable secret store is decisionSettings.ts. */
export type RuntimeDecisionProvider = DecisionProviderPreference;

export interface RuntimeDecisionPublicConfig {
  provider: RuntimeDecisionProvider;
  typesafeModel: string;
  apiKeyConfigured: boolean;
  apiKeySource: "local-file" | "environment" | "none";
  configPath: string;
}

export interface RuntimeDecisionConfigUpdate {
  provider?: RuntimeDecisionProvider;
  typesafeModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export function runtimeDecisionConfigPath(): string {
  return decisionSettingsPathForDiagnostics();
}

export function configuredDecisionProvider(): RuntimeDecisionProvider {
  return resolveDecisionSettings().provider;
}

export function configuredTypeSafeApiKey(): string | undefined {
  return resolveDecisionSettings().jevApiKey;
}

export function configuredTypeSafeModel(): string {
  return resolveDecisionSettings().jevModel;
}

export function runtimeDecisionPublicConfig(): RuntimeDecisionPublicConfig {
  const resolved = resolveDecisionSettings();
  return {
    provider: resolved.provider,
    typesafeModel: resolved.jevModel,
    apiKeyConfigured: Boolean(resolved.jevApiKey),
    apiKeySource: resolved.source.apiKey === "local" ? "local-file" : resolved.source.apiKey === "environment" ? "environment" : "none",
    configPath: decisionSettingsPathForDiagnostics(),
  };
}

export async function updateRuntimeDecisionConfig(update: RuntimeDecisionConfigUpdate): Promise<RuntimeDecisionPublicConfig> {
  await updateStoredDecisionSettings({
    provider: update.provider,
    jevModel: update.typesafeModel,
    jevApiKey: update.apiKey,
    clearJevKey: update.clearApiKey,
  });
  return runtimeDecisionPublicConfig();
}
