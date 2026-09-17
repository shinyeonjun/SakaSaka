import { ModelGatewayError, modelFailure } from "./modelFailure";
import { describe, expect, it } from "vitest";
import { createEmptyState } from "./emptyState";
import { assembleContext, createProject, deleteProject, getProject, getProjectEvents, getOpenHumanItems, getResourceLedger, getRun, getWorldSnapshot, pauseProject, recordModelFailure, recordNonToolAction, recoverTransientProviderFailures, resolveHumanItem, resumeProject, runCycle, updateProjectModelSettings } from "./runtime";
import type { ActionEnvelope, AppState } from "./types";
import type { ToolResult } from "./ports";

function projectState(id = "project-test", rawIntent = "현재 제품의 품질을 확인하고 필요한 개선을 진행해줘", settings: Parameters<typeof createProject>[3] = {}): { state: AppState; projectId: string } {
  return { state: createProject(createEmptyState(), rawIntent, id, settings), projectId: id };
}

function currentAction(state: AppState, projectId: string, overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  const project = getProject(state, projectId)!;
  return {
    type: "ACT",
    intentRef: project.intentId,
    worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId,
    rationaleSummary: "현재 관찰 결과를 실제 도구로 검증",
    tool: "repo.read",
    params: { commandId: "repo-status" },
    riskClass: "P0",
    ...overrides,
  };
}

function successfulToolResult(projectId: string, id = `evidence-${projectId}`): ToolResult {
  return {
    tool: "repo.read",
    toolVersion: "test-tool",
    status: "succeeded",
    outputRef: `tool://${projectId}/result`,
    summary: "실제 관찰 결과가 반환됨",
    evidence: [{ id, projectId, kind: "test", verdict: "PASS", summary: "검증 통과", source: "test-only-fixture", createdAt: new Date().toISOString() }],
    cost: 0.01,
    wallTimeMs: 1,
  };
}

