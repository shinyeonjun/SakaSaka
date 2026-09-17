import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredDecisionProvider, configuredTypeSafeApiKey, configuredTypeSafeModel, runtimeDecisionPublicConfig, updateRuntimeDecisionConfig } from "./runtimeDecisionConfig";

const roots: string[] = [];
const previous = {
  config: process.env.SAKASAKA_RUNTIME_CONFIG_FILE,
  provider: process.env.SAKASAKA_DECISION_PROVIDER,
  key: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_DEFAULT_MODEL,
  legacyModel: process.env.TYPESAFE_JEV_MODEL,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries({ SAKASAKA_RUNTIME_CONFIG_FILE: previous.config, SAKASAKA_DECISION_PROVIDER: previous.provider, TYPESAFE_API_KEY: previous.key, TYPESAFE_DEFAULT_MODEL: previous.model, TYPESAFE_JEV_MODEL: previous.legacyModel })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function useTemporaryConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "sakasaka-runtime-config-")); roots.push(root);
  const path = join(root, "runtime-config.json");
  process.env.SAKASAKA_RUNTIME_CONFIG_FILE = path;
  delete process.env.SAKASAKA_DECISION_PROVIDER;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_DEFAULT_MODEL;
  delete process.env.TYPESAFE_JEV_MODEL;
  return path;
}

describe("runtime decision config", () => {
  it("persists the key outside AppState and never returns it in public status", () => {
    const path = useTemporaryConfig();
    const status = updateRuntimeDecisionConfig({ provider: "hybrid", typesafeModel: "jev-latest", apiKey: "secret-test-key" });
    expect(status).toMatchObject({ provider: "hybrid", typesafeModel: "jev-latest", apiKeyConfigured: true, apiKeySource: "local-file" });
    expect(JSON.stringify(status)).not.toContain("secret-test-key");
    expect(configuredDecisionProvider()).toBe("hybrid");
    expect(configuredTypeSafeApiKey()).toBe("secret-test-key");
    expect(configuredTypeSafeModel()).toBe("jev-latest");
    expect(readFileSync(path, "utf8")).toContain("secret-test-key");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("clears only the local key and falls back to environment configuration", () => {
    useTemporaryConfig();
    process.env.TYPESAFE_API_KEY = "environment-key";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-env";
    updateRuntimeDecisionConfig({ provider: "jev", apiKey: "local-key", typesafeModel: "jev-local" });
    const status = updateRuntimeDecisionConfig({ clearApiKey: true, typesafeModel: "" });
    expect(status).toMatchObject({ provider: "jev", typesafeModel: "jev-env", apiKeyConfigured: true, apiKeySource: "environment" });
    expect(configuredTypeSafeApiKey()).toBe("environment-key");
  });

  it("rejects malformed provider, model, and newline-bearing keys", () => {
    useTemporaryConfig();
    expect(() => updateRuntimeDecisionConfig({ provider: "other" as never })).toThrow(/provider/);
    expect(() => updateRuntimeDecisionConfig({ typesafeModel: "bad model" })).toThrow(/model/);
    expect(() => updateRuntimeDecisionConfig({ apiKey: "bad\nkey" })).toThrow(/API key/);
    expect(runtimeDecisionPublicConfig().apiKeyConfigured).toBe(false);
  });
});
