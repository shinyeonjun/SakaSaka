import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, asRecord, checkNativeConfig } from "../server/codexAppServer";
import { createProject, getProject, getRun } from "../src/runtime";
import { createEmptyState } from "../src/emptyState";
import { runNativeEpisode } from "../server/nativeRuntime";
import { inspectCodexCli } from "../server/codexCliGateway";

const args = new Set(process.argv.slice(2));
if ([...args].some((a) => a !== "--run" && a !== "--keep")) throw new Error("사용법: npm run smoke:native -- [--run] [--keep]");
if (process.env.SAKASAKA_CODEX_HOME?.trim()) process.env.CODEX_HOME = process.env.SAKASAKA_CODEX_HOME.trim();
const diagnostics = await inspectCodexCli();
console.log(diagnostics);
if (!diagnostics.installed) process.exitCode = 1;
else {
  const root = mkdtempSync(join(tmpdir(), "sakasaka-native-smoke-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  let keep = args.has("--keep");
  const client = new CodexAppServer({ cwd: workspace });
  try {
    await client.start();
    const result = asRecord(await client.request("config/read", { includeLayers: false }));
    if (!result.config || typeof result.config !== "object") throw new Error("실제 Codex 설정을 확인하지 못했습니다.");
    const blocked = checkNativeConfig(asRecord(result.config)); if (blocked) throw new Error(blocked);
    console.log("App Server initialize/config 계약 확인. 아직 모델 응답은 호출하지 않았습니다.");
    await client.close();
    if (args.has("--run")) {
      console.log("실제 모델을 호출합니다. 모델 사용량이 발생하며 임시 작업 폴더에만 테스트 파일을 작성합니다.");
      process.env.WORKSPACE_ROOT = root; process.env.INTENT_WORLD_RAW_DIR = join(root, "raw");
      let state = createProject(createEmptyState(), '이 임시 테스트 폴더에 native-smoke.txt를 만들고 내용에 SakaSaka native를 정확히 기록한 뒤 다시 읽어 확인해 주세요. 외부 네트워크나 패키지는 필요 없습니다. 확인한 결과를 checkpoint로 보고해 주세요.', "native-smoke", { workspacePath: workspace, executionMode: "native", modelProvider: "codex-cli", modelName: process.env.CODEX_CLI_MODEL?.trim() || undefined, maxNativeTurns: 1, maxNativeTokens: 50000, nativeTurnTimeoutMs: 90000 });
      let queue = Promise.resolve();
      await runNativeEpisode({ read: () => state, transact: (update) => { const p = queue.then(() => { state = update(state); return state; }); queue = p.then(() => undefined); return p; } }, "native-smoke");
      writeFileSync(join(root, "state.json"), JSON.stringify(state, null, 2));
      if (getProject(state, "native-smoke")?.status !== "EQUILIBRIUM") throw new Error(getRun(state, "native-smoke")?.stopReason ?? "에이전트가 테스트를 끝내지 않았습니다.");
      if (readFileSync(join(workspace, "native-smoke.txt"), "utf8").trim() !== "SakaSaka native") throw new Error("실제 파일 내용이 테스트 조건을 만족하지 않습니다.");
      console.log("실제 모델 → native 파일 쓰기 → 결과 확인 성공. 전체 제품 개발 능력을 검증한 것은 아닙니다.");
    }
  } catch (error) { keep = true; console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  finally { await client.close(); if (keep) console.log(`진단 보관 경로: ${root}`); else rmSync(root, { recursive: true, force: true }); }
}
