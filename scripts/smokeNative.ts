import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CodexAppServer, asRecord, checkNativeConfig, type AppServerClient, type RpcRecord } from "../server/codexAppServer";
import { createProject, getProject, getRun } from "../src/runtime";
import { createEmptyState } from "../src/emptyState";
import { inspectCheckpoint, resolveCheckpointReferences } from "../src/nativeSession";
import type { NativeSession } from "../src/nativeSession";
import type { ModelFailure } from "../src/modelFailure";
import { redactSecretLikeText } from "../src/security";
import { runNativeEpisode } from "../server/nativeRuntime";
import { inspectCodexCli } from "../server/codexCliGateway";

const args = new Set(process.argv.slice(2));
if ([...args].some((a) => a !== "--run" && a !== "--keep")) throw new Error("사용법: npm run smoke:native -- [--run] [--keep]");
const dedicatedCodexHome = process.env.SAKASAKA_CODEX_HOME?.trim();
if (dedicatedCodexHome) process.env.CODEX_HOME = dedicatedCodexHome;

const expectedBytes = Buffer.from("SakaSaka native", "utf8");
const clean = (value: unknown, max = 1_600): string => redactSecretLikeText(typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/g, " ").slice(0, max);
const sandboxPolicy = (workspace: string): RpcRecord => ({ type: "workspaceWrite", writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
const hasMarker = (value: unknown, marker: string): boolean => typeof value === "string" && value.split(/\r?\n/).some((line) => line.trim() === marker);

function fileResult(path: string) {
  try {
    const stat = lstatSync(path);
    const symlink = stat.isSymbolicLink();
    const bytes = !symlink && stat.isFile() ? readFileSync(path) : Buffer.alloc(0);
    return { path, exists: true, regularFile: stat.isFile() && !symlink, symlink, byteLength: bytes.byteLength, contentMatches: bytes.equals(expectedBytes) };
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

async function commandProbe(client: AppServerClient, workspace: string, command: string[], marker: string, target?: string) {
  try {
    const response = asRecord(await client.request("command/exec", { command, cwd: workspace, timeoutMs: 10_000, sandboxPolicy: sandboxPolicy(workspace) }));
    const file = target ? fileResult(target) : undefined;
    const result = {
      command: command[0], exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
      outputMarker: hasMarker(response.stdout, marker), stdout: clean(response.stdout, 500), stderr: clean(response.stderr, 800),
      ...(file ? { file } : {}),
    };
    return { ...result, passed: result.exitCode === 0 && result.outputMarker && (!file || file.contentMatches) };
  } catch (error) {
    return { command: command[0], exitCode: null, outputMarker: false, stdout: "", stderr: "", passed: false, error: clean(error instanceof Error ? error.message : error) };
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

async function runModelFreePreflight(client: AppServerClient, workspace: string) {
  const fileName = `.sakasaka-native-preflight-${randomUUID()}.txt`;
  const target = join(workspace, fileName);
  const nodeCode = "const fs=require('node:fs');const file=process.argv[1];fs.writeFileSync(file,'SakaSaka native',{flag:'wx'});if(!fs.readFileSync(file).equals(Buffer.from('SakaSaka native','utf8')))process.exitCode=2;console.log('SAKASAKA_NODE_OK')";
  const node = await commandProbe(client, workspace, [process.execPath, "-e", nodeCode, fileName], "SAKASAKA_NODE_OK", target);
  const powershellPath = powershellCandidates().find((path) => existsSync(path));
  const powershell = powershellPath
    ? await commandProbe(client, workspace, [powershellPath, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('SAKASAKA_PWSH_OK')"], "SAKASAKA_PWSH_OK")
    : { command: "powershell", exitCode: null, outputMarker: false, stdout: "", stderr: "", passed: false, error: "PowerShell 실행 파일을 찾지 못했습니다." };
  const result = { node, powershell: { path: powershellPath ?? "not-found", ...powershell }, passed: node.passed && powershell.passed };
  removeProbeFile(target);
  return result;
}

function failureView(failure: ModelFailure | undefined) {
  return failure ? { code: failure.code, retryable: failure.retryable, message: clean(failure.message, 4_000), rawRef: failure.rawRef ? clean(failure.rawRef, 500) : undefined } : null;
}

function usageView(native: NativeSession | undefined) {
  return native ? { totalTokens: native.accountedTokens, inputTokens: native.accountedInputTokens, cachedInputTokens: native.accountedCachedInputTokens ?? 0, outputTokens: native.accountedOutputTokens } : null;
}
let diagnosticsRoot: string | undefined;
let retainDiagnostics = args.has("--keep");

async function main(): Promise<void> {
  const diagnostics = await inspectCodexCli();
  const dedicatedHomeReport = dedicatedCodexHome
    ? { path: dedicatedCodexHome, absolute: isAbsolute(dedicatedCodexHome), exists: existsSync(dedicatedCodexHome), configExists: existsSync(join(dedicatedCodexHome, "config.toml")) }
    : { path: "not-configured", absolute: false, exists: false, configExists: false };
  console.log(JSON.stringify({ stage: "cli", ...diagnostics, dedicatedCodexHome: dedicatedHomeReport }, null, 2));
  if (!diagnostics.installed) {
    process.exitCode = 1;
    console.log(JSON.stringify({ stage: "model", requested: args.has("--run"), status: "not-run", reason: "codex-not-installed" }, null, 2));
    return;
  }
  if (!dedicatedCodexHome || !dedicatedHomeReport.absolute || !dedicatedHomeReport.exists || !dedicatedHomeReport.configExists) {
    process.exitCode = 1;
    console.log(JSON.stringify({ stage: "preflight", status: "failed", error: "SakaSaka 전용 SAKASAKA_CODEX_HOME과 config.toml을 확인하지 못했습니다. 기본 사용자 CODEX_HOME으로 폴백하지 않습니다." }, null, 2));
    return;
  }
  if (args.has("--run") && !["verified", "configured"].includes(diagnostics.authentication)) {
    process.exitCode = 1;
    console.log(JSON.stringify({ stage: "model", requested: true, status: "not-run", reason: "authentication-not-verified" }, null, 2));
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "sakasaka-native-smoke-"));
  diagnosticsRoot = root;
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  process.env.WORKSPACE_ROOT = root;
  process.env.INTENT_WORLD_RAW_DIR = join(root, "raw");
  let appServerReport: Record<string, unknown> = { status: "not-started" };
  let readinessReport: Record<string, unknown> = { status: "not-run" };
  let shellPolicyReport: Record<string, unknown> = { expected: "core", reported: "not-reported", status: "not-run" };
  const client = new CodexAppServer({ cwd: workspace });
  try {
    await client.start();
    const result = asRecord(await client.request("config/read", { includeLayers: false }));
    const config = asRecord(result.config);
    const inherit = asRecord(config.shell_environment_policy).inherit;
    shellPolicyReport = { expected: "core", reported: typeof inherit === "string" ? inherit : "not-reported", status: inherit === "core" ? "verified" : "not-reported" };
    const blocked = !result.config || typeof result.config !== "object" || Array.isArray(result.config) ? "실제 Codex 설정을 확인하지 못했습니다." : checkNativeConfig(config);
    appServerReport = { status: blocked ? "failed" : "ready", configContract: blocked ? "failed" : "verified", error: blocked ?? undefined };
    if (blocked) throw new Error(blocked);
    if (inherit !== "core") throw new Error("Codex App Server의 실제 shell_environment_policy.inherit가 core가 아닙니다.");
    const readiness = asRecord(await client.request("windowsSandbox/readiness", {}));
    readinessReport = { status: typeof readiness.status === "string" ? readiness.status : "unknown", detail: clean(readiness.detail ?? readiness.message, 800) || undefined };
    if (readiness.status !== "ready") throw new Error(`Windows sandbox 준비 상태가 ready가 아닙니다: ${String(readiness.status ?? "unknown")}`);
    const preflight = await runModelFreePreflight(client, workspace);
    console.log(JSON.stringify({ stage: "preflight", appServer: appServerReport, shellEnvironmentPolicy: shellPolicyReport, windowsSandbox: readinessReport, executablesAndWorkspace: preflight }, null, 2));
    if (!preflight.passed) {
      retainDiagnostics = true;
      process.exitCode = 1;
      console.log(JSON.stringify({ stage: "model", requested: args.has("--run"), status: "not-run", reason: "model-free-preflight-failed", diagnostics: root }, null, 2));
      return;
    }
  } catch (error) {
    retainDiagnostics = true;
    process.exitCode = 1;
    console.log(JSON.stringify({ stage: "preflight", appServer: appServerReport, shellEnvironmentPolicy: shellPolicyReport, windowsSandbox: readinessReport, status: "failed", error: clean(error instanceof Error ? error.message : error), diagnostics: root }, null, 2));
    return;
  } finally {
    await client.close();
  }

  if (!args.has("--run")) {
    console.log(JSON.stringify({ stage: "model", requested: false, status: "not-run", reason: "preflight-only", diagnostics: root }, null, 2));
    return;
  }

  let state = createProject(createEmptyState(), "이 임시 테스트 폴더에 native-smoke.txt를 만들고 내용에 SakaSaka native를 정확히 기록한 뒤 다시 읽어 확인해 주세요. 외부 네트워크나 패키지는 필요 없습니다. 확인한 결과를 checkpoint로 보고해 주세요.", "native-smoke", { workspacePath: workspace, executionMode: "native", modelProvider: "codex-cli", modelName: process.env.CODEX_CLI_MODEL?.trim() || undefined, maxNativeTurns: 1, maxNativeTokens: 50_000, nativeTurnTimeoutMs: 90_000 });
  let runAccepted = false;
  let runError: string | undefined;
  const store = { read: () => state, transact: (update: (value: typeof state) => typeof state) => { state = update(state); return Promise.resolve(state); } };
  try {
    runAccepted = await runNativeEpisode(store, "native-smoke");
  } catch (error) {
    runError = clean(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  const project = getProject(state, "native-smoke");
  const run = getRun(state, "native-smoke");
  const native = run?.nativeSession;
  const outputFile = fileResult(join(workspace, "native-smoke.txt"));
  const checkpoint = inspectCheckpoint(native?.lastMessage ?? "");
  const checkpointReferences = checkpoint.checkpoint ? resolveCheckpointReferences(state, "native-smoke", checkpoint.checkpoint, workspace) : [];
  const referencePass = checkpointReferences.every((reference) => reference.status === "resolved" || reference.status === "unverified");
  const modelPassed = runAccepted && !runError && project?.status === "EQUILIBRIUM" && run?.status === "EQUILIBRIUM" && outputFile.contentMatches && Boolean(checkpoint.checkpoint) && referencePass;
  if (!modelPassed) retainDiagnostics = true;
  console.log(JSON.stringify({
    stage: "model", requested: true, accepted: runAccepted, status: modelPassed ? "passed" : "failed", error: runError,
    execution: { projectStatus: project?.status ?? "unknown", runStatus: run?.status ?? "unknown", phase: run?.phase ?? "unknown", nativeState: native?.state ?? "unknown", stopReason: run?.stopReason, lastModelFailure: failureView(run?.lastModelFailure) },
    file: outputFile,
    checkpoint: { structure: checkpoint.checkpoint ? "valid" : "invalid", reason: checkpoint.reason, disposition: checkpoint.checkpoint?.disposition, stored: Boolean(native?.checkpoint), references: checkpointReferences },
    usage: usageView(native), diagnostics: { root, statePath, rawRef: native?.rawRef, retained: retainDiagnostics },
  }, null, 2));
  if (!modelPassed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ stage: "fatal", error: clean(error instanceof Error ? error.message : error), diagnostics: diagnosticsRoot }, null, 2));
  retainDiagnostics = true;
} finally {
  if (diagnosticsRoot && retainDiagnostics) console.log(`진단 기록 보관 경로: ${diagnosticsRoot}`);
  else if (diagnosticsRoot) rmSync(diagnosticsRoot, { recursive: true, force: true });
}
