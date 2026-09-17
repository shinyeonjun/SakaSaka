/** Small browser-safe boundary for capabilities supplied by the Tauri shell. */
export const isDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DesktopDecisionSettingsStatus {
  provider: "codex-cli" | "jev" | "hybrid";
  jevModel: string;
  apiKeyConfigured: boolean;
}

export interface DesktopCodexEnvironmentStatus {
  installed: boolean;
  binary: string;
  version?: string;
  authState: "verified" | "missing" | "unknown";
  authMethod?: "chatgpt" | "api-key" | "agent-identity" | "unknown";
  codexHome: string;
  persistent: boolean;
  detail: string;
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

function parseCodexEnvironment(raw: string): DesktopCodexEnvironmentStatus {
  const value = JSON.parse(raw) as Partial<DesktopCodexEnvironmentStatus>;
  if (typeof value.installed !== "boolean" || typeof value.binary !== "string" || typeof value.codexHome !== "string" || typeof value.persistent !== "boolean" || typeof value.detail !== "string") {
    throw new Error("Codex 실행 환경 상태 응답이 올바르지 않습니다.");
  }
  if (value.authState !== "verified" && value.authState !== "missing" && value.authState !== "unknown") throw new Error("Codex 인증 상태 응답이 올바르지 않습니다.");
  return value as DesktopCodexEnvironmentStatus;
}

/** Reads only non-secret Codex installation/login metadata from the desktop shell. */
export async function getDesktopCodexEnvironment(): Promise<DesktopCodexEnvironmentStatus | undefined> {
  if (!isDesktopApp) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return parseCodexEnvironment(await invoke<string>("codex_environment_status"));
}

/** User-triggered installation of the official @openai/codex CLI package. */
export async function installDesktopCodexCli(): Promise<DesktopCodexEnvironmentStatus> {
  if (!isDesktopApp) throw new Error("Codex CLI 자동 설치는 데스크톱 앱에서만 사용할 수 있습니다.");
  const { invoke } = await import("@tauri-apps/api/core");
  return parseCodexEnvironment(await invoke<string>("install_codex_cli"));
}

/**
 * Starts Codex's own login flow. SakaSaka never receives or stores the token.
 * Codex persists the authenticated session in its normal CODEX_HOME/keyring.
 */
export async function startDesktopCodexLogin(method: "browser" | "device" = "browser"): Promise<void> {
  if (!isDesktopApp) throw new Error("Codex 로그인 준비는 데스크톱 앱에서만 사용할 수 있습니다.");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("start_codex_login", { method });
}

export async function logoutDesktopCodex(): Promise<DesktopCodexEnvironmentStatus> {
  if (!isDesktopApp) throw new Error("Codex 로그아웃은 데스크톱 앱에서만 사용할 수 있습니다.");
  const { invoke } = await import("@tauri-apps/api/core");
  return parseCodexEnvironment(await invoke<string>("codex_logout"));
}
