import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decisionSettingsPathForDiagnostics, readStoredDecisionSettings, resolveDecisionSettings, updateStoredDecisionSettings } from "./decisionSettings";

const dirs: string[] = [];
const original = {
  path: process.env.INTENT_WORLD_DECISION_SETTINGS_FILE,
  provider: process.env.SAKASAKA_DECISION_PROVIDER,
  key: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_DEFAULT_MODEL,
  legacyModel: process.env.TYPESAFE_JEV_MODEL,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (original.path === undefined) delete process.env.INTENT_WORLD_DECISION_SETTINGS_FILE; else process.env.INTENT_WORLD_DECISION_SETTINGS_FILE = original.path;
  if (original.provider === undefined) delete process.env.SAKASAKA_DECISION_PROVIDER; else process.env.SAKASAKA_DECISION_PROVIDER = original.provider;
  if (original.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = original.key;
  if (original.model === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL; else process.env.TYPESAFE_DEFAULT_MODEL = original.model;
  if (original.legacyModel === undefined) delete process.env.TYPESAFE_JEV_MODEL; else process.env.TYPESAFE_JEV_MODEL = original.legacyModel;
});

function isolate() {
  const dir = mkdtempSync(join(tmpdir(), "sakasaka-decision-settings-"));
  dirs.push(dir);
  process.env.INTENT_WORLD_DECISION_SETTINGS_FILE = join(dir, "decision-settings.json");
  delete process.env.SAKASAKA_DECISION_PROVIDER;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_DEFAULT_MODEL;
  delete process.env.TYPESAFE_JEV_MODEL;
}

describe("decision settings", () => {
  it("stores Jev credentials only in the dedicated local secret file", async () => {
    isolate();
    await updateStoredDecisionSettings({ provider: "hybrid", jevModel: "jev-latest", jevApiKey: "secret-test-key" });
    expect(readStoredDecisionSettings()?.jevApiKey).toBe("secret-test-key");
    const resolved = resolveDecisionSettings();
    expect(resolved.provider).toBe("hybrid");
    expect(resolved.source.apiKey).toBe("local");
    expect(JSON.stringify({ provider: resolved.provider, model: resolved.jevModel, source: resolved.source })).not.toContain("secret-test-key");
    const path = decisionSettingsPathForDiagnostics();
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("secret-test-key");
  });

  it("environment overrides local preferences without rewriting the stored key", async () => {
    isolate();
    await updateStoredDecisionSettings({ provider: "codex-cli", jevApiKey: "local-key" });
    process.env.SAKASAKA_DECISION_PROVIDER = "jev";
    process.env.TYPESAFE_API_KEY = "env-key";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-env";
    expect(resolveDecisionSettings()).toMatchObject({ provider: "jev", jevModel: "jev-env", jevApiKey: "env-key", source: { provider: "environment", model: "environment", apiKey: "environment" } });
    expect(readStoredDecisionSettings()?.jevApiKey).toBe("local-key");
  });

  it("clears the persisted key without preserving a backup copy", async () => {
    isolate();
    await updateStoredDecisionSettings({ provider: "jev", jevApiKey: "local-key" });
    await updateStoredDecisionSettings({ provider: "codex-cli", clearJevKey: true });
    expect(readStoredDecisionSettings()?.jevApiKey).toBeUndefined();
    expect(resolveDecisionSettings().source.apiKey).toBe("missing");
    expect(existsSync(`${decisionSettingsPathForDiagnostics()}.recover`)).toBe(false);
  });
});
