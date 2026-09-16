import { worldSourceKeys } from "./types";
import type {
  ActionType,
  AgentAction,
  AppState,
  Artifact,
  ContextPacket,
  EventActor,
  EventRecord,
  EventType,
  Experiment,
  Experience,
  Evidence,
  HumanItem,
  Intent,
  Observation,
  Policy,
  Relation,
  ResourceLedger,
  RetrievalIndexEntry,
  Project,
  Run,
  WorldSnapshot,
  WorldSource,
  WorldSourceKey,
} from "./types";

const time = (minutes: number) => `2026-09-16T14:${String(minutes).padStart(2, "0")}:00+09:00`;

const projectId = "project-trip-together";
const intentId = "intent-trip-together";
const runId = "run-trip-together-001";
let seedEventSequence = 0;

function event(
  id: string,
  type: EventType,
  summary: string,
  createdAt: string,
  options: Partial<Pick<EventRecord, "actor" | "detail" | "actionId" | "evidenceIds" | "payload">> = {},
): EventRecord {
  return {
    id,
    sequence: seedEventSequence++,
    projectId,
    type,
    actor: options.actor ?? "agent",
    summary,
    createdAt,
    schemaVersion: 1,
    modelVersion: "local-deterministic-0.1",
    toolVersion: "local-tool-gateway-0.1",
    policyVersion: 1,
    ...options,
  };
}

const sources: Record<WorldSourceKey, WorldSource> = {
  repo: {
    key: "repo",
    label: "Repo",
    status: "healthy",
    summary: "clean · +2 files",
    observedAt: time(35),
    freshness: "fresh",
    trustLevel: "verified",
    relatedEntities: ["artifact-preview", "commit-812"],
  },
  runtime: {
    key: "runtime",
    label: "Runtime",
    status: "healthy",
    summary: "Preview environment · healthy",
    observedAt: time(35),
    freshness: "fresh",
    trustLevel: "observed",
    relatedEntities: ["run-trip-together-001"],
  },
  browser: {
    key: "browser",
    label: "Browser",
    status: "healthy",
    summary: "mobile verified",
    observedAt: time(34),
    freshness: "fresh",
    trustLevel: "verified",
    relatedEntities: ["evidence-814", "evidence-815"],
  },
  db: {
    key: "db",
    label: "DB",
    status: "healthy",
    summary: "healthy",
    observedAt: time(33),
    freshness: "fresh",
    trustLevel: "verified",
    relatedEntities: ["migration-dry-run"],
  },
  logs: {
    key: "logs",
    label: "Logs",
    status: "healthy",
    summary: "0 critical errors",
    observedAt: time(35),
    freshness: "fresh",
    trustLevel: "observed",
    relatedEntities: ["incident-none"],
  },
  human: {
    key: "human",
    label: "Human",
    status: "warning",
    summary: "Q-17 unanswered",
    observedAt: time(35),
    freshness: "fresh",
    trustLevel: "verified",
    relatedEntities: ["Q-17"],
  },
};

const intent: Intent = {
  id: intentId,
  projectId,
  rawText: "친구들이 여행 계획을 쉽게 같이 만들고 실제 여행에서도 쓸 수 있는 제품",
  constraints: [
    "로컬·샌드박스 안에서는 자유롭게 행동",
    "외부 배포 · 결제 · 파괴적 작업은 승인 필요",
  ],
  version: 1,
  createdAt: time(20),
};

const project: Project = {
  id: projectId,
  name: "TripTogether",
  subtitle: "친구들과 여행 계획을 함께 만드는 서비스",
  status: "ACTIVE",
  intentId,
  activeRunId: runId,
  currentActionId: "action-812",
  createdAt: time(20),
  updatedAt: time(35),
  budgetSpent: 8.42,
  settings: {
    budgetLimit: 30,
    maxHours: 12,
    localActions: true,
    requireExternalApproval: true,
    productionBlocked: true,
    networkPolicy: "allowlist",
  },
  metrics: {
    testsPassed: 42,
    testsTotal: 42,
    evidenceCoverage: 0.92,
    humanOrchestrationCount: 0,
    initiativeRecall: 0.71,
    initiativePrecision: 0.86,
  },
};

