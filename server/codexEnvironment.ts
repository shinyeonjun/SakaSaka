import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "./commandRunner";
import { redactSecretLikeText } from "../src/security";

export type CodexAuthState = "verified" | "missing" | "unknown";
export type CodexAuthMethod = "chatgpt" | "api-key" | "agent-identity" | "unknown";

export interface CodexEnvironmentStatus {
  installed: boolean;
  binary: string;
  version?: string;
  authState: CodexAuthState;
  authMethod?: CodexAuthMethod;
  codexHome: string;
  persistent: boolean;
  detail: string;
}

const shortTimeoutMs = 8_000;
const installTimeoutMs = 180_000;
const maxOutputBytes = 64 * 1024;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function configuredBinary(): string {
  return process.env.CODEX_CLI_BIN?.trim() || "codex";
}

function safeEnvironment(): NodeJS.ProcessEnv {
  // Authentication is owned by Codex's persistent credential store. Avoid
  // injecting unrelated application secrets into diagnostic/login children.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:MODEL_API_KEY|TYPESAFE_API_KEY|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|REDIS_URL)/i.test(key)));
}

function shellSafeArg(value: string): boolean {
  return /^[A-Za-z0-9._:/=@+-]+$/.test(value);
}

async function runCodex(args: readonly string[], timeoutMs = shortTimeoutMs): Promise<CommandResult> {
  const configured = process.env.CODEX_CLI_BIN?.trim();
  if (configured) {
    return runCommand(configured, args, { cwd: process.cwd(), env: safeEnvironment(), timeoutMs, maxBytes: maxOutputBytes });
  }
  if (process.platform === "win32") {
    if (args.some((arg) => !shellSafeArg(arg))) return { code: 1, stdout: "", stderr: "Codex 명령 인자가 안전하지 않습니다." };
    // npm global installs expose `codex.cmd` through PATHEXT. Running through
    // cmd.exe is required because .cmd shims are not Win32 executables.
    return runCommand("cmd.exe", ["/D", "/S", "/C", `codex ${args.join(" ")}`], { cwd: process.cwd(), env: safeEnvironment(), timeoutMs, maxBytes: maxOutputBytes });
  }
  return runCommand("codex", args, { cwd: process.cwd(), env: safeEnvironment(), timeoutMs, maxBytes: maxOutputBytes });
}

export function parseCodexLoginSummary(raw: string): { state: CodexAuthState; method?: CodexAuthMethod } {
  const summary = raw.replace(/\s+/g, " ").trim();
  if (/not\s+logged\s+in/i.test(summary)) return { state: "missing" };
  if (/logged\s+in\s+using\s+chatgpt/i.test(summary)) return { state: "verified", method: "chatgpt" };
  if (/logged\s+in\s+using\s+(?:an\s+)?api\s+key/i.test(summary)) return { state: "verified", method: "api-key" };
  if (/logged\s+in\s+using\s+agent\s+identity/i.test(summary)) return { state: "verified", method: "agent-identity" };
  if (/logged\s+in/i.test(summary)) return { state: "verified", method: "unknown" };
  return { state: "unknown" };
}

