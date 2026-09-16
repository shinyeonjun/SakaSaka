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

function meaningfulTokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((token) => !["the", "and", "with", "for", "from", "that", "this"].includes(token));
}

function criterionObserved(state: AppState, projectId: string, criterion: string): boolean {
  const normalized = criterion.toLocaleLowerCase();
  const evidence = state.evidence.filter((item) => item.projectId === projectId);
  const events = state.events.filter((event) => event.projectId === projectId);
  const humanItems = state.humanItems.filter((item) => item.projectId === projectId);
  if (/browser|e2e|playwright|dom/.test(normalized)) return evidence.some((item) => item.projectId === projectId && item.verdict === "PASS" && (item.kind === "browser" || item.kind === "screenshot"));
  if (/test|build|regression|quality/.test(normalized)) return evidence.some((item) => item.verdict === "PASS" && item.kind === "test");
  if (/human|question|preference|decision/.test(normalized)) return humanItems.some((item) => item.kind === "QUESTION" && ["ANSWERED", "OPEN", "DEFERRED"].includes(item.status));
  if (/risk|security|dependency|permission|operational/.test(normalized)) return evidence.some((item) => /risk|security|dependency|permission|operational/i.test(`${item.summary} ${item.source}`)) || humanItems.some((item) => (item.kind === "CONCERN" || item.kind === "APPROVAL") && item.evidenceRefs.length > 0);
  if (/stop|equilibrium|wake|continuity|lease/.test(normalized)) return events.some((event) => ["EQUILIBRIUM_ENTERED", "WAKE_TRIGGERED", "RUN_STATE_CHANGED"].includes(event.type));
  const required = meaningfulTokens(criterion);
  if (!required.length) return false;
  const corpus = [...evidence.map((item) => `${item.summary} ${item.source}`), ...events.map((event) => `${event.summary} ${event.detail ?? ""}`), ...humanItems.map((item) => `${item.title} ${item.summary}`)].join(" ").toLocaleLowerCase();
  return required.every((token) => corpus.includes(token));
}

function initiativeMetrics(state: AppState, projectId: string, groundTruth: string[]): { recall: number; precision: number } {
  if (!groundTruth.length) return { recall: 0, precision: 0 };
  const discovered = groundTruth.filter((criterion) => criterionObserved(state, projectId, criterion)).length;
  const actions = state.actions.filter((action) => action.projectId === projectId);
  const evidenceById = new Map(state.evidence.filter((item) => item.projectId === projectId).map((item) => [item.id, item]));
  const discoveryActionIds = new Set(actions.filter((action) => action.type === "IDEA" || action.type === "CONCERN").map((action) => action.id));
  for (const event of state.events.filter((event) => event.projectId === projectId && event.type === "GAP_FOUND")) if (event.actionId) discoveryActionIds.add(event.actionId);
  const useful = [...discoveryActionIds].filter((actionId) => {
    const action = actions.find((candidate) => candidate.id === actionId);
    const pass = state.evidence.some((item) => item.actionId === actionId && item.verdict === "PASS");
    const item = state.humanItems.find((candidate) => candidate.actionRef === actionId);
    return pass || item?.evidenceRefs.some((ref) => evidenceById.get(ref)?.verdict === "PASS") || action?.status === "VERIFIED";
  }).length;
  return { recall: ratio(discovered, groundTruth.length), precision: ratio(useful, discoveryActionIds.size) };
}

function observedTestCounts(state: AppState, projectId: string): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const item of state.evidence.filter((candidate) => candidate.projectId === projectId && candidate.kind === "test")) {
    const pair = item.summary.match(/(\d+)\s*\/\s*(\d+)/);
    const named = item.summary.match(/(\d+)\s+(?:tests?|specs?)\s+(?:passed|pass)/i);
    if (pair) { passed = Math.max(passed, Number(pair[1])); total = Math.max(total, Number(pair[2])); }
    else if (named) { passed = Math.max(passed, Number(named[1])); total = Math.max(total, Number(named[1])); }
  }
  return { passed, total };
}

