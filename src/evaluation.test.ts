import { describe, expect, it } from "vitest";
import { createSeedState } from "./seed";
import { evaluateProject } from "./evaluation";
import { createProject, getWorldSnapshot, recordNonToolAction, resolveHumanItem } from "./runtime";
import { scoreExperiment } from "./experimentHarness";

describe("evaluation and experiment contracts", () => {
  it("computes evidence, human-boundary, and production-boundary vectors from state", () => {
    const result = evaluateProject(createSeedState(), "project-trip-together");
    expect(result.metrics.outcomeQuality).toBe(1);
    expect(result.metrics.questionPrecision).toBe(1);
    expect(result.gates.find((gate) => gate.key === "C")?.passed).toBe(true);
    expect(result.gates.find((gate) => gate.key === "G")?.passed).toBe(false);
    expect(result.gates.find((gate) => gate.key === "D")?.passed).toBe(false);
  });

  it("recognizes an equilibrium stop only after a recorded runtime transition", () => {
    let state = createSeedState();
    state = resolveHumanItem(state, "Q-17", "answer", "B");
    state = resolveHumanItem(state, "APPROVAL-12", "approve");
    const project = state.projects.find((candidate) => candidate.id === "project-trip-together")!;
    const world = getWorldSnapshot(state, project.id)!;
    state = recordNonToolAction(state, project.id, {
      type: "WAIT",
      intentRef: project.intentId,
      worldCursor: world.cursorEventId,
      rationaleSummary: "all required decisions are resolved and no useful action is available",
    });
    const result = evaluateProject(state, "project-trip-together");
    expect(result.metrics.stopQuality).toBe(1);
    expect(result.gates.find((gate) => gate.key === "D")?.passed).toBe(true);
  });

  it("does not score an experiment without project evidence", () => {
    const state = createProject(createSeedState(), "새 workspace", "project-empty");
    const result = scoreExperiment(state, { id: "experiment-empty", projectId: "project-empty", key: "H1", title: "Initiative", hypothesis: "h", description: "d", variant: "baseline", status: "ready", score: "—", updatedAt: new Date().toISOString() });
    expect(result.passed).toBe(false);
    expect(result.score).toBe("insufficient evidence");
  });
});
