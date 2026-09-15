import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { assembleContext, createProject, getActivePolicy, getHumanCounts, getProject, getProjectContexts, getProjectEvents, getOpenHumanItems, getProjectObservations, getResourceLedger, killProject, pauseProject, resolveHumanItem, resumeProject, runCycle, runExperiment } from "./runtime";

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
    expect(project?.status).toBe("WAITING");
    expect(project?.budgetSpent).toBe(8.8);
    expect(next.evidence.length).toBe(initial.evidence.length + 1);
    expect(getProjectEvents(next, "project-trip-together").some((event) => event.type === "VERIFY")).toBe(true);
    expect(getProjectEvents(next, "project-trip-together").some((event) => event.type === "WORLD_CHANGED")).toBe(true);
    expect(getProjectContexts(next, "project-trip-together")).toHaveLength(2);
    expect(getProjectObservations(next, "project-trip-together").length).toBeGreaterThan(6);
    expect(getResourceLedger(next, "project-trip-together")?.toolCalls).toBe(19);
  });

  it("assembles a source-linked context with boundary and tool capabilities", () => {
    const state = createSeedState();
    const context = assembleContext(state, "project-trip-together");
    expect(context?.rawIntent).toContain("여행 계획");
    expect(context?.observationRefs).toHaveLength(6);
    expect(context?.boundary.openApprovalRefs).toEqual(["APPROVAL-12"]);
    expect(context?.toolSurface.find((tool) => tool.name === "deploy.production")?.enabled).toBe(false);
  });

  it("resumes the affected scope after a human answer and reaches equilibrium when blockers are gone", () => {
    let state = createSeedState();
    state = resolveHumanItem(state, "Q-17", "answer", "B");
    state = resolveHumanItem(state, "APPROVAL-12", "approve");
    expect(state.humanItems.find((item) => item.id === "Q-17")?.answerLabel).toBe("여행 생성자만 초대 가능");
    expect(getOpenHumanItems(state, "project-trip-together")).toHaveLength(3);
    state = runCycle(state, "project-trip-together");
    expect(getProject(state, "project-trip-together")?.status).toBe("EQUILIBRIUM");
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
    expect(next.actions.find((action) => action.projectId === "project-new")?.rationaleSummary).toContain("Intent에 연결된 World");
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
    const stalled = runCycle(limited, "project-trip-together");
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
});