const run: Run = {
  id: runId,
  projectId,
  status: "ACTIVE",
  phase: "verify",
  cycleCount: 5,
  startedAt: time(20),
  lastCycleAt: time(35),
  leaseExpiresAt: "2026-09-17T02:20:00+09:00",
};

const action: AgentAction = {
  id: "action-812",
  projectId,
  runId,
  schemaVersion: 1,
  type: "ACT" as ActionType,
  intentRef: intentId,
  worldCursor: "event-816",
  rationaleSummary: "모바일 초대 흐름의 실제 overflow를 닫고 브라우저 evidence를 확보",
  tool: "playwright",
  params: { viewport: "390x844", route: "/invite" },
  expectedValue: 0.88,
  riskClass: "P1",
  evidencePlan: ["browser", "screenshot", "test"],
  status: "VERIFIED",
  cost: 0.38,
  modelVersion: "local-deterministic-0.1",
  toolVersion: "local-tool-gateway-0.1",
  policyVersion: 1,
  createdAt: time(33),
  completedAt: time(34),
};

const humanItems: HumanItem[] = [
  {
    id: "Q-17",
    projectId,
    kind: "QUESTION",
    status: "OPEN",
    title: "초대받은 사람도 다른 사용자를 초대할 수 있나요?",
    summary: "기술적으로 둘 다 가능하지만 제품의 권한 철학을 결정할 정보가 없습니다.",
    detailSummary: "기술적으로는 양쪽 모두 가능합니다. 그러나 이 선택은 “누가 커뮤니티를 확장할 수 있는가”라는 제품 권한 철학을 바꾸므로 인간의 의도가 필요합니다.",
    rationale: "초대 흐름을 E2E 검증하면서 권한 정책이 비어 있음을 발견했습니다. AI가 임의로 정하면 제품 가치가 바뀔 수 있어 Question으로 승격했습니다.",
    blockingScope: ["invite-permissions"],
    continuingScope: ["일정 편집", "알림", "QA", "모바일 수정"],
    options: [
      { id: "A", title: "초대받은 사람도 초대 가능", description: "협업 확산이 빠르지만 권한이 넓어짐" },
      { id: "B", title: "여행 생성자만 초대 가능", description: "권한이 단순하고 통제가 쉬움" },
      { id: "C", title: "역할별로 설정 가능", description: "유연하지만 UX와 구현 복잡도 증가" },
    ],
    priority: "high",
    createdAt: time(35),
    updatedAt: time(35),
    evidenceRefs: ["evidence-815"],
  },
  {
    id: "IDEA-21",
    projectId,
    kind: "IDEA",
    status: "OPEN",
    title: "일정 사이 이동시간을 자동 계산하면 어떨까요?",
    summary: "테스트 사용자 흐름에서 장소를 입력한 뒤 지도 서비스로 이동해 시간을 확인하는 행동이 반복되었습니다.",
    rationale: "예상 가치: 높음 · 예상 구현비용: 중간 · 제품 방향 변경 가능성이 있어 제안으로 올림",
    blockingScope: [],
    continuingScope: ["일정 편집", "알림", "초대 흐름"],
    options: [],
    priority: "medium",
    createdAt: time(31),
    updatedAt: time(31),
    evidenceRefs: ["evidence-811"],
  },
  {
    id: "IDEA-18",
    projectId,
    kind: "IDEA",
    status: "OPEN",
    title: "여행 템플릿을 공유할 수 있으면 어떨까요?",
    summary: "반복되는 여행 패턴을 재사용하면 시작 시간이 줄어들 수 있습니다.",
    rationale: "현재는 사용자 evidence가 부족해 바로 구현하지 않고, 다음 인터뷰 신호를 기다립니다.",
    blockingScope: [],
    continuingScope: ["전체 제품"],
    options: [],
    priority: "low",
    createdAt: time(30),
    updatedAt: time(30),
    evidenceRefs: [],
  },
  {
    id: "CONCERN-04",
    projectId,
    kind: "CONCERN",
    status: "OPEN",
    title: "모바일 초대 모달의 안전 영역을 계속 관찰해야 합니다.",
    summary: "390px에서 overflow는 수정됐지만 다양한 키보드 높이 조합은 아직 확인하지 않았습니다.",
    rationale: "현재 실패는 아니지만 재발 가능성이 있어 evidence gap으로 기록합니다.",
    blockingScope: [],
    continuingScope: ["모바일 QA"],
    options: [],
    priority: "medium",
    createdAt: time(34),
    updatedAt: time(34),
    evidenceRefs: ["evidence-814"],
  },
  {
    id: "APPROVAL-12",
    projectId,
    kind: "APPROVAL",
    status: "OPEN",
    title: "Preview → Production 배포",
    summary: "Acceptance check 통과. 실제 외부 사용자에게 영향을 주는 배포이므로 승인 필요.",
    rationale: "production은 되돌리기 어려운 외부 side effect이므로 P3 경계에 걸립니다.",
    blockingScope: ["production-deploy"],
    continuingScope: ["preview", "문서", "회귀 테스트"],
    options: [],
    priority: "high",
    createdAt: time(35),
    updatedAt: time(35),
    evidenceRefs: ["evidence-815"],
  },
];

