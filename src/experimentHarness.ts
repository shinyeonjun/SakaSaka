import type { AppState, Experiment } from "./types";
import { evaluateProject } from "./evaluation";

export interface BenchmarkScenario {
  id: string;
  category: "greenfield" | "maintenance" | "hidden-work" | "long-horizon";
  title: string;
  intent: string;
  hiddenCriteria: string[];
  acceptanceRefs: string[];
}

export interface HypothesisDefinition {
  key: string;
  title: string;
  statement: string;
  evaluatorRefs: string[];
}

export const benchmarkScenarios: BenchmarkScenario[] = [
  { id: "greenfield-web", category: "greenfield", title: "Greenfield web application", intent: "사용자가 브라우저에서 실제로 사용할 수 있는 제품", hiddenCriteria: ["working app", "core E2E", "browser evidence", "human task orchestration 0"], acceptanceRefs: ["A", "C"] },
  { id: "maintenance-hidden-bug", category: "maintenance", title: "Hidden bug / dependency / performance / security", intent: "기존 제품을 안정적으로 유지하고 보이지 않는 회귀를 줄여줘", hiddenCriteria: ["reproduce bug", "dependency risk", "performance regression", "security evidence"], acceptanceRefs: ["B", "E", "G"] },
  { id: "hidden-work-ux", category: "hidden-work", title: "UX / permissions / operations", intent: "사용자가 실제로 신뢰할 수 있는 제품 상태를 만들어줘", hiddenCriteria: ["mobile UX", "permission ambiguity", "operational readiness"], acceptanceRefs: ["B", "C", "G"] },
  { id: "long-horizon-continuity", category: "long-horizon", title: "4h / 12h / 24h continuity and stop", intent: "신호가 들어오면 다시 깨어나고 가치가 낮아지면 멈추는 지속 실행", hiddenCriteria: ["lease renewal", "memory continuity", "equilibrium stop", "signal wake"], acceptanceRefs: ["D", "F", "H"] },
];

export const hypothesisCatalog: HypothesisDefinition[] = [
  { key: "H1", title: "Initiative", statement: "Intent + World만으로 명시되지 않은 필수 작업을 스스로 발견하는가?", evaluatorRefs: ["initiative-recall", "initiative-precision"] },
  { key: "H2", title: "Closed loop", statement: "Observe → Act → Verify가 Prompt → Response보다 복합 프로젝트 성과를 높이는가?", evaluatorRefs: ["outcome-quality", "evidence-coverage"] },
  { key: "H3", title: "Discovery", statement: "Information Gain을 고려하면 숨은 위험·요구·기회 발견이 증가하는가?", evaluatorRefs: ["question-precision", "hidden-work-recall"] },
  { key: "H4", title: "Role emergence", statement: "PM·QA·Designer·Architect 역할을 고정하지 않아도 기능이 나타나는가?", evaluatorRefs: ["outcome-quality", "human-orchestration-count"] },
  { key: "H5", title: "Experience memory", statement: "상태→행동→결과 기억으로 반복 삽질과 인간 개입이 감소하는가?", evaluatorRefs: ["rework-rate", "cost-normalized-utility"] },
  { key: "H6", title: "Meta improvement", statement: "정책 평가·개선이 동일 모델의 effective intelligence를 높이는가?", evaluatorRefs: ["stop-quality", "outcome-quality"] },
];

export const ablationLadder = [
  { key: "A", title: "기존 Task Agent", detail: "명시 task → completion" },
  { key: "B", title: "+ Persistent Closed Loop", detail: "Intent + World + Actions" },
  { key: "C", title: "+ Discovery / Uncertainty", detail: "숨은 Gap 탐색" },
  { key: "D", title: "+ Experience Memory", detail: "transition memory" },
  { key: "E", title: "+ Meta Improvement", detail: "policy update" },
] as const;

export function experimentDefinition(key: string): HypothesisDefinition | undefined {
  return hypothesisCatalog.find((candidate) => candidate.key === key.toUpperCase());
}

export function scoreExperiment(state: AppState, experiment: Experiment): { score: string; passed: boolean; evaluatorRefs: string[] } {
  const evaluation = evaluateProject(state, experiment.projectId, experiment.hiddenCriteria ?? []);
  const definition = experimentDefinition(experiment.key);
  const evidenceRefs = experiment.evaluationEvidenceRefs?.filter((ref) => state.evidence.some((item) => item.id === ref && item.projectId === experiment.projectId)) ?? [];
  if (!experiment.runIds?.length || !evidenceRefs.length) return { score: "insufficient evidence", passed: false, evaluatorRefs: [...(definition?.evaluatorRefs ?? []), ...evidenceRefs] };
  const evaluatorRefs = [...(definition?.evaluatorRefs ?? []), ...evidenceRefs];
  if (experiment.key === "H1") return { score: experiment.hiddenCriteria?.length ? `${Math.round(evaluation.metrics.initiativeRecall * 100)}% recall` : "insufficient ground truth", passed: Boolean(experiment.hiddenCriteria?.length) && evaluation.metrics.initiativeRecall > 0, evaluatorRefs };
  if (experiment.key === "H3") return { score: `${Math.round(evaluation.metrics.questionPrecision * 100)}% precision`, passed: evaluation.metrics.questionPrecision >= 0.5, evaluatorRefs };
  if (experiment.key === "H5") return { score: `${Math.round(evaluation.metrics.costNormalizedUtility * 100)}% utility`, passed: evaluation.metrics.outcomeQuality > 0 && evaluation.metrics.reworkRate < 1, evaluatorRefs };
  return { score: `${Math.round(evaluation.metrics.outcomeQuality * 100)}% utility`, passed: evaluation.metrics.outcomeQuality > 0, evaluatorRefs };
}
