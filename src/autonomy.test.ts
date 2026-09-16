import { describe, expect, it } from "vitest";
import { createProject, getProject, getProjectEvents, getRun, getToolSurface, getWorldSnapshot, recordNonToolAction, resolveHumanItem, runCycle } from "./runtime";
import { actionFingerprint, validateActionBoundary } from "./security";
import type { AppState, ActionEnvelope, Evidence } from "./types";

function emptyState(): AppState {
  return { schemaVersion: 1, activeProjectId: "", projects: [], intents: [], runs: [], actions: [], worldSnapshots: [], observations: [], contexts: [], events: [], evidence: [], humanItems: [], artifacts: [], experiences: [], policies: [], resourceLedger: [], relations: [], retrievalIndex: [], experiments: [], approvalGrants: [], processes: [] };
}

function questionAction(projectId: string, state: AppState, params: ActionEnvelope["params"] = {}): ActionEnvelope {
  const project = getProject(state, projectId)!;
  return { type: "QUESTION", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "human-only product decision is required", riskClass: "P2", params };
}

function failureResult(projectId: string, index: number) {
  const evidence: Evidence = { id: `failure-${index}`, projectId, kind: "test", verdict: "FAIL", summary: "1 test failed", source: "test-runner", createdAt: new Date().toISOString() };
  return { tool: "shell.sandbox", toolVersion: "test", status: "failed" as const, outputRef: `tool://failure/${index}`, summary: "test failed", evidence: [evidence], cost: 0, wallTimeMs: 1, progress: "none" as const };
}

