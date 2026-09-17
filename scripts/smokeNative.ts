import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CodexAppServer, asRecord, checkNativeConfig } from "../server/codexAppServer";
import { createProject, getProject, getRun } from "../src/runtime";
import { createEmptyState } from "../src/emptyState";
import { inspectCheckpoint, resolveCheckpointReferences } from "../src/nativeSession";
import type { NativeSession } from "../src/nativeSession";
import type { ModelFailure } from "../src/modelFailure";
import { redactSecretLikeText } from "../src/security";
import { runNativeEpisode } from "../server/nativeRuntime";
import { inspectCodexCli } from "../server/codexCliGateway";
import { fileResult, runNativePreflight, shouldRunNativeModel } from "./smokeNativePreflight";

const args = new Set(process.argv.slice(2));
if ([...args].some((a) => a !== "--run" && a !== "--keep")) throw new Error("사용법: npm run smoke:native -- [--run] [--keep]");
const dedicatedCodexHome = process.env.SAKASAKA_CODEX_HOME?.trim();
if (dedicatedCodexHome) process.env.CODEX_HOME = dedicatedCodexHome;

const clean = (value: unknown, max = 1_600): string => redactSecretLikeText(typeof value === "string" ? value : JSON.stringify(value ?? "")).replace(/\s+/g, " ").slice(0, max);

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
  let readinessReport: Record<string, unknown> = process.platform === "win32"
    ? { status: "not-run" }
    : { status: "not-applicable", platform: process.platform };
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
    const preflight = await runNativePreflight(client, workspace);
    readinessReport = preflight.windowsSandbox;
    console.log(JSON.stringify({ stage: "preflight", appServer: appServerReport, shellEnvironmentPolicy: shellPolicyReport, windowsSandbox: readinessReport, executablesAndWorkspace: preflight.executablesAndWorkspace }, null, 2));
    if (!shouldRunNativeModel(args.has("--run"), preflight)) {
      if (preflight.passed) {
        console.log(JSON.stringify({ stage: "model", requested: false, status: "not-run", reason: "preflight-only", diagnostics: root }, null, 2));
        return;
      }
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