describe("Intent World runtime", () => {
  it("새 상태에는 프로젝트·증거·데모 주장이 없다", () => {
    const state = createEmptyState();
    expect(state.projects).toHaveLength(0);
    expect(state.evidence).toHaveLength(0);
    expect(state.humanItems).toHaveLength(0);
  });

  it("실제 tool 결과가 있는 ACT를 기록하고 다음 cycle을 위해 ACTIVE를 유지한다", () => {
    const { state, projectId } = projectState();
    const next = runCycle(state, projectId, { action: currentAction(state, projectId), toolResult: successfulToolResult(projectId) });
    const project = getProject(next, projectId)!;
    expect(project.status).toBe("ACTIVE");
    expect(project.budgetSpent).toBeGreaterThan(0);
    expect(next.evidence).toHaveLength(1);
    const eventTypes = new Set(getProjectEvents(next, projectId).map((event) => event.type));
    expect(eventTypes.has("VERIFY")).toBe(true);
    expect(eventTypes.has("WORLD_CHANGED")).toBe(true);
    expect(getResourceLedger(next, projectId)?.toolCalls).toBe(1);
    expect(getProjectEvents(next, projectId).some((event) => event.type === "EQUILIBRIUM_ENTERED")).toBe(false);
  });

  it("기존 프로젝트에서 모델을 바꾸고 EQUILIBRIUM을 다시 깨운다", () => {
    const { state, projectId } = projectState("project-model-settings");
    const sleeping = recordNonToolAction(state, projectId, {
      type: "WAIT",
      intentRef: getProject(state, projectId)!.intentId,
      worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId,
      rationaleSummary: "현재 즉시 가치 있는 행동이 없음",
      riskClass: "P0",
    });
    expect(getProject(sleeping, projectId)?.status).toBe("EQUILIBRIUM");
    const next = updateProjectModelSettings(sleeping, projectId, { modelProvider: "codex-cli", modelName: "codex-test" });
    expect(getProject(next, projectId)?.settings.modelProvider).toBe("codex-cli");
    expect(getProject(next, projectId)?.settings.modelName).toBe("codex-test");
    expect(getProject(next, projectId)?.status).toBe("ACTIVE");
    expect(getProjectEvents(next, projectId).some((event) => event.type === "POLICY_CHANGED" && event.summary === "모델 설정 변경")).toBe(true);
  });

  it("provider 실패는 한 번에 중단하지 않고 한도까지 재시도하며 이전 중단 상태를 복구한다", () => {
    const { state, projectId } = projectState("project-provider-recovery", "실제 모델 provider로 다음 행동을 선택해줘", { failureThreshold: 3 });
    const providerFailure = (current: AppState) => {
      return recordModelFailure(current, projectId, new ModelGatewayError(modelFailure("PROVIDER_UNAVAILABLE", "모델 게이트웨이를 사용할 수 없습니다 · legacy fixture", true)));
    };

    const first = providerFailure(state);
    expect(getProject(first, projectId)?.status).toBe("ACTIVE");
    expect(getRun(first, projectId)?.consecutiveFailures).toBe(1);
    expect(getProjectEvents(first, projectId).some((event) => event.type === "EQUILIBRIUM_ENTERED")).toBe(false);
    const second = providerFailure(first);
    expect(getProject(second, projectId)?.status).toBe("ACTIVE");
    expect(getRun(second, projectId)?.consecutiveFailures).toBe(2);
    const stalled = providerFailure(second);
    expect(getProject(stalled, projectId)?.status).toBe("STALLED");
    expect(getRun(stalled, projectId)?.consecutiveFailures).toBe(3);
    expect(getProject(recoverTransientProviderFailures(stalled), projectId)?.status).toBe("STALLED");

    const legacyStalled = {
      ...stalled,
      runs: stalled.runs.map((run) => run.id === getRun(stalled, projectId)!.id ? { ...run, consecutiveFailures: 0, noProgressCycles: 0, lastFailureSignature: undefined } : run),
    };
    const recovered = recoverTransientProviderFailures(legacyStalled);
    expect(getProject(recovered, projectId)?.status).toBe("ACTIVE");
    expect(getRun(recovered, projectId)).toMatchObject({ status: "ACTIVE", phase: "wake", consecutiveFailures: 0, noProgressCycles: 0 });
    expect(getProjectEvents(recovered, projectId).some((event) => event.summary === "ACTIVE · provider failure recovery")).toBe(true);
  });

  it("프로젝트 삭제는 연결된 상태를 제거하고 작업 폴더 경로는 런타임 밖에서 보존한다", () => {
    const first = projectState("project-delete-first").state;
    const state = createProject(first, "두 번째 프로젝트도 보존해줘", "project-delete-second");
    const next = deleteProject({ ...state, activeProjectId: "project-delete-first" }, "project-delete-first");
    expect(next.projects.map((project) => project.id)).toEqual(["project-delete-second"]);
    expect(next.activeProjectId).toBe("project-delete-second");
    for (const collection of [next.intents, next.runs, next.actions, next.worldSnapshots, next.observations, next.contexts, next.events, next.evidence, next.humanItems, next.artifacts, next.experiences, next.policies, next.resourceLedger, next.relations, next.retrievalIndex, next.experiments, next.approvalGrants, next.processes]) {
      expect(collection.some((item) => item.projectId === "project-delete-first")).toBe(false);
    }
  });

  it("질문은 영향 범위만 보류하고 DEFERRED 뒤에도 자유 텍스트 답변을 받는다", () => {
    const { state, projectId } = projectState("project-question", "제품 정책을 사람의 기준에 맞춰 결정해줘");
    const project = getProject(state, projectId)!;
    let next = recordNonToolAction(state, projectId, {
      type: "QUESTION",
      intentRef: project.intentId,
      worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId,
      rationaleSummary: "정책의 우선 기준을 알려주세요",
      riskClass: "P2",
      params: { blockingScope: ["정책 결정"], continuingScope: ["독립 관찰"] },
    });
    const item = next.humanItems.find((candidate) => candidate.kind === "QUESTION")!;
    expect(item.responseMode).toBe("free-text");
    expect(getProject(next, projectId)?.status).toBe("ACTIVE");
    next = resolveHumanItem(next, item.id, "defer");
    expect(next.humanItems.find((candidate) => candidate.id === item.id)?.status).toBe("DEFERRED");
    expect(getOpenHumanItems(next, projectId)).toHaveLength(1);
    next = resolveHumanItem(next, item.id, "answer", "안전성과 되돌릴 수 있는 변경을 우선");
    expect(next.humanItems.find((candidate) => candidate.id === item.id)?.status).toBe("ANSWERED");
    expect(getProject(next, projectId)?.status).toBe("ACTIVE");
    expect(getProjectEvents(next, projectId).some((event) => event.type === "WAKE_TRIGGERED" && event.payload?.itemId === item.id)).toBe(true);
  });

  it("모델에 전달하는 Context는 원문 Intent의 secret-shaped 값을 가린다", () => {
    const { state, projectId } = projectState("project-redacted", "실제 작업 api_key=sk-test-1234567890 을 진행해줘");
    const context = assembleContext(state, projectId)!;
    expect(state.intents.find((intent) => intent.projectId === projectId)?.rawText).toContain("sk-test");
    expect(context.rawIntent).toContain("api_key=[REDACTED]");
    expect(context.rawIntent).not.toContain("sk-test-1234567890");
  });

  it("새 Intent는 다른 프로젝트의 immutable history와 분리된다", () => {
    const first = projectState("project-first", "첫 번째 제품의 상태를 확인해줘").state;
    const next = createProject(first, "두 번째 제품의 상태를 확인해줘", "project-second");
    expect(next.projects).toHaveLength(2);
    expect(next.intents.find((intent) => intent.projectId === "project-second")?.rawText).toContain("두 번째");
    expect(next.events.filter((event) => event.projectId === "project-first")).toHaveLength(first.events.filter((event) => event.projectId === "project-first").length);
    expect(next.policies.some((policy) => policy.projectId === "project-second" && policy.status === "active")).toBe(true);
  });

  it("일시정지와 재개 경계를 보존한다", () => {
    const { state, projectId } = projectState("project-lifecycle");
    const withLease = { ...state, runs: state.runs.map((run) => ({ ...run, execution: { id: "native-old", owner: "native-test", stage: "decide" as const, expiresAt: new Date(Date.now() + 60_000).toISOString() } })) };
    const paused = pauseProject(withLease, projectId);
    expect(getProject(paused, projectId)?.status).toBe("PAUSED");
    expect(getRun(paused, projectId)?.execution).toBeUndefined();
    const resumed = resumeProject(paused, projectId);
    expect(getProject(resumed, projectId)?.status).toBe("ACTIVE");
    expect(getRun(resumed, projectId)?.phase).toBe("wake");
  });

  it("예산 hard stop은 실제 비용이 상한을 넘을 때만 발생한다", () => {
    const { state, projectId } = projectState("project-budget", "예산 안에서 실제 검증을 진행해줘", { budgetLimit: 1, resourceLimitsDisabled: false });
    const project = getProject(state, projectId)!;
    const limited = { ...state, projects: state.projects.map((candidate) => candidate.id === projectId ? { ...candidate, budgetSpent: 0.99 } : candidate) };
    const next = runCycle(limited, projectId, { action: currentAction(limited, projectId), toolResult: { ...successfulToolResult(projectId, "evidence-budget"), cost: 0.2 } });
    expect(getProject(next, projectId)?.status).toBe("STALLED");
    expect(getProjectEvents(next, projectId).some((event) => event.summary.includes("STALLED"))).toBe(true);
    expect(project.settings.budgetLimit).toBe(1);
  });

  it("기본 자율 테스트 모드에서는 예산을 초과해도 비용만 계측하고 계속 실행한다", () => {
    const { state, projectId } = projectState("project-unlimited-budget", "제한 없이 계속 검증해줘", { budgetLimit: 1 });
    const limited = { ...state, projects: state.projects.map((candidate) => candidate.id === projectId ? { ...candidate, budgetSpent: 0.99 } : candidate) };
    const next = runCycle(limited, projectId, { action: currentAction(limited, projectId), toolResult: { ...successfulToolResult(projectId, "evidence-unlimited-budget"), cost: 0.2 } });
    expect(getProject(next, projectId)?.settings.resourceLimitsDisabled).toBe(true);
    expect(getProject(next, projectId)?.status).toBe("ACTIVE");
    expect(getProject(next, projectId)?.budgetSpent).toBeGreaterThan(1);
  });

  it("도구 결과가 다른 프로젝트에 속하면 검증 실패로 기록한다", () => {
    const { state, projectId } = projectState("project-foreign");
    const project = getProject(state, projectId)!;
    const result = successfulToolResult(projectId, "foreign-evidence");
    const next = runCycle(state, projectId, {
      action: currentAction(state, projectId),
      toolResult: { ...result, evidence: [{ ...result.evidence[0], projectId: "other-project" }] },
    });
    expect(getProject(next, projectId)?.status).toBe("ACTIVE");
    expect(getRun(next, projectId)?.consecutiveFailures).toBe(1);
    expect(getProjectEvents(next, projectId).some((event) => event.type === "RUNTIME_ERROR")).toBe(true);
    expect(project.intentId).toBeDefined();
  });

  it("증거가 없는 실행은 PASS가 아니라 UNCERTAIN으로 남긴다", () => {
    const { state, projectId } = projectState("project-no-evidence");
    const next = runCycle(state, projectId, { action: currentAction(state, projectId), toolResult: { ...successfulToolResult(projectId, "unused"), evidence: [] } });
    expect(next.evidence.at(-1)?.verdict).toBe("UNCERTAIN");
    expect(next.actions.at(-1)?.status).toBe("UNCERTAIN");
    expect(next.experiences.at(-1)?.evidenceIds).toEqual([next.evidence.at(-1)?.id]);
  });
});
