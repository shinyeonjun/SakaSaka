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
  { id: "greenfield-web", category: "greenfield", title: "그린필드 웹 애플리케이션", intent: "사용자가 브라우저에서 실제로 사용할 수 있는 제품", hiddenCriteria: ["working app", "core E2E", "browser evidence", "human task orchestration 0"], acceptanceRefs: ["A", "C"] },
  { id: "maintenance-hidden-bug", category: "maintenance", title: "숨은 버그·의존성·성능·보안", intent: "기존 제품을 안정적으로 유지하고 보이지 않는 회귀를 줄여줘", hiddenCriteria: ["reproduce bug", "dependency risk", "performance regression", "security evidence"], acceptanceRefs: ["B", "E", "G"] },
  { id: "hidden-work-ux", category: "hidden-work", title: "UX·권한·운영 준비", intent: "사용자가 실제로 신뢰할 수 있는 제품 상태를 만들어줘", hiddenCriteria: ["mobile UX", "permission ambiguity", "operational readiness"], acceptanceRefs: ["B", "C", "G"] },
  { id: "long-horizon-continuity", category: "long-horizon", title: "장시간 연속성·정지", intent: "신호가 들어오면 다시 깨어나고 가치가 낮아지면 멈추는 지속 실행", hiddenCriteria: ["lease renewal", "memory continuity", "equilibrium stop", "signal wake"], acceptanceRefs: ["D", "F", "H"] },
];

export const hypothesisCatalog: HypothesisDefinition[] = [
  { key: "H1", title: "자발적 발견", statement: "의도와 월드만으로 명시되지 않은 필수 작업을 스스로 발견하는가?", evaluatorRefs: ["initiative-recall", "initiative-precision"] },
  { key: "H2", title: "폐쇄 루프", statement: "관찰 → 실행 → 검증이 프롬프트 → 응답보다 복합 프로젝트 성과를 높이는가?", evaluatorRefs: ["outcome-quality", "evidence-coverage"] },
  { key: "H3", title: "탐색", statement: "정보 이득을 고려하면 숨은 위험·요구·기회 발견이 증가하는가?", evaluatorRefs: ["question-precision", "hidden-work-recall"] },
  { key: "H4", title: "역할의 출현", statement: "PM·QA·디자이너·아키텍트 역할을 고정하지 않아도 기능이 나타나는가?", evaluatorRefs: ["outcome-quality", "human-orchestration-count"] },
  { key: "H5", title: "경험 기억", statement: "상태→행동→결과 기억으로 반복 삽질과 인간 개입이 감소하는가?", evaluatorRefs: ["rework-rate", "cost-normalized-utility"] },
  { key: "H6", title: "메타 개선", statement: "정책 평가·개선이 동일 모델의 실질 지능을 높이는가?", evaluatorRefs: ["stop-quality", "outcome-quality"] },
];

export const ablationLadder = [
  { key: "A", title: "기존 작업형 에이전트", detail: "명시 작업 → 완료" },
  { key: "B", title: "+ 지속형 폐쇄 루프", detail: "의도 + 월드 + 행동" },
  { key: "C", title: "+ 발견·불확실성", detail: "숨은 공백 탐색" },
  { key: "D", title: "+ 경험 기억", detail: "전이 기억" },
  { key: "E", title: "+ 메타 개선", detail: "정책 갱신" },
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