const evidence: Evidence[] = [
  { id: "evidence-811", projectId, kind: "world", verdict: "PASS", summary: "장소 입력 후 외부 지도 이동 패턴 관찰", source: "browser observation", createdAt: time(31) },
  { id: "evidence-812", projectId, kind: "test", verdict: "PASS", summary: "API E2E 42/42", source: "playwright:test", createdAt: time(32) },
  { id: "evidence-813", projectId, kind: "test", verdict: "PASS", summary: "Chrome desktop flow", source: "playwright:desktop", createdAt: time(33) },
  { id: "evidence-814", projectId, kind: "browser", verdict: "PASS", summary: "390px / 430px 재실행", source: "playwright:mobile", createdAt: time(34), actionId: action.id },
  { id: "evidence-815", projectId, kind: "screenshot", verdict: "PASS", summary: "초대 모달 safe-area screenshot", source: "artifact:screenshot", createdAt: time(34), actionId: action.id },
  { id: "evidence-816", projectId, kind: "world", verdict: "PASS", summary: "World Snapshot cursor updated", source: "world:adapter", createdAt: time(35), actionId: action.id },
];

const artifacts: Artifact[] = [
  { id: "artifact-preview", projectId, kind: "build", name: "Preview build · trip-together", status: "ready", description: "현재 배포 후보 빌드와 런타임 health 결과", updatedAt: time(35), sourceRef: "build:preview-042", sizeLabel: "18.4 MB" },
  { id: "artifact-e2e", projectId, kind: "report", name: "E2E acceptance report", status: "ready", description: "API 42/42 · Chrome desktop · mobile invite flow", updatedAt: time(34), sourceRef: "evidence-812", sizeLabel: "84 KB" },
  { id: "artifact-screenshot", projectId, kind: "screenshot", name: "invite-modal-mobile.png", status: "ready", description: "390px viewport에서 수정된 초대 모달 캡처", updatedAt: time(34), sourceRef: "evidence-815", sizeLabel: "1.2 MB" },
  { id: "artifact-release", projectId, kind: "release", name: "Production release candidate", status: "in-review", description: "Human approval 전까지 production side effect는 차단됨", updatedAt: time(35), sourceRef: "APPROVAL-12", sizeLabel: "—" },
  { id: "artifact-spec", projectId, kind: "docs", name: "Intent World implementation spec", status: "ready", description: "runtime contract · boundary · acceptance gates", updatedAt: time(29), sourceRef: "figma:architecture", sizeLabel: "212 KB" },
];

const experiences: Experience[] = [
  {
    id: "experience-mobile-overflow",
    projectId,
    situation: "초대 flow는 desktop에서 통과했지만 390px에서 모달이 viewport 밖으로 넘침",
    decision: "기존 task를 더 쪼개기보다 browser observation을 fresh하게 재실행",
    action: "Playwright mobile viewport → CSS layout 수정 → 390/430px 재검증",
    outcome: "모바일 overflow 해소 · evidence coverage 증가 · 질문 범위는 invite permission만 유지",
    evidenceIds: ["evidence-814", "evidence-815", "evidence-816"],
    cost: 0.38,
    risk: "P1",
    humanIntervention: false,
    createdAt: time(35),
  },
];

