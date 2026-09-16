import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { assembleContext, createProject, getActivePolicy, getActionableHumanItems, getHumanCounts, getProject, getProjectContexts, getProjectEvents, getOpenHumanItems, getProjectObservations, getResourceLedger, getRun, getWorldSnapshot, killProject, pauseProject, recordBoundaryDecision, recordNonToolAction, resolveHumanItem, resumeProject, runCycle, runExperiment } from "./runtime";

describe("Intent World runtime", () => {
  it("keeps the seeded human boundary visible in the project state", () => {
    const state = createSeedState();
    const counts = getHumanCounts(state, "project-trip-together");
    expect(counts).toEqual({ QUESTION: 1, IDEA: 2, CONCERN: 1, APPROVAL: 1 });
    expect(getOpenHumanItems(state, "project-trip-together")).toHaveLength(5);
  });

  it("records a deterministic observe → act → verify cycle", () => {
    const initial = createSeedState();
    const next = runCycle(initial, "project-trip-together");
    const project = getProject(next, "project-trip-together");
    expect(project?.status).toBe("ACTIVE");
    expect(project?.budgetSpent).toBe(8.42);
    expect(next.evidence.length).toBe(initial.evidence.length + 1);
    expect(getProjectEvents(next, "project-trip-together").some((event) => event.type === "VERIFY")).toBe(true);
    expect(getProjectEvents(next, "project-trip-together").some((event) => event.type === "WORLD_CHANGED")).toBe(true);
    expect(getProjectContexts(next, "project-trip-together")).toHaveLength(2);
    expect(getProjectObservations(next, "project-trip-together").length).toBeGreaterThan(6);
    expect(getResourceLedger(next, "project-trip-together")?.toolCalls).toBe(18);
  });

  it("keeps independent work active while a human-owned scope is waiting", () => {
    const state = createSeedState();
    const next = recordNonToolAction(state, "project-trip-together", {
      type: "QUESTION",
      intentRef: "intent-trip-together",
      worldCursor: "event-816",
      rationaleSummary: "권한 정책을 사람에게 확인",
      riskClass: "P2",
      params: { scope: "invite-permissions" },
    });
    const question = next.humanItems.find((item) => item.actionRef === next.actions.at(-1)?.id);
    expect(question?.blockingScope).toEqual(["invite-permissions"]);
    expect(question?.continuingScope.length).toBeGreaterThan(0);
    expect(getProject(next, "project-trip-together")?.status).toBe("ACTIVE");
    expect(getProject(next, "project-trip-together")?.currentActionId).toBe(next.actions.at(-1)?.id);
  });

  it("assembles a source-linked context with boundary and tool capabilities", () => {
    const state = createSeedState();
    const context = assembleContext(state, "project-trip-together");
    expect(context?.rawIntent).toContain("여행 계획");
    expect(context?.observationRefs).toHaveLength(6);
    expect(context?.boundary.openApprovalRefs).toEqual(["APPROVAL-12"]);
    expect(context?.toolSurface.find((tool) => tool.name === "deploy.production")?.enabled).toBe(false);
  });

  it("keeps the immutable Intent intact while redacting its model-facing context projection", () => {
    const state = createProject(createSeedState(), "새 프로젝트 api_key=sk-test-1234567890", "project-redacted-context");
    const context = assembleContext(state, "project-redacted-context");
    expect(state.intents.find((intent) => intent.projectId === "project-redacted-context")?.rawText).toContain("api_key=sk-test");
    expect(context?.rawIntent).toContain("api_key=[REDACTED]");
    expect(context?.rawIntent).not.toContain("sk-test-1234567890");
  });

  it("resumes the affected scope after a human answer and reaches equilibrium when blockers are gone", () => {
    let state = createSeedState();
    state = resolveHumanItem(state, "Q-17", "answer", "B");
    state = resolveHumanItem(state, "APPROVAL-12", "approve");
    expect(state.humanItems.find((item) => item.id === "Q-17")?.answerLabel).toBe("여행 생성자만 초대 가능");
    expect(getOpenHumanItems(state, "project-trip-together")).toHaveLength(3);
    state = recordNonToolAction(state, "project-trip-together", { type: "WAIT", intentRef: getProject(state, "project-trip-together")!.intentId, worldCursor: getWorldSnapshot(state, "project-trip-together")!.cursorEventId, rationaleSummary: "현재 즉시 가치 있는 action 없음", riskClass: "P0" });
    expect(getProject(state, "project-trip-together")?.status).toBe("EQUILIBRIUM");
  });

  it("rejects an answer that is not one of the declared human options", () => {
    const initial = createSeedState();
    const unchanged = resolveHumanItem(initial, "Q-17", "answer", "not-an-option");
    expect(unchanged).toBe(initial);
    expect(initial.humanItems.find((item) => item.id === "Q-17")?.status).toBe("OPEN");
  });

  it("redacts free-form human answers in persisted events while keeping the decision usable", () => {
    const state = createProject(createSeedState(), "자유 답변 프로젝트", "project-human-redaction");
    const project = getProject(state, "project-human-redaction")!;
    const withQuestion = recordNonToolAction(state, project.id, {
      type: "QUESTION",
      intentRef: project.intentId,
      worldCursor: "pending",
      rationaleSummary: "자유 답변이 필요합니다",
      riskClass: "P2",
    });
    const item = withQuestion.humanItems.find((candidate) => candidate.projectId === project.id && candidate.kind === "QUESTION")!;
    const resolved = resolveHumanItem(withQuestion, item.id, "answer", "api_key=sk-test-1234567890");
    expect(resolved.humanItems.find((candidate) => candidate.id === item.id)?.answer).toBe("api_key=[REDACTED]");
    expect(resolved.events.at(-2)?.detail).not.toContain("sk-test-1234567890");
  });

  it("can start a new intent without mutating the immutable history of another project", () => {
    const initial = createSeedState();
    const next = createProject(initial, "팀이 함께 제품 아이디어를 검증할 수 있는 공간", "project-new");
    expect(next.projects).toHaveLength(2);
    expect(next.intents.find((intent) => intent.projectId === "project-new")?.rawText).toContain("제품 아이디어");
    expect(next.events.filter((event) => event.projectId === "project-trip-together")).toHaveLength(initial.events.filter((event) => event.projectId === "project-trip-together").length);
    expect(next.observations.some((observation) => observation.projectId === "project-new")).toBe(true);
    expect(next.policies.some((policy) => policy.projectId === "project-new" && policy.status === "active")).toBe(true);
  });

  it("uses the new Intent context instead of seed-project copy when a new project runs", () => {
    const initial = createSeedState();
    const created = createProject(initial, "팀이 함께 제품 아이디어를 검증할 수 있는 공간", "project-new");
    const next = runCycle(created, "project-new");
    expect(next.actions.find((action) => action.projectId === "project-new")?.rationaleSummary).toContain("현재 World");
    expect(next.experiences.find((experience) => experience.projectId === "project-new")?.situation).not.toContain("초대");
  });

  it("preserves lifecycle boundaries and hard-stops a cycle over budget", () => {
    let state = createSeedState();
    state = pauseProject(state, "project-trip-together");
    expect(getProject(state, "project-trip-together")?.status).toBe("PAUSED");
    state = resumeProject(state, "project-trip-together");
    expect(getProject(state, "project-trip-together")?.status).toBe("ACTIVE");
    state = killProject(state, "project-trip-together");
    expect(getProject(state, "project-trip-together")?.status).toBe("KILLED");
    expect(getProject(runCycle(state, "project-trip-together"), "project-trip-together")?.status).toBe("KILLED");

    const nearLimit = createSeedState();
    const limited = { ...nearLimit, projects: nearLimit.projects.map((project) => ({ ...project, budgetSpent: 29.9 })) };
    const stalled = runCycle(limited, "project-trip-together", {
      action: { type: "ACT", intentRef: "intent-trip-together", worldCursor: "event-816", rationaleSummary: "budget check", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://budget", summary: "budget check", evidence: [], cost: 0.2, wallTimeMs: 1 },
    });
    expect(getProject(stalled, "project-trip-together")?.status).toBe("STALLED");
    expect(getProjectEvents(stalled, "project-trip-together").some((event) => event.summary.includes("STALLED"))).toBe(true);
  });

  it("records experiment results as a candidate policy until independent evidence promotes it", () => {
    const initial = createSeedState();
    const next = runExperiment(initial, "exp-h6");
    const experiment = next.experiments.find((candidate) => candidate.id === "exp-h6");
    const candidates = next.policies.filter((policy) => policy.projectId === "project-trip-together" && policy.status === "candidate");
    expect(experiment?.status).toBe("passed");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.parentPolicyId).toBe(getActivePolicy(initial, "project-trip-together")?.id);
    expect(getProjectEvents(next, "project-trip-together").some((event) => event.type === "POLICY_CHANGED")).toBe(true);
  });

  it("uses configured wall-time limits and wakes the affected scope after a human decision", () => {
    const state = createProject(createSeedState(), "새 프로젝트", "project-limited", { maxHours: 2, budgetLimit: 10 });
    const project = getProject(state, "project-limited")!;
    const run = state.runs.find((candidate) => candidate.id === project.activeRunId)!;
    expect(Date.parse(run.leaseExpiresAt) - Date.parse(run.startedAt)).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);

    const questionState = recordNonToolAction(state, "project-limited", { type: "QUESTION", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "제품 정책을 확인해 주세요", riskClass: "P2" });
    const item = questionState.humanItems.find((candidate) => candidate.kind === "QUESTION" && candidate.projectId === "project-limited")!;
    const resolved = resolveHumanItem(questionState, item.id, "answer", "사람이 결정한 정책");
    expect(getProject(resolved, "project-limited")?.status).toBe("ACTIVE");
    expect(getProjectEvents(resolved, "project-limited").some((event) => event.type === "WAKE_TRIGGERED" && event.payload?.itemId === item.id)).toBe(true);
    expect(resolved.experiences.some((experience) => experience.actionType === "QUESTION")).toBe(true);
  });

  it("does not accept a tool result that belongs to another project", () => {
    const state = createProject(createSeedState(), "검증 프로젝트", "project-foreign-evidence");
    const project = getProject(state, "project-foreign-evidence")!;
    const failed = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "잘못 연결된 결과", tool: "repo.read" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://foreign", summary: "foreign", evidence: [{ id: "foreign-evidence", projectId: "other-project", kind: "test", verdict: "PASS", summary: "foreign", source: "test", createdAt: new Date().toISOString() }], cost: 0, wallTimeMs: 1 },
    });
    expect(getProject(failed, project.id)?.status).toBe("ACTIVE");
    expect(getRun(failed, project.id)?.consecutiveFailures).toBe(1);
    expect(getProjectEvents(failed, project.id).some((event) => event.type === "RUNTIME_ERROR")).toBe(true);
  });

  it("enforces the action boundary even when a caller bypasses the local adapter", () => {
    const state = createProject(createSeedState(), "경계 우회 방지 프로젝트", "project-boundary-runtime");
    const project = getProject(state, "project-boundary-runtime")!;
    const next = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "production side effect", tool: "deploy.production", riskClass: "P3" },
    });
    expect(next.actions.at(-1)?.status).toBe("BLOCKED");
    expect(getProject(next, project.id)?.status).toBe("STALLED");
    expect(next.events.at(-1)?.summary).toContain("STALLED");
  });

  it("does not claim PASS when a tool returns no evidence", () => {
    const state = createProject(createSeedState(), "증거 없는 실행", "project-no-evidence");
    const project = getProject(state, "project-no-evidence")!;
    const next = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "검증 없는 실행", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://empty", summary: "returned without evidence", evidence: [], cost: 0, wallTimeMs: 1 },
    });
    expect(next.evidence.at(-1)?.verdict).toBe("UNCERTAIN");
    expect(next.actions.at(-1)?.status).toBe("UNCERTAIN");
    expect(next.experiences.at(-1)?.evidenceIds).toEqual([next.evidence.at(-1)?.id]);
  });

  it("does not let an evaluator upgrade empty or conflicting evidence to PASS", () => {
    const state = createProject(createSeedState(), "평가 경계 프로젝트", "project-evaluator-boundary");
    const project = getProject(state, "project-evaluator-boundary")!;
    const empty = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "빈 결과 검증", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://empty-evaluation", summary: "empty", evidence: [], cost: 0, wallTimeMs: 1 },
      evaluation: { verdict: "PASS", summary: "provider claimed pass", evidenceRefs: [], evaluatorVersion: "test" },
    });
    expect(empty.evidence.at(-1)?.verdict).toBe("UNCERTAIN");
    const conflicting = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "실패 결과 검증", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://conflicting-evaluation", summary: "fail", evidence: [{ id: "conflict-evidence", projectId: project.id, kind: "test", verdict: "FAIL", summary: "failed", source: "test", createdAt: new Date().toISOString() }], cost: 0, wallTimeMs: 1 },
      evaluation: { verdict: "PASS", summary: "provider claimed pass", evidenceRefs: ["conflict-evidence"], evaluatorVersion: "test" },
    });
    expect(conflicting.evidence.find((item) => item.id === "conflict-evidence")?.verdict).toBe("FAIL");
    expect(conflicting.actions.at(-1)?.status).toBe("FAILED");
  });

  it("keeps runtime incidents in context until a later PASS evidence closes them", () => {
    const initial = createProject(createSeedState(), "incident context project", "project-incident-context");
    const project = getProject(initial, "project-incident-context")!;
    const failed = runCycle(initial, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "실패를 기록", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "failed", outputRef: "tool://incident", summary: "failed", evidence: [{ id: "incident-evidence", projectId: project.id, kind: "test", verdict: "FAIL", summary: "failed", source: "test", createdAt: new Date().toISOString() }], cost: 0, wallTimeMs: 1 },
    });
    const incidentId = failed.events.find((event) => event.type === "RUNTIME_ERROR")?.id;
    expect(incidentId).toBeDefined();
    expect(assembleContext(failed, project.id)?.activeIncidentRefs).toContain(incidentId);
  });

  it("rebinds provider evidence to the dispatch action for an unambiguous lineage", () => {
    const state = createProject(createSeedState(), "증거 연결 프로젝트", "project-evidence-lineage");
    const project = getProject(state, "project-evidence-lineage")!;
    const next = runCycle(state, project.id, {
      action: { type: "ACT", intentRef: project.intentId, worldCursor: "pending", rationaleSummary: "검증 실행", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" },
      toolResult: { tool: "repo.read", toolVersion: "test", status: "succeeded", outputRef: "tool://lineage", summary: "ok", evidence: [{ id: "provider-evidence", projectId: project.id, actionId: "old-action", kind: "test", verdict: "PASS", summary: "passed", source: "test", createdAt: new Date().toISOString() }], cost: 0, wallTimeMs: 1 },
    });
    const actionId = next.actions.at(-1)?.id;
    expect(next.evidence.find((item) => item.id === "provider-evidence")?.actionId).toBe(actionId);
  });
});
