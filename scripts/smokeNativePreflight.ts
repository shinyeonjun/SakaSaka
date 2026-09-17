import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { asRecord, type AppServerClient, type RpcRecord } from "../server/codexAppServer";
import { redactSecretLikeText } from "../src/security";

export const expectedNativeBytes = Buffer.from("SakaSaka native", "utf8");

export type SmokePlatform = NodeJS.Platform;

export interface FileProbeResult {
  path: string;
  exists: boolean;
  regularFile: boolean;
  symlink: boolean;
  byteLength: number;
  contentMatches: boolean;
  error?: string;
}

export interface CommandProbeResult {
  status: "passed" | "failed" | "not-applicable";
  command: string;
  exitCode: number | null;
  outputMarker: boolean;
  stdout: string;
  stderr: string;
  passed: boolean;
  file?: FileProbeResult;
  error?: string;
}

export interface NativePreflightResult {
  windowsSandbox: { status: string; platform: SmokePlatform; detail?: string };
  executablesAndWorkspace: {
    node: CommandProbeResult;
    powershell: CommandProbeResult & { path: string };
    passed: boolean;
  };
  passed: boolean;
}

const clean = (value: unknown, max = 1_600): string => redactSecretLikeText(typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/g, " ").slice(0, max);
const sandboxPolicy = (workspace: string): RpcRecord => ({ type: "workspaceWrite", writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
const hasMarker = (value: unknown, marker: string): boolean => typeof value === "string" && value.split(/\r?\n/).some((line) => line.trim() === marker);

export function fileResult(path: string): FileProbeResult {
  try {
    const stat = lstatSync(path);
    const symlink = stat.isSymbolicLink();
    const bytes = !symlink && stat.isFile() ? readFileSync(path) : Buffer.alloc(0);
    return { path, exists: true, regularFile: stat.isFile() && !symlink, symlink, byteLength: bytes.byteLength, contentMatches: bytes.equals(expectedNativeBytes) };
  } catch (error) {
    return { path, exists: false, regularFile: false, symlink: false, byteLength: 0, contentMatches: false, error: clean(error instanceof Error ? error.message : error, 500) };
  }
}

function removeProbeFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() && stat.isFile()) unlinkSync(path);
  } catch { /* The unique probe file may already be absent. */ }
}

async function commandProbe(client: AppServerClient, workspace: string, command: string[], marker: string, target?: string): Promise<CommandProbeResult> {
  try {
    const response = asRecord(await client.request("command/exec", { command, cwd: workspace, timeoutMs: 10_000, sandboxPolicy: sandboxPolicy(workspace) }));
    const file = target ? fileResult(target) : undefined;
    const passed = (typeof response.exitCode === "number" ? response.exitCode : null) === 0 && hasMarker(response.stdout, marker) && (!file || file.contentMatches);
    return {
      status: passed ? "passed" : "failed",
      command: command[0] ?? "unknown",
      exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
      outputMarker: hasMarker(response.stdout, marker),
      stdout: clean(response.stdout, 500),
      stderr: clean(response.stderr, 800),
      ...(file ? { file } : {}),
      passed,
    };
  } catch (error) {
    return { status: "failed", command: command[0] ?? "unknown", exitCode: null, outputMarker: false, stdout: "", stderr: "", passed: false, error: clean(error instanceof Error ? error.message : error) };
  }
}

function powershellCandidates(): string[] {
  const env = process.env;
  return [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"),
    env.PROGRAMFILES && join(env.PROGRAMFILES, "PowerShell", "7", "pwsh.exe"),
    env.SYSTEMROOT && join(env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ].filter((path): path is string => Boolean(path));
}

export async function runModelFreePreflight(client: AppServerClient, workspace: string, platform: SmokePlatform = process.platform): Promise<NativePreflightResult["executablesAndWorkspace"]> {
  const fileName = `.sakasaka-native-preflight-${randomUUID()}.txt`;
  const target = join(workspace, fileName);
  const nodeCode = "const fs=require('node:fs');const file=process.argv[1];fs.writeFileSync(file,'SakaSaka native',{flag:'wx'});if(!fs.readFileSync(file).equals(Buffer.from('SakaSaka native','utf8')))process.exitCode=2;console.log('SAKASAKA_NODE_OK')";
  const node = await commandProbe(client, workspace, [process.execPath, "-e", nodeCode, fileName], "SAKASAKA_NODE_OK", target);
  const powershellPath = platform === "win32" ? powershellCandidates().find((path) => existsSync(path)) : undefined;
  const powershell = platform === "win32"
    ? powershellPath
      ? await commandProbe(client, workspace, [powershellPath, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('SAKASAKA_PWSH_OK')"], "SAKASAKA_PWSH_OK")
      : { status: "failed" as const, command: "powershell", exitCode: null, outputMarker: false, stdout: "", stderr: "", passed: false, error: "PowerShell 실행 파일을 찾지 못했습니다." }
    : { status: "not-applicable" as const, command: "powershell", exitCode: null, outputMarker: false, stdout: "", stderr: "", passed: true, error: "Windows가 아니므로 PowerShell 검사를 수행하지 않았습니다." };
  const result = { node, powershell: { path: powershellPath ?? (platform === "win32" ? "not-found" : "not-applicable"), ...powershell }, passed: node.passed && powershell.passed };
  removeProbeFile(target);
  return result;
}

export async function runNativePreflight(client: AppServerClient, workspace: string, platform: SmokePlatform = process.platform): Promise<NativePreflightResult> {
  let windowsSandbox: NativePreflightResult["windowsSandbox"];
  if (platform === "win32") {
    const readiness = asRecord(await client.request("windowsSandbox/readiness", {}));
    const status = typeof readiness.status === "string" ? readiness.status : "unknown";
    windowsSandbox = { status, platform, detail: clean(readiness.detail ?? readiness.message, 800) || undefined };
    if (status !== "ready") throw new Error(`Windows sandbox 준비 상태가 ready가 아닙니다: ${status}`);
  } else {
    windowsSandbox = { status: "not-applicable", platform, detail: "Windows 전용 sandbox readiness 검사를 수행하지 않았습니다." };
  }
  const executablesAndWorkspace = await runModelFreePreflight(client, workspace, platform);
  return { windowsSandbox, executablesAndWorkspace, passed: executablesAndWorkspace.passed };
}

export function shouldRunNativeModel(requested: boolean, preflight: Pick<NativePreflightResult, "passed">): boolean {
  return requested && preflight.passed;
}