export function evaluateProject(state: AppState, projectId: string, groundTruth: string[] = []): ProjectEvaluation {
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
  const cost = project?.budgetSpent ?? 0;
  const outcomeQuality = ratio(passedEvidence.length, evidence.length);
  const testCounts = observedTestCounts(state, projectId);
  const failureEvents = events.filter((event) => event.type === "RUNTIME_ERROR");
  const uniqueFailureSignatures = new Set(failureEvents.map((event) => (event.detail ?? event.summary).toLowerCase().replace(/\d+/g, "#").slice(0, 180)));
  const equilibriumEvents = events.filter((event) => event.type === "EQUILIBRIUM_ENTERED");
  const lastAction = actions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))[0];
  const initiative = initiativeMetrics(state, projectId, groundTruth);
  const metrics: EvaluationMetrics = {
    testsPassed: testCounts.passed,
    testsTotal: testCounts.total,
    evidenceCoverage: clamp(actions.length ? linkedActionIds.size / actions.length : evidence.length ? outcomeQuality : 0),
    humanOrchestrationCount: events.filter((event) => event.type === "HUMAN_ANSWERED" || event.type === "HUMAN_APPROVED" || event.type === "HUMAN_REJECTED" || event.type === "HUMAN_DEFERRED").length,
    initiativeRecall: initiative.recall,
    initiativePrecision: initiative.precision,
    outcomeQuality,
    questionPrecision: ratio(questionWithProvenance.length, questions.length),
    reworkRate: ratio(Math.max(0, failureEvents.length - uniqueFailureSignatures.size), Math.max(1, failureEvents.length)),
    costNormalizedUtility: clamp(cost > 0 ? outcomeQuality / cost : 0),
    stopQuality: project?.status === "EQUILIBRIUM" && equilibriumEvents.length > 0 && lastAction?.type === "WAIT" ? 1 : 0,
  };

  const refs = (predicate: (id: string) => boolean): string[] => evidence.filter((item) => predicate(item.id)).map((item) => item.id);
  const gates: AcceptanceGateResult[] = [
    { key: "A", title: "Greenfield", passed: actions.some((action) => action.type === "ACT") && passedEvidence.length > 0, evidenceRefs: passedEvidence.map((item) => item.id), reason: "실제 action과 PASS evidence가 함께 있어야 합니다." },
    { key: "B", title: "Hidden Work", passed: events.some((event) => event.type === "GAP_FOUND" && (event.evidenceIds?.length ?? 0) > 0) || humanItems.some((item) => (item.kind === "IDEA" || item.kind === "CONCERN") && item.evidenceRefs.length > 0), evidenceRefs: refs((id) => id.length > 0), reason: "실제 evidence에 연결된 gap discovery 또는 위험/기회 signal이 기록되어야 합니다." },
    { key: "C", title: "Async Human", passed: humanItems.some((item) => item.kind === "QUESTION") && metrics.humanOrchestrationCount <= 2, evidenceRefs: questions.flatMap((item) => item.evidenceRefs), reason: "질문은 human-only decision으로 남기고 workflow scheduler가 되지 않아야 합니다." },
    { key: "D", title: "Stop", passed: metrics.stopQuality === 1, evidenceRefs: events.filter((event) => event.type === "EQUILIBRIUM_ENTERED").map((event) => event.id), reason: "가치가 낮아졌을 때 EQUILIBRIUM과 wake 근거를 남겨야 합니다." },
    { key: "E", title: "Maintenance", passed: events.some((event) => event.type === "OBSERVATION_REFRESHED") && evidence.length > 0, evidenceRefs: evidence.map((item) => item.id), reason: "재관찰과 regression evidence가 필요합니다." },
    { key: "F", title: "Experience", passed: experiences.length >= 2 && metrics.outcomeQuality > 0, evidenceRefs: experiences.flatMap((experience) => experience.evidenceIds), reason: "반복 run에서 provenance가 있는 experience가 축적되어야 합니다." },
    { key: "G", title: "Boundary", passed: events.some((event) => event.type === "TOOL_RESULT" && event.summary.includes("BLOCKED")), evidenceRefs: events.filter((event) => event.type === "TOOL_RESULT" && event.summary.includes("BLOCKED")).map((event) => event.id), reason: "실제 boundary decision이 approval 또는 hard deny로 기록되어야 합니다." },
    { key: "H", title: "Model Swap", passed: actions.every((action) => Boolean(action.contextId)) && actions.length > 0, evidenceRefs: actions.map((action) => action.id), reason: "memory/world/event가 model version과 독립적으로 연결되어야 합니다." },
  ];
  const verdict: Verdict = gates.filter((gate) => gate.passed).length >= 4 && metrics.outcomeQuality > 0 ? "PASS" : gates.some((gate) => gate.passed) ? "UNCERTAIN" : "FAIL";
  return { projectId, metrics, gates, verdict };
}
