import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "./fileLock";

export type DecisionProviderPreference = "codex-cli" | "jev" | "hybrid";

export interface StoredDecisionSettings {
  version: 1;
  provider: DecisionProviderPreference;
  jevModel: string;
  jevApiKey?: string;
  updatedAt: string;
}

export interface ResolvedDecisionSettings {
  provider: DecisionProviderPreference;
  jevModel: string;
  jevApiKey?: string;
  source: {
    provider: "environment" | "local" | "default";
    model: "environment" | "local" | "default";
    apiKey: "environment" | "local" | "missing";
  };
}

export interface DecisionSettingsUpdate {
  provider?: DecisionProviderPreference;
  jevModel?: string;
  jevApiKey?: string;
  clearJevKey?: boolean;
}

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function settingsPath(): string {
  const explicit = process.env.INTENT_WORLD_DECISION_SETTINGS_FILE?.trim();
  if (explicit) return resolve(explicit);
  const statePath = resolve(process.cwd(), process.env.INTENT_WORLD_STATE_FILE ?? ".data/state.json");
  return resolve(dirname(statePath), "decision-settings.json");
}

function lockPath(): string { return `${settingsPath()}.lock`; }
function recoveryPath(): string { return `${settingsPath()}.recover`; }

function isProvider(value: unknown): value is DecisionProviderPreference {
  return value === "codex-cli" || value === "jev" || value === "hybrid";
}

function safeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 4096 && !/[\r\n\0]/.test(key) ? key : undefined;
}

function validStored(value: unknown): value is StoredDecisionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredDecisionSettings>;
  return record.version === 1 && isProvider(record.provider) && typeof record.jevModel === "string" && modelIdPattern.test(record.jevModel) && typeof record.updatedAt === "string" && (record.jevApiKey === undefined || safeApiKey(record.jevApiKey) !== undefined);
}

function readJson(path: string): StoredDecisionSettings | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return validStored(value) ? value : undefined;
  } catch { return undefined; }
}

export function readStoredDecisionSettings(): StoredDecisionSettings | undefined {
  return readJson(settingsPath()) ?? readJson(recoveryPath());
}

function secureWrite(value: StoredDecisionSettings): void {
  const target = settingsPath();
  const recovery = recoveryPath();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* advisory on some Windows filesystems */ }
  let movedExisting = false;
  try {
    if (existsSync(recovery)) rmSync(recovery, { force: true });
    if (existsSync(target)) {
      renameSync(target, recovery);
      movedExisting = true;
      try { chmodSync(recovery, 0o600); } catch { /* best effort */ }
    }
    renameSync(temporary, target);
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
    if (movedExisting && existsSync(recovery)) rmSync(recovery, { force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(recovery)) {
      try { renameSync(recovery, target); } catch { /* read fallback keeps recovery usable */ }
    }
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
}

export async function updateStoredDecisionSettings(update: DecisionSettingsUpdate): Promise<StoredDecisionSettings> {
  return withFileLock(lockPath(), () => {
    const current = readStoredDecisionSettings() ?? { version: 1 as const, provider: "codex-cli" as const, jevModel: "jev-latest", updatedAt: new Date(0).toISOString() };
    const provider = update.provider ?? current.provider;
    if (!isProvider(provider)) throw new Error("decision provider is not supported");
    const model = (update.jevModel ?? current.jevModel).trim();
    if (!modelIdPattern.test(model)) throw new Error("Jev model must be a safe model id with at most 128 characters");
    const next: StoredDecisionSettings = { ...current, provider, jevModel: model, updatedAt: new Date().toISOString() };
    if (update.clearJevKey) delete next.jevApiKey;
    else if (update.jevApiKey !== undefined) {
      const key = safeApiKey(update.jevApiKey);
      if (!key) throw new Error("Jev API key is invalid");
      next.jevApiKey = key;
    }
    secureWrite(next);
    return next;
  });
}

function envProvider(): DecisionProviderPreference | undefined {
  const value = process.env.SAKASAKA_DECISION_PROVIDER?.trim().toLowerCase();
  return isProvider(value) ? value : undefined;
}

function envModel(): string | undefined {
  const value = process.env.TYPESAFE_DEFAULT_MODEL?.trim() || process.env.TYPESAFE_JEV_MODEL?.trim();
  return value && modelIdPattern.test(value) ? value : undefined;
}

export function resolveDecisionSettings(): ResolvedDecisionSettings {
  const stored = readStoredDecisionSettings();
  const providerFromEnv = envProvider();
  const modelFromEnv = envModel();
  const keyFromEnv = safeApiKey(process.env.TYPESAFE_API_KEY);
  return {
    provider: providerFromEnv ?? stored?.provider ?? "codex-cli",
    jevModel: modelFromEnv ?? stored?.jevModel ?? "jev-latest",
    jevApiKey: keyFromEnv ?? stored?.jevApiKey,
    source: {
      provider: providerFromEnv ? "environment" : stored ? "local" : "default",
      model: modelFromEnv ? "environment" : stored ? "local" : "default",
      apiKey: keyFromEnv ? "environment" : stored?.jevApiKey ? "local" : "missing",
    },
  };
}

export function decisionSettingsPathForDiagnostics(): string { return settingsPath(); }