describe("persistent autonomy primitives", () => {
  it("creates a real greenfield project with no seeded metric claims", () => {
    const state = createProject(emptyState(), "버튼을 누르면 숫자가 증가하는 앱을 만들어줘", "greenfield-metrics");
    expect(state.projects[0]?.metrics).toEqual({ testsPassed: 0, testsTotal: 0, evidenceCoverage: 0, humanOrchestrationCount: 0, initiativeRecall: 0, initiativePrecision: 0 });
    expect(state.evidence).toHaveLength(0);
    expect(state.projects[0]?.settings.workspacePath).toBeUndefined();
  });

  it("keeps a free-text question deferred and wakes it on a later answer", () => {
    let state = createProject(emptyState(), "결제 취소 정책을 결정해줘", "free-text-question");
    const project = getProject(state, "free-text-question")!;
    state = recordNonToolAction(state, project.id, questionAction(project.id, state, { blockingScope: ["refund-policy"], continuingScope: [] }));
    const item = state.humanItems.find((candidate) => candidate.kind === "QUESTION")!;
    expect(item.responseMode).toBe("free-text");
    expect(getProject(state, project.id)?.status).toBe("ACTIVE");
    state = recordNonToolAction(state, project.id, { type: "WAIT", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, project.id)!.cursorEventId, rationaleSummary: "답변이 없으면 진행할 독립 작업이 없습니다." });
    expect(getProject(state, project.id)?.status).toBe("WAITING");
    state = resolveHumanItem(state, item.id, "defer");
    expect(state.humanItems.find((candidate) => candidate.id === item.id)?.status).toBe("DEFERRED");
    expect(state.humanItems.filter((candidate) => candidate.projectId === project.id && (candidate.status === "OPEN" || candidate.status === "DEFERRED"))).toContainEqual(expect.objectContaining({ id: item.id }));
    state = resolveHumanItem(state, item.id, "answer", "환불은 7일 이내만 허용");
    expect(state.humanItems.find((candidate) => candidate.id === item.id)).toEqual(expect.objectContaining({ status: "ANSWERED", answer: "환불은 7일 이내만 허용" }));
    expect(getProject(state, project.id)?.status).toBe("ACTIVE");
    expect(getProjectEvents(state, project.id).some((event) => event.type === "WAKE_TRIGGERED" && event.payload?.itemId === item.id)).toBe(true);
  });

  it("issues an exact single-use approval grant and never lets it bypass P3", () => {
    let state = createProject(emptyState(), "승인된 외부 작업만 실행해줘", "approval-flow", { productionBlocked: false, requireExternalApproval: true, approvalTtlMinutes: 60 });
    const project = getProject(state, "approval-flow")!;
    const requestedAction: ActionEnvelope = { type: "ACT", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, project.id)!.cursorEventId, rationaleSummary: "publish the approved preview", tool: "workspace.delete", params: { path: "obsolete.txt" }, riskClass: "P2" };
    const blocked = validateActionBoundary(project, requestedAction, getToolSurface(project), 0.2);
    expect(blocked.status).toBe("human-approval");
    state = runCycle(state, project.id, { action: requestedAction });
    const approval = state.humanItems.find((item) => item.kind === "APPROVAL" && item.status === "OPEN")!;
    state = resolveHumanItem(state, approval.id, "approve");
    const grant = state.approvalGrants.find((candidate) => candidate.approvalItemId === approval.id)!;
    expect(grant.singleUse).toBe(true);
    expect(grant.actionFingerprint).toBe(actionFingerprint(requestedAction));
    expect(grant.consumedAt).toBeUndefined();

    const executableAction = { ...requestedAction, worldCursor: getWorldSnapshot(state, project.id)!.cursorEventId };
    expect(validateActionBoundary(project, executableAction, getToolSurface(project), 0.2, grant, Date.parse(grant.expiresAt) + 1).status).toBe("human-approval");
    const mismatch = runCycle(state, project.id, {
      action: { ...executableAction, params: { path: "different.txt" } },
    });
    expect(mismatch.actions.at(-1)?.status).toBe("BLOCKED");
    expect(mismatch.approvalGrants.find((candidate) => candidate.id === grant.id)?.consumedAt).toBeUndefined();
    expect(mismatch.humanItems.filter((item) => item.kind === "APPROVAL" && item.status === "OPEN")).toHaveLength(1);

    const executed = runCycle(state, project.id, {
      action: executableAction,
      toolResult: { tool: "workspace.delete", toolVersion: "test", status: "succeeded", outputRef: "tool://deploy/1", summary: "deployment accepted", evidence: [{ id: "approval-pass", projectId: project.id, kind: "world", verdict: "PASS", summary: "deployment accepted", source: "deploy-api", createdAt: new Date().toISOString() }], cost: 0.2, wallTimeMs: 2, progress: "meaningful" },
    });
    expect(getProject(executed, project.id)?.status).toBe("ACTIVE");
    expect(executed.approvalGrants.find((candidate) => candidate.id === grant.id)?.consumedAt).toBeTruthy();
    expect(executed.actions.at(-1)?.approvalGrantId).toBe(grant.id);

    const replay = runCycle(executed, project.id, { action: { ...executableAction, worldCursor: getWorldSnapshot(executed, project.id)!.cursorEventId } });
    expect(replay.actions.at(-1)?.status).toBe("BLOCKED");
    expect(replay.humanItems.filter((item) => item.kind === "APPROVAL" && item.status === "OPEN")).toHaveLength(1);

    const p3HardBlocked = createProject(emptyState(), "production은 절대 실행하지 마", "p3-hard-block", { productionBlocked: true, requireExternalApproval: false });
    const p3Project = getProject(p3HardBlocked, "p3-hard-block")!;
    expect(validateActionBoundary(p3Project, { ...requestedAction, tool: "deploy.production", intentRef: p3Project.intentId, worldCursor: "pending" }, getToolSurface(p3Project), 0.2).status).toBe("blocked");
  });

  it("retains repeated failures as active cognition until the configured threshold", () => {
    let state = createProject(emptyState(), "실패를 보고 다른 전략을 선택해줘", "failure-threshold", { failureThreshold: 3, noProgressThreshold: 8 });
    for (let index = 1; index <= 3; index += 1) {
      const project = getProject(state, "failure-threshold")!;
      const result = runCycle(state, project.id, {
        action: { type: "ACT", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, project.id)!.cursorEventId, rationaleSummary: "run the failing check", tool: "shell.sandbox", params: { commandId: "quality-test" }, riskClass: "P1" },
        toolResult: failureResult(project.id, index),
      });
      state = result;
      expect(getRun(state, project.id)?.consecutiveFailures).toBe(index);
      expect(getProject(state, project.id)?.status).toBe(index < 3 ? "ACTIVE" : "STALLED");
    }
    expect(state.evidence.filter((item) => item.projectId === "failure-threshold" && item.verdict === "FAIL")).toHaveLength(3);
  });

  it("suppresses a repeated open human decision and stalls only after no-progress threshold", () => {
    let state = createProject(emptyState(), "같은 human-only 질문을 반복하지 말고 진전을 추적해줘", "duplicate-question", { noProgressThreshold: 2 });
    for (let index = 0; index < 3; index += 1) {
      const project = getProject(state, "duplicate-question")!;
      state = recordNonToolAction(state, project.id, questionAction(project.id, state));
    }
    expect(state.humanItems.filter((item) => item.projectId === "duplicate-question" && item.kind === "QUESTION")).toHaveLength(1);
    expect(getRun(state, "duplicate-question")?.noProgressCycles).toBe(2);
    expect(getProject(state, "duplicate-question")?.status).toBe("STALLED");
  });
});
