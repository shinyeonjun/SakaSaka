/** Small browser-safe boundary for capabilities supplied by the Tauri shell. */
export const isDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DesktopDecisionSettingsStatus {
  provider: "codex-cli" | "jev" | "hybrid";
  jevModel: string;
  apiKeyConfigured: boolean;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isDesktopApp) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "프로젝트 작업 폴더 선택" });
  return typeof selected === "string" ? selected : null;
}

export async function getDesktopDecisionSettings(): Promise<DesktopDecisionSettingsStatus | undefined> {
  if (!isDesktopApp) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("decision_settings_status");
  const parsed = JSON.parse(raw) as Partial<DesktopDecisionSettingsStatus>;
  if ((parsed.provider !== "codex-cli" && parsed.provider !== "jev" && parsed.provider !== "hybrid") || typeof parsed.jevModel !== "string" || typeof parsed.apiKeyConfigured !== "boolean") throw new Error("데스크톱 decision 설정 응답이 올바르지 않습니다.");
  return parsed as DesktopDecisionSettingsStatus;
}

export async function saveDesktopDecisionSettings(input: {
  provider: DesktopDecisionSettingsStatus["provider"];
  jevModel: string;
  jevApiKey?: string;
  clearJevKey?: boolean;
}): Promise<DesktopDecisionSettingsStatus> {
  if (!isDesktopApp) throw new Error("데스크톱 앱에서만 로컬 Jev secret을 저장할 수 있습니다.");
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("save_decision_settings", {
    provider: input.provider,
    jevModel: input.jevModel,
    jevApiKey: input.jevApiKey?.trim() || null,
    clearJevKey: input.clearJevKey === true,
  });
  const parsed = JSON.parse(raw) as Partial<DesktopDecisionSettingsStatus>;
  if ((parsed.provider !== "codex-cli" && parsed.provider !== "jev" && parsed.provider !== "hybrid") || typeof parsed.jevModel !== "string" || typeof parsed.apiKeyConfigured !== "boolean") throw new Error("데스크톱 decision 설정 저장 결과가 올바르지 않습니다.");
  return parsed as DesktopDecisionSettingsStatus;
}
