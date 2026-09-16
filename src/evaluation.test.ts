import { describe, expect, it } from "vitest";
import { createEmptyState } from "./emptyState";
import { evaluateProject } from "./evaluation";
import { createProject, getProject, getWorldSnapshot, recordNonToolAction, runCycle } from "./runtime";
import { scoreExperiment } from "./experimentHarness";
import type { ActionEnvelope, AppState, Experiment } from "./types";
import type { ToolResult } from "./ports";

function stateWithProject(id: string, rawIntent = "실제 결과를 검증해줘"): AppState {
  return createProject(createEmptyState(), rawIntent, id);
}

function passCycle(state: AppState, projectId: string): AppState {
  const project = getProject(state, projectId)!;
  const action: ActionEnvelope = { type: "ACT", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, projectId)!.cursorEventId, rationaleSummary: "실제 검증 실행", tool: "repo.read", params: { commandId: "repo-status" }, riskClass: "P0" };
  const toolResult: ToolResult = { tool: "repo.read", toolVersion: "test-tool", status: "succeeded", outputRef: "test://result", summary: "검증 통과", evidence: [{ id: `evaluation-evidence-${projectId}`, projectId, kind: "test", verdict: "PASS", summary: "1 tests passed", source: "test-only-fixture", createdAt: new Date().toISOString() }], cost: 0.01, wallTimeMs: 1 };
  return runCycle(state, projectId, { action, toolResult });
}

describe("평가와 실험 계약", () => {
  it("증거가 없는 신규 프로젝트의 지표는 0이며 실제 PASS 후에만 올라간다", () => {
    const initial = stateWithProject("evaluation-project");
    const before = evaluateProject(initial, "evaluation-project");
    expect(before.metrics.outcomeQuality).toBe(0);
    expect(before.metrics.testsTotal).toBe(0);
    const after = evaluateProject(passCycle(initial, "evaluation-project"), "evaluation-project");
    expect(after.metrics.outcomeQuality).toBe(1);
    expect(after.metrics.testsPassed).toBe(1);
    expect(after.metrics.testsTotal).toBe(1);
  });

  it("WAIT 이벤트가 실제로 기록된 뒤에만 equilibrium stop을 인정한다", () => {
    let state = passCycle(stateWithProject("stop-project"), "stop-project");
    const project = getProject(state, "stop-project")!;
    state = recordNonToolAction(state, project.id, { type: "WAIT", intentRef: project.intentId, worldCursor: getWorldSnapshot(state, project.id)!.cursorEventId, rationaleSummary: "현재 즉시 가치 있는 행동이 없음", riskClass: "P0" });
    const result = evaluateProject(state, "stop-project");
    expect(result.metrics.stopQuality).toBe(1);
    expect(result.gates.find((gate) => gate.key === "D")?.passed).toBe(true);
  });

  it("실험 증거가 없으면 insufficient evidence로 남긴다", () => {
    const state = stateWithProject("experiment-project");
    const experiment: Experiment = { id: "experiment-without-evidence", projectId: "experiment-project", key: "H1", title: "자발적 발견", hypothesis: "h", description: "d", variant: "baseline", status: "ready", score: "—", updatedAt: new Date().toISOString() };
    const result = scoreExperiment(state, experiment);
    expect(result.passed).toBe(false);
    expect(result.score).toBe("insufficient evidence");
  });
});