const experiments: Experiment[] = [
  { id: "exp-h1", projectId, key: "H1", title: "Initiative", hypothesis: "Intent + World만으로 명시되지 않은 필수 작업을 스스로 발견하는가?", description: "hidden-work seed에서 필요한 UX·권한·운영 문제의 발견률을 비교합니다.", variant: "closed-loop", status: "running", score: "71% recall", updatedAt: time(34), benchmark: "hidden-work-ux", budgetLimit: 8, hiddenCriteria: ["mobile UX", "permission ambiguity", "operational readiness"], evaluatorRefs: ["initiative-recall", "initiative-precision"] },
  { id: "exp-h2", projectId, key: "H2", title: "Closed loop", hypothesis: "Observe → Act → Verify가 Prompt → Response보다 복합 프로젝트 성과를 높이는가?", description: "동일 모델·도구·budget에서 실행 루프만 비교합니다.", variant: "observe-act-verify", status: "passed", score: "0.86 utility", updatedAt: time(32), benchmark: "greenfield-travel", budgetLimit: 8, hiddenCriteria: ["working app", "core E2E", "browser evidence"], evaluatorRefs: ["outcome-quality", "evidence-coverage"] },
  { id: "exp-h3", projectId, key: "H3", title: "Discovery", hypothesis: "Information Gain을 고려하면 숨은 위험·요구·기회 발견이 증가하는가?", description: "Discovery force를 제거한 baseline과 precision을 비교합니다.", variant: "discovery-aware", status: "ready", score: "—", updatedAt: time(29), benchmark: "hidden-work-ux", budgetLimit: 8, hiddenCriteria: ["hidden work", "human-only question"], evaluatorRefs: ["question-precision", "hidden-work-recall"] },
  { id: "exp-h4", projectId, key: "H4", title: "Role emergence", hypothesis: "PM·QA·Designer·Architect 역할을 고정하지 않아도 기능이 나타나는가?", description: "명시적 role prompt 없이 결과와 evidence lineage를 분석합니다.", variant: "role-free", status: "ready", score: "—", updatedAt: time(29), benchmark: "greenfield-travel", budgetLimit: 8, hiddenCriteria: ["cross-functional evidence", "no fixed roles"], evaluatorRefs: ["outcome-quality", "human-orchestration-count"] },
  { id: "exp-h5", projectId, key: "H5", title: "Experience memory", hypothesis: "상태→행동→결과 기억으로 반복 삽질과 인간 개입이 감소하는가?", description: "동일 failure family를 반복해 rework와 tool calls를 비교합니다.", variant: "experience-retrieval", status: "needs-review", score: "human count 0", updatedAt: time(33), benchmark: "maintenance-hidden-bug", budgetLimit: 10, hiddenCriteria: ["repeat failure family", "quality maintained"], evaluatorRefs: ["rework-rate", "cost-normalized-utility"] },
  { id: "exp-h6", projectId, key: "H6", title: "Meta improvement", hypothesis: "정책 평가·개선이 동일 모델의 effective intelligence를 높이는가?", description: "RSI는 필요성이 증명된 뒤 sandbox에서만 열어 둡니다.", variant: "policy-candidate", status: "ready", score: "not started", updatedAt: time(28), benchmark: "long-horizon-continuity", budgetLimit: 10, hiddenCriteria: ["replayable policy", "independent evidence", "rollback"], evaluatorRefs: ["stop-quality", "outcome-quality"] },
];

