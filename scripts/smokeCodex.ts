import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyState } from "../src/emptyState";
import { assembleContext, createProject } from "../src/runtime";
import { ModelGatewayError } from "../src/modelFailure";
import { CodexCliModelGateway, inspectCodexCli } from "../server/codexCliGateway";

/** Diagnostics do not consume a model turn; --run explicitly permits one real turn. */
async function main() {
  const diagnostics = await inspectCodexCli();
  console.log(JSON.stringify({ diagnostics }, null, 2));
  if (!diagnostics.installed) { process.exitCode = 2; return; }
  if (!process.argv.includes("--run")) {
    console.log("설치/로그인 확인만 수행했습니다. 실제 프로토콜 검사: npm run smoke:codex -- --run (모델 사용량 발생 가능)");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "sakasaka-smoke-"));
  try {
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const state = createProject(createEmptyState(), "빈 작업 폴더를 확인할 수 있는 다음 행동을 골라줘. 실제 앱 구현은 아직 시작하지 마.", "codex-smoke", { modelProvider: "codex-cli", workspacePath: workspace, budgetLimit: 1 });
    const context = assembleContext(state, "codex-smoke")!;
    context.toolSurface = context.toolSurface.filter((tool) => tool.name === "workspace.list");
    const gateway = new CodexCliModelGateway();
    context.modelVersion = (await gateway.capabilities()).modelVersion;
    const action = await gateway.decide(context);
    if (action.intentRef !== context.intentRef || action.worldCursor !== context.worldCursor) throw new Error("실제 Codex 응답의 Intent/World 커서가 다릅니다.");
    if (action.type === "ACT" && action.tool !== "workspace.list") throw new Error("허용하지 않은 도구를 반환했습니다.");
    const usage = await gateway.usage(context.runId ?? context.projectId);
    console.log(JSON.stringify({ protocolVerified: true, decision: action, usage, note: "실제 Codex 구조화 응답을 검사했습니다. SakaSaka 도구를 실행하거나 제품 개발 능력을 평가한 결과는 아닙니다. 비용은 설정된 단가로 계산한 추정치입니다." }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  console.error(JSON.stringify(error instanceof ModelGatewayError ? { protocolVerified: false, failure: error.failure, usage: error.usage } : { protocolVerified: false, message: error instanceof Error ? error.message : "진단 실패" }, null, 2));
  process.exitCode = 1;
});
