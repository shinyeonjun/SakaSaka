import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { createProject, getHumanCounts, getProject, getProjectEvents, getOpenHumanItems, resolveHumanItem, runCycle } from "./runtime";

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
  });
});
