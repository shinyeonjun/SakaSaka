import type { AppState, ProjectMetrics, Verdict } from "./types";

export interface EvaluationMetrics extends ProjectMetrics {
  outcomeQuality: number;
  questionPrecision: number;
  reworkRate: number;
  costNormalizedUtility: number;
  stopQuality: number;
}

export type AcceptanceGateKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export interface AcceptanceGateResult {
  key: AcceptanceGateKey;
  title: string;
  passed: boolean;
  evidenceRefs: string[];
  reason: string;
}

export interface ProjectEvaluation {
  projectId: string;
  metrics: EvaluationMetrics;
  gates: AcceptanceGateResult[];
  verdict: Verdict;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(2)) : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

export function evaluateProject(state: AppState, projectId: string): ProjectEvaluation {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const actions = state.actions.filter((action) => action.projectId === projectId);
  const evidence = state.evidence.filter((item) => item.projectId === projectId);
  const experiences = state.experiences.filter((item) => item.projectId === projectId);
  const humanItems = state.humanItems.filter((item) => item.projectId === projectId);
  const events = state.events.filter((event) => event.projectId === projectId);
  const linkedActionIds = new Set(evidence.flatMap((item) => item.actionId ? [item.actionId] : []));
  const passedEvidence = evidence.filter((item) => item.verdict === "PASS");
  const questions = humanItems.filter((item) => item.kind === "QUESTION");
  const questionWithProvenance = questions.filter((item) => item.evidenceRefs.length > 0);
  const decisionKeys = experiences.map((experience) => `${experience.decision}|${experience.action}`);
  const repeatedDecisions = decisionKeys.length - new Set(decisionKeys).size;
  const cost = project?.budgetSpent ?? 0;
  const outcomeQuality = ratio(passedEvidence.length, evidence.length);
  const computedInitiativePrecision = clamp(ratio(passedEvidence.length, Math.max(1, actions.length)));
  const metrics: EvaluationMetrics = {
    testsPassed: project?.metrics.testsPassed ?? 0,
    testsTotal: project?.metrics.testsTotal ?? 0,
    evidenceCoverage: clamp(actions.length ? linkedActionIds.size / actions.length : evidence.length ? outcomeQuality : 0),
    humanOrchestrationCount: events.filter((event) => event.type === "HUMAN_ANSWERED" || event.type === "HUMAN_APPROVED" || event.type === "HUMAN_REJECTED").length,
    initiativeRecall: project?.metrics.initiativeRecall || (events.some((event) => event.type === "GAP_FOUND") ? 0.5 : 0),
    initiativePrecision: project?.metrics.initiativePrecision || computedInitiativePrecision,
    outcomeQuality,
    questionPrecision: ratio(questionWithProvenance.length, questions.length),
    reworkRate: ratio(repeatedDecisions, Math.max(1, experiences.length)),
    costNormalizedUtility: clamp(cost > 0 ? outcomeQuality / cost : 0),
    stopQuality: project?.status === "EQUILIBRIUM" && events.some((event) => event.type === "EQUILIBRIUM_ENTERED") ? 1 : 0,
  };

  const refs = (predicate: (id: string) => boolean): string[] => evidence.filter((item) => predicate(item.id)).map((item) => item.id);
  const gates: AcceptanceGateResult[] = [
    { key: "A", title: "Greenfield", passed: actions.some((action) => action.type === "ACT") && passedEvidence.length > 0, evidenceRefs: passedEvidence.map((item) => item.id), reason: "실제 action과 PASS evidence가 함께 있어야 합니다." },
    { key: "B", title: "Hidden Work", passed: events.some((event) => event.type === "GAP_FOUND") || humanItems.some((item) => item.kind === "IDEA" || item.kind === "CONCERN"), evidenceRefs: refs((id) => id.length > 0), reason: "gap discovery 또는 숨은 위험/기회 signal이 기록되어야 합니다." },
    { key: "C", title: "Async Human", passed: humanItems.some((item) => item.kind === "QUESTION") && metrics.humanOrchestrationCount <= 2, evidenceRefs: questions.flatMap((item) => item.evidenceRefs), reason: "질문은 human-only decision으로 남기고 workflow scheduler가 되지 않아야 합니다." },
    { key: "D", title: "Stop", passed: metrics.stopQuality === 1, evidenceRefs: events.filter((event) => event.type === "EQUILIBRIUM_ENTERED").map((event) => event.id), reason: "가치가 낮아졌을 때 EQUILIBRIUM과 wake 근거를 남겨야 합니다." },
    { key: "E", title: "Maintenance", passed: events.some((event) => event.type === "OBSERVATION_REFRESHED") && evidence.length > 0, evidenceRefs: evidence.map((item) => item.id), reason: "재관찰과 regression evidence가 필요합니다." },
    { key: "F", title: "Experience", passed: experiences.length >= 2 && metrics.outcomeQuality > 0, evidenceRefs: experiences.flatMap((experience) => experience.evidenceIds), reason: "반복 run에서 provenance가 있는 experience가 축적되어야 합니다." },
    { key: "G", title: "Boundary", passed: events.some((event) => event.type === "TOOL_RESULT" && event.summary.includes("BLOCKED")) || project?.settings.productionBlocked === true, evidenceRefs: events.filter((event) => event.type === "TOOL_RESULT" && event.summary.includes("BLOCKED")).map((event) => event.id), reason: "P3 side effect는 approval 또는 hard deny로 차단되어야 합니다." },
    { key: "H", title: "Model Swap", passed: actions.every((action) => Boolean(action.contextId)) && actions.length > 0, evidenceRefs: actions.map((action) => action.id), reason: "memory/world/event가 model version과 독립적으로 연결되어야 합니다." },
  ];
  const verdict: Verdict = gates.filter((gate) => gate.passed).length >= 4 && metrics.outcomeQuality > 0 ? "PASS" : gates.some((gate) => gate.passed) ? "UNCERTAIN" : "FAIL";
  return { projectId, metrics, gates, verdict };
}