const events: EventRecord[] = [
  event("event-801", "PROJECT_CREATED", "TripTogether 프로젝트 생성", time(20), { actor: "human", detail: "workspace를 연결하고 기본 boundary를 설정" }),
  event("event-802", "INTENT_CREATED", "원문 Intent 보존", time(20), { actor: "human", detail: intent.rawText }),
  event("event-808", "WAKE_TRIGGERED", "새 Intent에서 runtime wake", time(30), { detail: "lease와 budget을 확인하고 world cursor를 고정" }),
  event("event-809", "OBSERVE", "Playwright mobile viewport 관찰", time(31), { detail: "390px에서 초대 모달 overflow 발견" }),
  event("event-810", "CONTEXT_ASSEMBLED", "fresh world + intent + open human items 조합", time(31), { detail: "summary는 source of truth가 아니며 관찰 ref를 함께 전달" }),
  event("event-811", "MODEL_TURN", "현재 gap에 대한 행동 후보 생성", time(32), { detail: "ACT: CSS layout 수정 · QUESTION: 초대 권한 정책" }),
  event("event-812", "ACTION_SELECTED", "CSS layout 수정 선택", time(32), { actionId: action.id, detail: action.rationaleSummary }),
  event("event-813", "ACTION_EXECUTED", "Playwright mobile flow 실행", time(33), { actionId: action.id, detail: "sandbox P1 local reversible action" }),
  event("event-814", "VERIFY", "390px/430px 재실행 · PASS", time(34), { actionId: action.id, evidenceIds: ["evidence-814", "evidence-815"] }),
  event("event-815", "EVIDENCE_RECORDED", "screenshot + browser evidence 연결", time(34), { actionId: action.id, evidenceIds: ["evidence-815"] }),
  event("event-816", "WORLD_CHANGED", "repo +2 files · browser mobile verified", time(35), { actionId: action.id, evidenceIds: ["evidence-816"] }),
  event("event-817", "HUMAN_ITEM_CREATED", "Question Q-17 · 제품 판단 필요", time(35), { actor: "agent", detail: humanItems[0].title }),
  event("event-818", "HUMAN_ITEM_CREATED", "Idea IDEA-21 · 이동시간 자동 계산", time(31), { actor: "agent", detail: humanItems[1].summary }),
  event("event-819", "HUMAN_ITEM_CREATED", "Approval APPROVAL-12 · Preview → Production", time(35), { actor: "agent", detail: "P3 external side effect" }),
  event("event-820", "ARTIFACT_CREATED", "E2E acceptance report ready", time(34), { evidenceIds: ["evidence-812", "evidence-813"] }),
];

const worldSnapshot: WorldSnapshot = {
  id: "world-816",
  projectId,
  cursorEventId: "event-816",
  observedAt: time(35),
  summary: "Preview environment is healthy. Mobile invite issue was fixed and evidence is linked. Human decisions remain scoped to permissions and production deployment.",
  sources,
};

const observations: Observation[] = worldSourceKeys.map((key) => ({
  id: `observation-816-${key}`,
  projectId,
  source: key,
  status: sources[key].status,
  observedAt: sources[key].observedAt,
  freshness: sources[key].freshness,
  rawRef: `world://world-816/${key}`,
  compactView: sources[key].summary,
  trustLevel: sources[key].trustLevel,
  confidence: sources[key].trustLevel === "verified" ? 0.98 : sources[key].trustLevel === "observed" ? 0.82 : 0.4,
  relatedEntities: sources[key].relatedEntities,
}));

const policies: Policy[] = [{
  id: "policy-default-v1",
  projectId,
  version: 1,
  representation: "hard constraints → risk → required gap → information gain → opportunity → WAIT",
  status: "active",
  evalRefs: ["exp-h1", "exp-h2"],
  createdAt: time(20),
}];

const resourceLedger: ResourceLedger[] = [{
  id: "ledger-run-trip-together-001",
  projectId,
  runId,
  tokens: 12480,
  modelCost: 8.04,
  wallTimeMs: 432000,
  toolCalls: 18,
  sandboxSeconds: 2400,
  budgetLimit: 30,
  updatedAt: time(35),
}];

