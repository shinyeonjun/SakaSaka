import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RuntimeDecisionProvider = "codex-cli" | "jev" | "hybrid";

interface RuntimeDecisionFile {
  schemaVersion: 1;
  provider?: RuntimeDecisionProvider;
  typesafeApiKey?: string;
  typesafeModel?: string;
  updatedAt: string;
}

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

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const providers = new Set<RuntimeDecisionProvider>(["codex-cli", "jev", "hybrid"]);

export function runtimeDecisionConfigPath(): string {
  const explicit = process.env.SAKASAKA_RUNTIME_CONFIG_FILE?.trim();
  if (explicit) return resolve(explicit);
  const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
  return resolve(dirname(statePath), "runtime-config.json");
}

function safeProvider(value: unknown): RuntimeDecisionProvider | undefined {
  return typeof value === "string" && providers.has(value as RuntimeDecisionProvider) ? value as RuntimeDecisionProvider : undefined;
}

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return model && modelIdPattern.test(model) ? model : undefined;
}

function safeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (!key || key.length > 8_192 || key.includes("\0") || /[\r\n]/.test(key)) return undefined;
  return key;
}

function readFileConfig(): RuntimeDecisionFile | undefined {
  const path = runtimeDecisionConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeDecisionFile>;
    if (value.schemaVersion !== 1 || typeof value.updatedAt !== "string") return undefined;
    return {
      schemaVersion: 1,
      provider: safeProvider(value.provider),
      typesafeApiKey: safeApiKey(value.typesafeApiKey),
      typesafeModel: safeModel(value.typesafeModel),
      updatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function environmentProvider(): RuntimeDecisionProvider | undefined {
  return safeProvider(process.env.SAKASAKA_DECISION_PROVIDER?.trim().toLowerCase());
}

export function configuredDecisionProvider(): RuntimeDecisionProvider {
  return readFileConfig()?.provider ?? environmentProvider() ?? "codex-cli";
}

export function configuredTypeSafeApiKey(): string | undefined {
  return readFileConfig()?.typesafeApiKey ?? safeApiKey(process.env.TYPESAFE_API_KEY);
}

export function configuredTypeSafeModel(): string {
  return readFileConfig()?.typesafeModel ?? safeModel(process.env.TYPESAFE_DEFAULT_MODEL) ?? safeModel(process.env.TYPESAFE_JEV_MODEL) ?? "jev-latest";
}

export function runtimeDecisionPublicConfig(): RuntimeDecisionPublicConfig {
  const file = readFileConfig();
  const fileKey = file?.typesafeApiKey;
  const environmentKey = safeApiKey(process.env.TYPESAFE_API_KEY);
  return {
    provider: file?.provider ?? environmentProvider() ?? "codex-cli",
    typesafeModel: file?.typesafeModel ?? safeModel(process.env.TYPESAFE_DEFAULT_MODEL) ?? safeModel(process.env.TYPESAFE_JEV_MODEL) ?? "jev-latest",
    apiKeyConfigured: Boolean(fileKey ?? environmentKey),
    apiKeySource: fileKey ? "local-file" : environmentKey ? "environment" : "none",
    configPath: runtimeDecisionConfigPath(),
  };
}

function replaceConfigFile(path: string, temporary: string): void {
  if (process.platform !== "win32") {
    renameSync(temporary, path);
    return;
  }
  // Windows rename cannot reliably replace an existing file. Runtime config is
  // reconstructible, so remove the old secret file only after the new file is
  // fully written. This avoids keeping a stale secret backup after key rotation.
  if (existsSync(path)) rmSync(path, { force: true });
  renameSync(temporary, path);
}

export function updateRuntimeDecisionConfig(update: RuntimeDecisionConfigUpdate): RuntimeDecisionPublicConfig {
  const previous = readFileConfig();
  const provider = update.provider === undefined ? previous?.provider : safeProvider(update.provider);
  if (update.provider !== undefined && !provider) throw new Error("decision provider must be codex-cli, jev, or hybrid");

  let typesafeModel = previous?.typesafeModel;
  if (update.typesafeModel !== undefined) {
    const rawModel = update.typesafeModel.trim();
    if (rawModel && !modelIdPattern.test(rawModel)) throw new Error("TypeSafe model id is invalid");
    typesafeModel = rawModel || undefined;
  }

  let typesafeApiKey = previous?.typesafeApiKey;
  if (update.clearApiKey === true) typesafeApiKey = undefined;
  if (update.apiKey !== undefined) {
    const rawKey = update.apiKey.trim();
    if (rawKey) {
      const key = safeApiKey(rawKey);
      if (!key) throw new Error("TypeSafe API key is invalid");
      typesafeApiKey = key;
    }
  }

  const path = runtimeDecisionConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const next: RuntimeDecisionFile = { schemaVersion: 1, provider, typesafeApiKey, typesafeModel, updatedAt: new Date().toISOString() };
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    replaceConfigFile(path, temporary);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return runtimeDecisionPublicConfig();
}
