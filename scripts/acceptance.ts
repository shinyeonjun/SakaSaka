import { strict as assert } from "node:assert";
import { createEmptyState } from "../src/emptyState";
import { createProject, getProject, getProjectEvents, getToolSurface, getWorldSnapshot, recordNonToolAction, resolveHumanItem } from "../src/runtime";
import { validateActionBoundary } from "../src/security";
import { executeLocalCycle } from "../server/localRuntime";

async function main(): Promise<void> {
  const projectId = `acceptance-${Date.now().toString(36)}`;
  const initial = createProject(createEmptyState(), "현재 workspace의 품질을 검증하고 안전한 상태를 확인해줘", projectId, { workspacePath: process.cwd(), modelProvider: "deterministic" });
  assert.equal(getProject(initial, projectId)?.status, "ACTIVE");

  const executed = await executeLocalCycle(initial, projectId);
  assert.equal(getProject(executed, projectId)?.status, "ACTIVE");
  assert.equal(executed.actions.find((action) => action.projectId === projectId)?.status, "VERIFIED");
  assert.ok(executed.evidence.find((evidence) => evidence.projectId === projectId && evidence.verdict === "PASS"));
  const eventTypes = new Set(getProjectEvents(executed, projectId).map((event) => event.type));
  for (const type of ["OBSERVE", "CONTEXT_ASSEMBLED", "TOOL_CALLED", "TOOL_RESULT", "VERIFY", "EVIDENCE_RECORDED"] as const) assert.ok(eventTypes.has(type), `missing event ${type}`);
  assert.ok(!eventTypes.has("EQUILIBRIUM_ENTERED"), "a successful ACT must leave the project active");

  const activeProject = getProject(executed, projectId)!;
  const waited = recordNonToolAction(executed, projectId, {
    type: "WAIT",
    intentRef: activeProject.intentId,
    worldCursor: getWorldSnapshot(executed, projectId)!.cursorEventId,
    rationaleSummary: "현재 즉시 가치 있는 다음 행동이 없음",
  });
  assert.equal(getProject(waited, projectId)?.status, "EQUILIBRIUM");
  assert.ok(getProjectEvents(waited, projectId).some((event) => event.type === "EQUILIBRIUM_ENTERED"));

  const questionState = recordNonToolAction(initial, projectId, {
    type: "QUESTION",
    intentRef: activeProject.intentId,
    worldCursor: getWorldSnapshot(initial, projectId)!.cursorEventId,
    rationaleSummary: "정책의 우선 기준을 알려주세요",
    params: { blockingScope: ["정책"], continuingScope: ["관찰"] },
  });
  const question = questionState.humanItems.find((item) => item.kind === "QUESTION")!;
  const deferred = resolveHumanItem(questionState, question.id, "defer");
  assert.equal(deferred.humanItems.find((item) => item.id === question.id)?.status, "DEFERRED");
  const answered = resolveHumanItem(deferred, question.id, "answer", "안전성과 되돌릴 수 있음을 우선");
  assert.equal(answered.humanItems.find((item) => item.id === question.id)?.status, "ANSWERED");

  const hardBlockedState = createProject(createEmptyState(), "운영 환경의 위험한 외부 작업을 확인해줘", "hard-blocked-project");
  const hardBlockedProject = getProject(hardBlockedState, "hard-blocked-project")!;
  const externalAction = { type: "ACT", intentRef: hardBlockedProject.intentId, worldCursor: getWorldSnapshot(hardBlockedState, hardBlockedProject.id)!.cursorEventId, rationaleSummary: "외부 배포", tool: "deploy.production", params: { url: "https://deploy.example.com" }, riskClass: "P3" } as const;
  const hardBlock = validateActionBoundary(hardBlockedProject, externalAction, getToolSurface(hardBlockedProject));
  assert.equal(hardBlock.status, "blocked");
  const approvalState = createProject(createEmptyState(), "승인이 필요한 외부 작업을 확인해줘", "approval-project", { productionBlocked: false });
  const approvalProject = getProject(approvalState, "approval-project")!;
  const approval = validateActionBoundary(approvalProject, { ...externalAction, tool: "workspace.delete", params: { path: "obsolete.txt" }, riskClass: "P2", intentRef: approvalProject.intentId, worldCursor: getWorldSnapshot(approvalState, approvalProject.id)!.cursorEventId }, getToolSurface(approvalProject));
  assert.equal(approval.status, "human-approval");

  console.log("Acceptance passed: empty bootstrap, real local cycle, active continuation, WAIT stop, human defer/answer, and production boundary");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