function cleanOutput(result: CommandResult): string {
  return redactSecretLikeText(`${result.stdout}\n${result.stderr}`).replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function inspectCodexEnvironment(): Promise<CodexEnvironmentStatus> {
  const binary = configuredBinary();
  const home = codexHome();
  const versionResult = await runCodex(["--version"]);
  if (versionResult.code !== 0) {
    return {
      installed: false,
      binary,
      authState: "missing",
      codexHome: home,
      persistent: false,
      detail: "Codex CLI를 찾지 못했습니다. 설치 후 한 번만 로그인하면 이후 실행에서는 Codex의 기존 인증을 재사용합니다.",
    };
  }

  const version = cleanOutput(versionResult) || undefined;
  const loginResult = await runCodex(["login", "status"]);
  const login = parseCodexLoginSummary(cleanOutput(loginResult));
  if (login.state === "verified") {
    const methodLabel = login.method === "chatgpt" ? "ChatGPT" : login.method === "api-key" ? "API key" : login.method === "agent-identity" ? "Agent Identity" : "Codex";
    return {
      installed: true,
      binary,
      version,
      authState: "verified",
      authMethod: login.method,
      codexHome: home,
      persistent: true,
      detail: `${methodLabel} 로그인이 준비되어 있습니다. SakaSaka는 인증 토큰을 복사하지 않고 Codex가 관리하는 로그인 저장소를 그대로 재사용합니다.`,
    };
  }

  return {
    installed: true,
    binary,
    version,
    authState: login.state === "missing" ? "missing" : "unknown",
    codexHome: home,
    persistent: false,
    detail: login.state === "missing"
      ? "Codex CLI는 설치되어 있지만 로그인이 필요합니다. 로그인은 Codex 자체 창에서 진행되며 SakaSaka에 비밀번호나 토큰이 저장되지 않습니다."
      : "Codex CLI는 설치되어 있지만 로그인 상태를 확정하지 못했습니다. 다시 확인하거나 Codex 로그인을 진행하세요.",
  };
}

export async function installCodexCli(): Promise<CodexEnvironmentStatus> {
  if (process.env.DESKTOP_MODE?.trim().toLowerCase() !== "true") throw new Error("Codex 자동 설치는 데스크톱 모드에서만 허용됩니다.");
  const current = await inspectCodexEnvironment();
  if (current.installed) return current;
  const result = await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", "@openai/codex@latest"], {
    cwd: process.cwd(),
    env: safeEnvironment(),
    timeoutMs: installTimeoutMs,
    maxBytes: 512 * 1024,
  });
  if (result.code !== 0) {
    const detail = cleanOutput(result) || "npm 전역 설치에 실패했습니다.";
    throw new Error(`Codex CLI 설치 실패: ${detail}`);
  }
  const status = await inspectCodexEnvironment();
  if (!status.installed) throw new Error("설치는 완료됐지만 현재 앱 프로세스에서 Codex CLI를 찾지 못했습니다. 앱을 다시 시작하거나 PATH를 확인하세요.");
  return status;
}

function detachedTerminal(command: string): void {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/D", "/S", "/C", "start", "", "cmd.exe", "/K", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: safeEnvironment(),
    });
    child.unref();
    return;
  }
  if (process.platform === "darwin") {
    const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const child = spawn("osascript", ["-e", `tell application \"Terminal\" to do script \"${escaped}\"`], { detached: true, stdio: "ignore", env: safeEnvironment() });
    child.unref();
    return;
  }
  const child = spawn("x-terminal-emulator", ["-e", "sh", "-lc", `${command}; printf '\\n로그인이 끝났으면 이 창을 닫아도 됩니다.\\n'; exec sh`], {
    detached: true,
    stdio: "ignore",
    env: safeEnvironment(),
  });
  child.unref();
}

export async function startCodexLogin(method: "browser" | "device"): Promise<CodexEnvironmentStatus> {
  if (process.env.DESKTOP_MODE?.trim().toLowerCase() !== "true") throw new Error("Codex 로그인 UX는 데스크톱 모드에서만 허용됩니다.");
  const status = await inspectCodexEnvironment();
  if (!status.installed) throw new Error("먼저 Codex CLI를 설치하세요.");
  const binary = process.env.CODEX_CLI_BIN?.trim() || "codex";
  if (!shellSafeArg(binary) && !process.env.CODEX_CLI_BIN) throw new Error("Codex 실행 파일 경로를 확인할 수 없습니다.");
  const command = method === "device" ? `${binary} login --device-auth` : `${binary} login`;
  detachedTerminal(command);
  return {
    ...status,
    detail: method === "device"
      ? "Codex 기기 코드 로그인 터미널을 열었습니다. 터미널의 안내를 완료한 뒤 이 화면에서 다시 확인하세요."
      : "Codex 로그인 터미널을 열었습니다. 브라우저에서 ChatGPT 로그인을 완료하면 Codex가 인증을 자체 저장하고 이후 SakaSaka 실행에서 재사용합니다.",
  };
}

export async function logoutCodex(): Promise<CodexEnvironmentStatus> {
  if (process.env.DESKTOP_MODE?.trim().toLowerCase() !== "true") throw new Error("Codex 로그아웃은 데스크톱 모드에서만 허용됩니다.");
  const current = await inspectCodexEnvironment();
  if (!current.installed) return current;
  const result = await runCodex(["logout"]);
  if (result.code !== 0) throw new Error(`Codex 로그아웃 실패: ${cleanOutput(result) || "codex logout 실패"}`);
  return inspectCodexEnvironment();
}