const relations: Relation[] = [
  { id: "relation-001", projectId, fromId: intentId, relationType: "supports", toId: "action-812", createdAt: time(32) },
  { id: "relation-002", projectId, fromId: "action-812", relationType: "verified-by", toId: "evidence-814", createdAt: time(34) },
  { id: "relation-003", projectId, fromId: "action-812", relationType: "verified-by", toId: "evidence-815", createdAt: time(34) },
  { id: "relation-004", projectId, fromId: "Q-17", relationType: "blocked-by", toId: "evidence-815", createdAt: time(35) },
  { id: "relation-005", projectId, fromId: "artifact-e2e", relationType: "supports", toId: "evidence-812", createdAt: time(34) },
  { id: "relation-006", projectId, fromId: "IDEA-21", relationType: "derived-from", toId: "evidence-811", createdAt: time(31) },
];

const retrievalIndex: RetrievalIndexEntry[] = [{
  id: "retrieval-mobile-overflow",
  projectId,
  entityId: "experience-mobile-overflow",
  sourceRef: "experience-mobile-overflow",
  metadata: { failureFamily: "responsive-layout", actionType: "ACT", verdict: "PASS" },
  recency: 0.94,
  outcomeQuality: 0.91,
  createdAt: time(35),
}];

const contexts: ContextPacket[] = [{
  id: "context-816",
  projectId,
  intentRef: intentId,
  worldCursor: "event-816",
  rawIntent: intent.rawText,
  constraints: [...intent.constraints],
  observationRefs: observations.map((observation) => observation.id),
  openHumanItemRefs: humanItems.filter((item) => item.status === "OPEN").map((item) => item.id),
  experienceRefs: experiences.map((experience) => experience.id),
  boundary: {
    remainingBudget: 21.58,
    maxHours: 12,
    networkPolicy: "allowlist",
    productionBlocked: true,
    openApprovalRefs: ["APPROVAL-12"],
  },
  toolSurface: [
    { name: "repo.read", description: "git diff와 dependency/config를 읽습니다.", riskClass: "P0", reversible: true, requiresNetwork: false, sideEffect: false, enabled: true, toolVersion: "local-tool-gateway-0.1" },
    { name: "shell.sandbox", description: "격리 workspace에서 명령을 실행합니다.", riskClass: "P1", reversible: true, requiresNetwork: false, sideEffect: true, enabled: true, toolVersion: "local-tool-gateway-0.1" },
    { name: "browser.playwright", description: "브라우저와 DOM을 관찰·검증합니다.", riskClass: "P1", reversible: true, requiresNetwork: true, sideEffect: false, enabled: true, toolVersion: "local-tool-gateway-0.1" },
    { name: "deploy.production", description: "production side effect를 실행합니다.", riskClass: "P3", reversible: false, requiresNetwork: true, sideEffect: true, enabled: false, toolVersion: "local-tool-gateway-0.1" },
  ],
  assembledAt: time(35),
  schemaVersion: 1,
  modelVersion: "local-deterministic-0.1",
  policyVersion: 1,
  runId,
  observationViews: observations.map((observation) => ({ ...observation, relatedEntities: [...observation.relatedEntities] })),
  openHumanItemViews: humanItems.filter((item) => item.status === "OPEN").map((item) => ({ id: item.id, kind: item.kind, status: item.status, title: item.title, summary: item.summary, blockingScope: [...item.blockingScope], continuingScope: [...item.continuingScope] })),
  relevantExperienceViews: experiences.map((experience) => ({ id: experience.id, situation: experience.situation, decision: experience.decision, action: experience.action, outcome: experience.outcome, evidenceIds: [...experience.evidenceIds], risk: experience.risk, createdAt: experience.createdAt })),
}];

export function createSeedState(): AppState {
  const state: AppState = {
    schemaVersion: 1,
    activeProjectId: projectId,
    projects: [project],
    intents: [intent],
    runs: [run],
    actions: [action],
    worldSnapshots: [worldSnapshot],
    observations,
    contexts,
    events,
    evidence,
    humanItems,
    artifacts,
    experiences,
    policies,
    resourceLedger,
    relations,
    retrievalIndex,
    experiments,
  };
  // The seed is used both as a browser fallback and as the API bootstrap. A
  // fresh deep copy prevents one optimistic reducer or test from mutating the
  // canonical fixture shared by later sessions.
  return typeof globalThis.structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state)) as AppState;
}
